import { MAX_STARS, type SyncPhase } from "@starwatch/domain";
import { diffStars, GithubClient } from "@starwatch/core/sync";
import { RepoStore, UserFts } from "@starwatch/cloudflare/storage";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { SyncDeps, type SyncDepsService } from "../deps.ts";
import { StarRefreshWorkflow, type StarRefreshInput, type StarRefreshResult } from "./refresh-workflow.ts";
import { describeGithubError, nowIso, patchState } from "./state.ts";

/**
 * Tier 0 (listing): profile + public Lists + ETag-aware star pages → repo
 * metadata, per-user stars and the per-user FTS index (docs/08 §2.1,
 * docs/09 §1).
 *
 * Free-tier step math (per page step):
 *   * external subrequests: 1 `GET /users/{login}/starred`.
 *   * D1 queries: 1 ETag read + 1 `getReadmeTexts` + ≤4 bulk upsert statements
 *     (2 repos + 2 stars, JSON1) + ≤17 FTS upsert statements (2 deletes + 6
 *     porter + 5 trigram inserts + 2 `CREATE IF NOT EXISTS`) + 1 ETag write
 *     + 1 state write ≈ 25, inside the free 50/invocation ceiling.
 *
 * Step count for a 10,000-star account: profile + lists + 100 pages +
 * diff + ≤3 unstar chunks + finalize ≈ 107, inside the 1,024-step free
 * per-instance cap. Full semantic work is chained to
 * {@link StarRefreshWorkflow} with a per-day instance id.
 */

export interface StarListingInput {
  readonly login: string;
  readonly full?: boolean;
  readonly requestId?: string;
}

const PER_PAGE = 100;

const MAX_PAGES = Math.ceil(MAX_STARS / PER_PAGE);

/** Removed ids per cleanup task: 3,600 ÷ 90 rows/statement = 40 D1 queries. */
const UNSTAR_CHUNK = 3_600;

const chunk = <A>(items: ReadonlyArray<A>, size: number): ReadonlyArray<ReadonlyArray<A>> => {
  const out: Array<ReadonlyArray<A>> = [];

  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));

  return out;
};

type PageOutcome =
  | { readonly kind: "fresh"; readonly ids: ReadonlyArray<number>; readonly stop: boolean }
  | { readonly kind: "not-modified" }
  | { readonly kind: "error"; readonly message: string };

