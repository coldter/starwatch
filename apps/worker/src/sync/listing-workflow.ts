import { isActiveSyncPhase, MAX_STARS, type SyncPhase } from "@starwatch/domain";
import { diffStars, GithubClient } from "@starwatch/core/sync";
import { RepoStore, UserFts } from "@starwatch/cloudflare/storage";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Predicate from "effect/Predicate";
import { SyncDeps, type SyncDepsService } from "../deps.ts";
import {
  StarRefreshWorkflow,
  type StarRefreshInput,
  type StarRefreshResult,
} from "./refresh-workflow.ts";
import { workflowInstanceLive } from "./liveness.ts";
import { elapsedMs, logError, logRun } from "./log.ts";
import { planRateLimitWait } from "./rate-limit.ts";
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

/**
 * Terminal write for a run that will not resume: the `failed`/`paused` phase
 * plus the release of the account's owner record.
 *
 * The release is not bookkeeping. `claimRunInstance` is a conditional UPDATE on
 * `run_instance_id`, so a finished run that keeps its id makes every later
 * `POST /sync` lose the claim and leaves the account in an active phase that
 * nothing owns — the worst case of the stalled-run story this pipeline spends
 * so much code avoiding. Only terminal paths may call this: a run sleeping out
 * a rate limit is still alive and keeps its id.
 */
const endRun = (
  login: string,
  phase: "failed" | "paused",
  lastError: string,
): Effect.Effect<void, never, RepoStore> =>
  Effect.gen(function* () {
    const repos = yield* RepoStore;

    yield* patchState(login, { phase, lastError });
    yield* repos.setRunInstance(login, null).pipe(Effect.ignore);
  });

type PageOutcome =
  | { readonly kind: "fresh"; readonly ids: ReadonlyArray<number>; readonly stop: boolean }
  | { readonly kind: "not-modified" }
  | {
      readonly kind: "rate-limited";
      readonly waitMs: number;
      readonly until: Date | null;
      readonly reason: string;
      readonly message: string;
      readonly rateLimitRemaining: number;
    }
  | { readonly kind: "error"; readonly message: string };