const makeListingBody = (
  deps: SyncDepsService,
  refresh: Cloudflare.WorkflowHandle<StarRefreshInput, StarRefreshResult>
) =>
  Effect.fn("StarListingWorkflow.body")(function* (input: StarListingInput) {
    const login = input.login;
    const repos = yield* RepoStore;
    const fts = yield* UserFts;
    const github = yield* GithubClient;

    // ---- profile -----------------------------------------------------------
    const profile = yield* Cloudflare.Workflows.task(
      "profile",
      Effect.gen(function* () {
        const fetched = yield* github.getUserProfile(login).pipe(
          Effect.matchEffect({
            onSuccess: (value) => Effect.succeed({ ok: true as const, value }),
            onFailure: (error) => Effect.succeed({ ok: false as const, message: describeGithubError(error) })
          })
        );

        if (!fetched.ok) {
          yield* patchState(login, { phase: "failed", lastError: fetched.message });

          return { ok: false as const, starsHint: 0 };
        }

        // Key the profile by the lowercased route login so `users.login`
        // matches every other table (docs/09 §7 case handling).
        yield* repos.upsertUser({ ...fetched.value, login }).pipe(Effect.orDie);
        const previous = yield* repos.getIndexState(login).pipe(Effect.orDie);
        yield* patchState(login, { phase: "listing", lastError: null });

        return { ok: true as const, starsHint: previous?.starsTotal ?? 0 };
      }),
      { retries: { limit: 3, delay: "5 seconds" } }
    );

    if (!profile.ok) {
      return { ok: false, reason: "profile" };
    }

    // ---- public Lists (optional enrichment; never fails the run) -----------
    yield* Cloudflare.Workflows.task(
      "lists",
      Effect.gen(function* () {
        const groups = yield* github.listGroups(login).pipe(
          Effect.matchEffect({
            onSuccess: (value) => Effect.succeed(value),
            onFailure: () => Effect.succeed([] as const)
          })
        );

        yield* repos.replaceGroups(login, groups).pipe(Effect.ignore);
      }),
      { retries: { limit: 1, delay: "5 seconds" } }
    );

    // ---- star pages --------------------------------------------------------
    const freshPages = new Map<number, ReadonlyArray<number>>();
    const notModifiedPages = new Set<number>();
    let listedCount = 0;
    let page = 1;

    while (page <= MAX_PAGES) {
      const pageNumber = page;
      const listedBefore = listedCount;

      const outcome: PageOutcome = yield* Cloudflare.Workflows.task(
        `star-page-${pageNumber}`,
        Effect.gen(function* () {
          const etag = yield* repos.starEtag(login, pageNumber).pipe(Effect.orDie);

          const fetched = yield* github
            .listStarPage(login, {
              page: pageNumber,
              perPage: PER_PAGE,
              etag: etag ?? undefined
            })
            .pipe(
              Effect.matchEffect({
                onSuccess: (value) => Effect.succeed({ ok: true as const, value }),
                onFailure: (error) => Effect.succeed({ ok: false as const, message: describeGithubError(error) })
              })
            );

          if (!fetched.ok) {
            return { kind: "error", message: fetched.message } satisfies PageOutcome;
          }

          const starPage = fetched.value;

          if (starPage.notModified) {
            // 304: the page is unchanged, so its stored repo ids remain the
            // authoritative listing for this page (migration 0002).
            return { kind: "not-modified" } satisfies PageOutcome;
          }

          if (starPage.repos.length > 0) {
            yield* repos.upsertRepoBatch(login, starPage.repos, pageNumber).pipe(Effect.orDie);
            // Preserve already-fetched README text in the FTS rows for this
            // page instead of resetting it to metadata-only.
            const pageIds = starPage.repos.map((repo) => repo.id);
            const readmes = yield* repos.getReadmeTexts(login, pageIds).pipe(Effect.orDie);
            yield* fts
              .upsertUserDocs(
                login,
                starPage.repos.map((repo) => ({
                  repoId: repo.id,
                  fullName: repo.fullName,
                  description: repo.description,
                  topics: repo.topics,
                  readme: readmes.get(repo.id) ?? ""
                }))
              )
              .pipe(Effect.orDie);
          }

          if (starPage.etag !== undefined) {
            yield* repos.putStarEtag(login, pageNumber, starPage.etag).pipe(Effect.orDie);
          }

          // Progress only grows: a re-list that starts with changed pages must
          // not show a count below the previously indexed total.
          const seen = Math.max(profile.starsHint, listedBefore + starPage.repos.length);
          yield* patchState(login, {
            phase: "listing",
            starsTotal: seen,
            reposMetadata: seen,
            lastError: null
          });

          const stop = starPage.repos.length < PER_PAGE || starPage.nextPage === undefined;

          return {
            kind: "fresh",
            ids: starPage.repos.map((repo) => repo.id),
            stop
          } satisfies PageOutcome;
        }),
        { retries: { limit: 3, delay: "5 seconds" } }
      );

      if (outcome.kind === "error") {
        yield* patchState(login, { phase: "paused", lastError: outcome.message });

        return { ok: false, reason: "github" };
      }

      if (outcome.kind === "not-modified") {
        notModifiedPages.add(pageNumber);
        page += 1;
        continue;
      }

      freshPages.set(pageNumber, outcome.ids);
      listedCount += outcome.ids.length;

      if (outcome.stop || listedCount >= MAX_STARS) break;
      page += 1;
    }

    // ---- diff: union fresh ids with the stored ids of unchanged pages ------
    const removed = yield* Cloudflare.Workflows.task(
      "diff",
      Effect.gen(function* () {
        const rows = yield* repos.getStarPageRows(login).pipe(Effect.orDie);
        const dbIds = yield* repos.listRepoIds(login).pipe(Effect.orDie);
        const listed = new Set<number>();

        for (const row of rows) {
          // Unattributed rows (pre-migration / non-paged writers) are kept.
          if (row.starPage === null || notModifiedPages.has(row.starPage)) listed.add(row.repoId);
        }

        for (const ids of freshPages.values()) {
          for (const id of ids) listed.add(id);
        }

        return diffStars(dbIds, [...listed]).removed;
      }),
      { retries: { limit: 2, delay: "5 seconds" } }
    );

    const removedChunks = chunk(removed, UNSTAR_CHUNK);

    for (let index = 0; index < removedChunks.length; index++) {
      yield* Cloudflare.Workflows.task(
        `unstar-${index}`,
        repos.markUnstarred(login, removedChunks[index] ?? []).pipe(Effect.orDie)
      );
    }

    // ---- finalize ----------------------------------------------------------
    const phase: SyncPhase = input.full === true ? "fetching-readmes" : "ready";
    yield* Cloudflare.Workflows.task(
      "finalize",
      Effect.gen(function* () {
        const stats = yield* repos.countStats(login).pipe(Effect.orDie);
        yield* patchState(login, {
          phase,
          starsTotal: stats.starsTotal,
          reposMetadata: stats.reposMetadata,
          readmesFetched: stats.readmesFetched,
          lastSyncedAt: nowIso(),
          lastError: null
        });
      }),
      { retries: { limit: 3, delay: "5 seconds" } }
    );

    // ---- chain Tier 1 (dedupes per user per UTC day) -----------------------
    if (input.full === true) {
      const day = new Date().toISOString().slice(0, 10);
      yield* Effect.exit(refresh.create({ id: `refresh-${login}-${day}`, params: { login } }));
    }

    return {
      ok: true,
      phase,
      listed: listedCount,
      removed: removed.length,
      pages: freshPages.size,
      notModified: notModifiedPages.size
    };
  });

export class StarListingWorkflow extends Cloudflare.Workflow<StarListingWorkflow>()(
  "StarListingWorkflow",
  // Free per-instance cap is 1,024 steps; observed worst case ≈ 107.
  { limits: { steps: 1_000 } },
  Effect.gen(function* () {
    const deps = yield* SyncDeps;
    // Capture the refresh handle once per isolate; the body only calls
    // `create`, so the workflow engine never re-registers the export.
    const refresh = yield* StarRefreshWorkflow;
    const body = makeListingBody(deps, refresh);

    return Effect.fn(function* (input: StarListingInput) {
      const exit = yield* Effect.exit(body(input).pipe(Effect.provide(deps.runLayers)));

      if (Exit.isSuccess(exit)) return exit.value;
      yield* patchState(input.login, { phase: "failed", lastError: "listing failed" }).pipe(
        Effect.provide(deps.runLayers),
        Effect.ignore
      );

      return { ok: false, reason: "internal" };
    });
  })
) {}