const makeListingBody = (
  deps: SyncDepsService,
  refresh: Cloudflare.WorkflowHandle<StarRefreshInput, StarRefreshResult>,
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
            onFailure: (error) =>
              Effect.succeed({ ok: false as const, message: describeGithubError(error) }),
          }),
        );

        if (!fetched.ok) {
          yield* endRun(login, "failed", fetched.message);

          return { ok: false as const, starsHint: 0 };
        }

        // Key the profile by the lowercased route login so `users.login`
        // matches every other table (docs/09 §7 case handling).
        yield* repos.upsertUser({ ...fetched.value, login }).pipe(Effect.orDie);
        const previous = yield* repos.getIndexState(login).pipe(Effect.orDie);
        yield* patchState(login, { phase: "listing", lastError: null });

        return { ok: true as const, starsHint: previous?.starsTotal ?? 0 };
      }),
      { retries: { limit: 3, delay: "5 seconds" } },
    );

    if (!profile.ok) {
      return { ok: false, reason: "profile" };
    }

    // ---- public Lists (optional enrichment; never fails the run) -----------
    yield* Cloudflare.Workflows.task(
      "lists",
      Effect.gen(function* () {
        const fetched = yield* github.listGroups(login).pipe(
          Effect.matchEffect({
            onSuccess: (value) => Effect.succeed({ ok: true as const, value }),
            onFailure: (error) =>
              Effect.succeed({ ok: false as const, message: describeGithubError(error) }),
          }),
        );

        // A failed fetch is *not* an empty account. Replacing with `[]` would
        // delete every collection the user has (memberships included) because
        // of one rate-limited probe; leaving the stored rows alone keeps the
        // last known lists until a run can read them. The failure itself is
        // recorded so the rail can say "couldn't load collections" instead of
        // "no public Lists".
        if (!fetched.ok) {
          yield* repos
            .putListsInfo(login, { state: "error", error: fetched.message, checkedAt: nowIso() })
            .pipe(Effect.ignore);
          logError("starwatch.sync.listing.lists-skipped", {
            login,
            phase: "listing",
            reason: fetched.message,
          });

          return;
        }

        yield* repos.replaceGroups(login, fetched.value).pipe(Effect.ignore);
        yield* repos
          .putListsInfo(login, {
            state: fetched.value.length > 0 ? "ok" : "empty",
            error: null,
            checkedAt: nowIso(),
          })
          .pipe(Effect.ignore);
        logRun("starwatch.sync.listing.lists", {
          login,
          phase: "listing",
          groups: fetched.value.length,
        });
      }),
      { retries: { limit: 1, delay: "5 seconds" } },
    );

    // ---- star pages --------------------------------------------------------
    const freshPages = new Map<number, ReadonlyArray<number>>();
    const notModifiedPages = new Set<number>();
    const startedAt = Date.now();
    let listedCount = 0;
    let page = 1;
    // Rate-limit waits taken so far (bounded by MAX_RATE_LIMIT_WAITS) and the
    // last remaining-quota GitHub reported, both only for the log line.
    let rateLimitWaits = 0;
    let rateLimitRemaining: number | undefined;

    logRun("starwatch.sync.listing.start", { login, phase: "listing", full: input.full === true });

    // Repo counts of the pages already stored. A re-list answers 304 for most
    // pages, and a 304 page never tells us how big it is — without this the
    // confirmed count stays at the *previous* total, so the panel sits at
    // "3,447 of 3,447" for the whole sweep and a healthy run looks hung.
    const storedPageCounts = new Map<number, number>();

    let confirmed = 0;

    for (const row of yield* repos.getStarPageRows(login).pipe(Effect.orDie)) {
      // Unattributed rows (pre-migration writers) belong to no page, so they
      // are counted up front: the progress bar would otherwise stop short of
      // the real total for every legacy account.
      if (row.starPage === null) {
        confirmed += 1;
        continue;
      }

      storedPageCounts.set(row.starPage, (storedPageCounts.get(row.starPage) ?? 0) + 1);
    }

    while (page <= MAX_PAGES) {
      const pageNumber = page;

      const outcome: PageOutcome = yield* Cloudflare.Workflows.task(
        // A page re-queued after a rate-limit wait is a new step: replaying the
        // memoized failure would fail the run instead of refetching the page.
        `star-page-${pageNumber}-w${rateLimitWaits}`,
        Effect.gen(function* () {
          const etag = yield* repos.starEtag(login, pageNumber).pipe(Effect.orDie);

          const fetched = yield* github
            .listStarPage(login, {
              page: pageNumber,
              perPage: PER_PAGE,
              etag: etag ?? undefined,
            })
            .pipe(
              Effect.matchEffect({
                onSuccess: (value) => Effect.succeed({ ok: true as const, value }),
                onFailure: (error) => Effect.succeed({ ok: false as const, error }),
              }),
            );

          if (!fetched.ok) {
            const state = describeGithubError(fetched.error);

            // Rate limits are the one failure worth waiting out (docs/03 §1.3):
            // the run keeps its progress and resumes the same page.
            if (Predicate.isTagged(fetched.error, "GithubRateLimited")) {
              const plan = planRateLimitWait(fetched.error, { waitsSoFar: rateLimitWaits });

              return {
                kind: "rate-limited",
                waitMs: plan.waitMs,
                until: plan.until,
                reason: plan.reason,
                message: state,
                rateLimitRemaining: rateLimitRemaining ?? 0,
              } satisfies PageOutcome;
            }

            return { kind: "error", message: state } satisfies PageOutcome;
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
                  readme: readmes.get(repo.id) ?? "",
                })),
              )
              .pipe(Effect.orDie);
          }

          if (starPage.etag !== undefined) {
            yield* repos.putStarEtag(login, pageNumber, starPage.etag).pipe(Effect.orDie);
          }

          // `reposMetadata` is the progress counter while a listing runs: pages
          // confirmed so far. `starsTotal` stays the best estimate of the final
          // size (never below what a previous run saw), so the bar moves
          // 0 → ~3,447 instead of starting at 100%.
          // A fresh page *replaces* its stored rows, so its own length is what
          // that page now contributes.
          confirmed += starPage.repos.length;
          yield* patchState(login, {
            phase: "listing",
            starsTotal: Math.max(profile.starsHint, confirmed),
            reposMetadata: confirmed,
            lastError: null,
          });

          const stop = starPage.repos.length < PER_PAGE || starPage.nextPage === undefined;
          rateLimitRemaining = starPage.rateLimitRemaining;

          return {
            kind: "fresh",
            ids: starPage.repos.map((repo) => repo.id),
            stop,
          } satisfies PageOutcome;
        }),
        { retries: { limit: 3, delay: "5 seconds" } },
      );

      if (outcome.kind === "error") {
        logError("starwatch.sync.listing.paused", {
          login,
          phase: "paused",
          page: pageNumber,
          reason: outcome.message,
          elapsedMs: elapsedMs(startedAt),
        });
        yield* endRun(login, "paused", outcome.message);

        return { ok: false, reason: "github" };
      }

      if (outcome.kind === "rate-limited") {
        if (outcome.waitMs === 0) {
          const message = `${outcome.message} (${outcome.reason}); retry later`;

          logError("starwatch.sync.listing.paused", {
            login,
            phase: "paused",
            page: pageNumber,
            reason: outcome.reason,
            elapsedMs: elapsedMs(startedAt),
          });
          yield* endRun(login, "paused", message);

          return { ok: false, reason: "rate-limit" };
        }

        rateLimitWaits += 1;
        logError("starwatch.sync.listing.rate-limit", {
          login,
          phase: "listing",
          page: pageNumber,
          waitMs: outcome.waitMs,
          until: outcome.until?.toISOString() ?? null,
          reason: outcome.reason,
          remaining: outcome.rateLimitRemaining,
          waits: rateLimitWaits,
        });
        // A sleep is invisible in the state row, which is exactly what a dead
        // run looks like: the panel would cry "no progress" and — past
        // `STUCK_LIVE_RUN_MS` — a retry would terminate a run that is merely
        // waiting. Publishing the wait as `paused` (the phase the UI already
        // explains as "resumes when the limit resets") keeps the two apart.
        yield* patchState(login, {
          phase: "paused",
          lastError: `GitHub rate limit; resuming ${outcome.until?.toISOString() ?? "shortly"}`,
        });
        yield* Cloudflare.Workflows.sleep(`rate-limit-${rateLimitWaits}`, outcome.waitMs);
        yield* patchState(login, { phase: "listing", lastError: null });

        // Same page, same progress: the loop does not advance until it answers.
        continue;
      }

      if (outcome.kind === "not-modified") {
        notModifiedPages.add(pageNumber);
        confirmed += storedPageCounts.get(pageNumber) ?? 0;
        yield* patchState(login, {
          phase: "listing",
          starsTotal: Math.max(profile.starsHint, confirmed),
          reposMetadata: confirmed,
          lastError: null,
        });
        page += 1;
        continue;
      }

      freshPages.set(pageNumber, outcome.ids);
      listedCount += outcome.ids.length;

      if (outcome.stop || listedCount >= MAX_STARS) break;
      page += 1;
    }

    logRun("starwatch.sync.listing.pages", {
      login,
      phase: "listing",
      pages: freshPages.size,
      notModified: notModifiedPages.size,
      listed: listedCount,
      waits: rateLimitWaits,
      elapsedMs: elapsedMs(startedAt),
    });

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
      { retries: { limit: 2, delay: "5 seconds" } },
    );

    const removedChunks = chunk(removed, UNSTAR_CHUNK);

    logRun("starwatch.sync.listing.diff", {
      login,
      phase: "listing",
      removed: removed.length,
      unstarTasks: removedChunks.length,
      elapsedMs: elapsedMs(startedAt),
    });

    for (let index = 0; index < removedChunks.length; index++) {
      yield* Cloudflare.Workflows.task(
        `unstar-${index}`,
        repos.markUnstarred(login, removedChunks[index] ?? []).pipe(Effect.orDie),
      );
    }

    // ---- finalize ----------------------------------------------------------
    const phase: SyncPhase = input.full === true ? "fetching-readmes" : "ready";
    logRun("starwatch.sync.listing.finalized", {
      login,
      phase,
      listed: listedCount,
      removed: removed.length,
      full: input.full === true,
      elapsedMs: elapsedMs(startedAt),
    });
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
          lastError: null,
        });
      }),
      { retries: { limit: 3, delay: "5 seconds" } },
    );

    // ---- chain Tier 1 ------------------------------------------------------
    if (input.full === true) {
      // Unique per run. A day-scoped id was the old dedupe mechanism, but it
      // also blocked the *retry* that a paused/failed refresh needs: the
      // retained instance made `create` fail, the run settled to `ready`, and
      // the user got "Index updated" with the semantic pass still missing.
      // Ownership is recorded in `user_index_state` now, so dedupe no longer
      // needs the id to be shared.
      const refreshId = `refresh-${login}-${input.requestId ?? crypto.randomUUID()}`;

      const chained = yield* Effect.exit(
        refresh.create({ id: refreshId, params: { login, runId: input.requestId } }),
      );

      const live = Exit.isFailure(chained) ? yield* workflowInstanceLive(refresh, refreshId) : true;

      logRun("starwatch.sync.listing.chained", {
        login,
        phase,
        chained: Exit.isSuccess(chained),
        refreshLive: live,
        elapsedMs: elapsedMs(startedAt),
      });

      // A refresh for today may already have run (or be running). The instance
      // id makes that a silent no-op, which would otherwise strand the run in
      // `fetching-readmes` — an *active* phase, so `POST /sync` answers 409 and
      // the user is stuck with a spinner until tomorrow.
      if (!live) {
        const current = yield* repos.getIndexState(login).pipe(Effect.orDie);

        if (current !== null && isActiveSyncPhase(current.phase)) {
          yield* patchState(login, { phase: "ready", lastError: null });
        }
      }

      // Ownership moves in one step: the listing handed the account to the
      // refresh (which now owns `fetching-readmes`), or nothing owns it. A
      // window where the phase is active and no id is recorded would look like
      // an abandoned run and invite a takeover.
      yield* repos.setRunInstance(login, live ? refreshId : null).pipe(Effect.ignore);
    } else {
      // A re-list is done: nothing owns the account until the next request.
      yield* repos.setRunInstance(login, null).pipe(Effect.ignore);
    }

    return {
      ok: true,
      phase,
      listed: listedCount,
      removed: removed.length,
      pages: freshPages.size,
      notModified: notModifiedPages.size,
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

      // The boundary is the only path that sees an *unhandled* failure, so it
      // is the one place that must log: without this a run that died inside a
      // step leaves a `failed` row and no explanation in Workers Logs.
      logError("starwatch.sync.listing.crashed", {
        login: input.login,
        phase: "failed",
        error: exit.cause.toString().slice(0, 200),
      });
      yield* endRun(input.login, "failed", "listing failed").pipe(
        Effect.provide(deps.runLayers),
        Effect.ignore,
      );

      return { ok: false, reason: "internal" };
    });
  }),
) {}
