import { MAX_STARS, SEMANTIC_WINDOW, type SyncPhase } from "@starwatch/domain";
import {
  diffStars,
  Embedder,
  GithubClient,
  hashReadme,
  planReadmeWork,
  type EmbedderShape
} from "@starwatch/core/sync";
import { repoEmbeddingText } from "@starwatch/cloudflare/ai";
import { README_MAX_CHARS, RepoStore, UserFts } from "@starwatch/cloudflare/storage";
import type * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import {
  decodeVectors,
  encodeVectors,
  vectorBlobBinKey,
  vectorIdsKey,
  type VectorBlobFilesShape
} from "../adapters/vector-bucket.ts";
import { EMBED_BATCH, README_FETCH_BATCH } from "../constants.ts";
import type { StarListingInput } from "../sync/listing-workflow.ts";
import { describeGithubError, nowIso, patchState } from "../sync/state.ts";

/**
 * Local, in-process equivalent of the Durable Workflow pair.
 *
 * The production listing/refresh workflows are built on `Cloudflare.Workflows`
 * steps, which only exist inside the Workers runtime. This module reimplements
 * their semantics as a straight-line Effect program over the same services
 * (`RepoStore`, `UserFts`, `GithubClient`, `Embedder`, vector files) so
 * `pnpm dev:local` can run the whole pipeline on Node with SQLite + an
 * in-memory bucket.
 *
 * Deviations from the production workflows (all fine for dev):
 *   * no per-step retries/checkpointing — a failed run is simply re-runnable;
 *   * Tier 1 runs sequentially (batch 8 READMEs, batch 32 embeddings) instead
 *     of fan-out parts + fan-in merges;
 *   * the semantic pass reuses vectors from the previous blob when a repo's
 *     README hash is unchanged, which is the local version of "resumable".
 */

export interface LocalSyncDeps {
  /** `RepoStore` + `UserFts` over the local sqlite `SqlClient`. */
  readonly storageLayer: Layer.Layer<RepoStore | UserFts>;
  /** GitHub client over the Node fetch implementation. */
  readonly githubLayer: Layer.Layer<GithubClient>;
  /** Deterministic local embedder (`fake-embedder.ts`). */
  readonly embedder: EmbedderShape;
  /** Effect-native vector file ops over the in-memory bucket. */
  readonly vectorFiles: VectorBlobFilesShape;
}

const PER_PAGE = 100;
const MAX_PAGES = Math.ceil(MAX_STARS / PER_PAGE);
/** Same chunking as the workflow's unstar cleanup (90 rows/statement). */
const UNSTAR_CHUNK = 3_600;

const chunk = <A>(items: ReadonlyArray<A>, size: number): ReadonlyArray<ReadonlyArray<A>> => {
  const out: Array<ReadonlyArray<A>> = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
};

const runLayers = (deps: LocalSyncDeps): Layer.Layer<RepoStore | UserFts | GithubClient | Embedder> =>
  Layer.mergeAll(deps.storageLayer, deps.githubLayer, Layer.succeed(Embedder, deps.embedder));

/** Result of the Tier 0 listing pass; `ok: false` already patched the state. */
interface ListingOutcome {
  readonly ok: boolean;
}

/**
 * Tier 0: profile, public Lists, ETag-aware star pages, FTS upsert, unstar
 * diff and finalize. Mirrors `StarListingWorkflow` without the step engine.
 */
const listingBody = (
  login: string,
  full: boolean
): Effect.Effect<ListingOutcome, never, RepoStore | UserFts | GithubClient> =>
  Effect.gen(function* () {
    const repos = yield* RepoStore;
    const fts = yield* UserFts;
    const github = yield* GithubClient;

    // ---- profile -----------------------------------------------------------
    const fetchedProfile = yield* github.getUserProfile(login).pipe(
      Effect.matchEffect({
        onSuccess: (value) => Effect.succeed({ ok: true as const, value }),
        onFailure: (error) => Effect.succeed({ ok: false as const, message: describeGithubError(error) })
      })
    );
    if (!fetchedProfile.ok) {
      yield* patchState(login, { phase: "failed", lastError: fetchedProfile.message });
      return { ok: false };
    }
    // Key the profile by the lowercased route login (same as the workflow).
    yield* repos.upsertUser({ ...fetchedProfile.value, login }).pipe(Effect.orDie);
    const previous = yield* repos.getIndexState(login).pipe(Effect.orDie);
    yield* patchState(login, { phase: "listing", lastError: null });
    const starsHint = previous?.starsTotal ?? 0;

    // ---- public Lists (optional enrichment; never fails the run) -----------
    yield* github.listGroups(login).pipe(
      Effect.matchEffect({
        onSuccess: (groups) => repos.replaceGroups(login, groups).pipe(Effect.ignore),
        onFailure: () => Effect.void
      })
    );

    // ---- star pages --------------------------------------------------------
    const freshPages = new Map<number, ReadonlyArray<number>>();
    const notModifiedPages = new Set<number>();
    let listedCount = 0;
    let page = 1;

    while (page <= MAX_PAGES) {
      const pageNumber = page;
      const listedBefore = listedCount;
      const etag = yield* repos.starEtag(login, pageNumber).pipe(Effect.orDie);
      const fetched = yield* github
        .listStarPage(login, { page: pageNumber, perPage: PER_PAGE, etag: etag ?? undefined })
        .pipe(
          Effect.matchEffect({
            onSuccess: (value) => Effect.succeed({ ok: true as const, value }),
            onFailure: (error) => Effect.succeed({ ok: false as const, message: describeGithubError(error) })
          })
        );
      if (!fetched.ok) {
        yield* patchState(login, { phase: "paused", lastError: fetched.message });
        return { ok: false };
      }
      const starPage = fetched.value;
      if (starPage.notModified) {
        // 304: the stored repo ids for this page remain authoritative.
        notModifiedPages.add(pageNumber);
        page += 1;
        continue;
      }

      if (starPage.repos.length > 0) {
        yield* repos.upsertRepoBatch(login, starPage.repos, pageNumber).pipe(Effect.orDie);
        // Preserve already-fetched README text in the FTS rows (workflow parity).
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

      // Progress only grows across re-lists (workflow parity).
      const seen = Math.max(starsHint, listedBefore + starPage.repos.length);
      yield* patchState(login, {
        phase: "listing",
        starsTotal: seen,
        reposMetadata: seen,
        lastError: null
      });

      freshPages.set(pageNumber, starPage.repos.map((repo) => repo.id));
      listedCount += starPage.repos.length;
      const stop = starPage.repos.length < PER_PAGE || starPage.nextPage === undefined;
      if (stop || listedCount >= MAX_STARS) break;
      page += 1;
    }

    // ---- diff: union fresh ids with the stored ids of unchanged pages ------
    const rows = yield* repos.getStarPageRows(login).pipe(Effect.orDie);
    const dbIds = yield* repos.listRepoIds(login).pipe(Effect.orDie);
    const listed = new Set<number>();
    for (const row of rows) {
      // Unattributed rows (pre-migration writers) are kept.
      if (row.starPage === null || notModifiedPages.has(row.starPage)) listed.add(row.repoId);
    }
    for (const ids of freshPages.values()) {
      for (const id of ids) listed.add(id);
    }
    const removed = diffStars(dbIds, [...listed]).removed;
    for (const removedChunk of chunk(removed, UNSTAR_CHUNK)) {
      yield* repos.markUnstarred(login, removedChunk).pipe(Effect.orDie);
    }

    // ---- finalize ----------------------------------------------------------
    const phase: SyncPhase = full ? "fetching-readmes" : "ready";
    const stats = yield* repos.countStats(login).pipe(Effect.orDie);
    yield* patchState(login, {
      phase,
      starsTotal: stats.starsTotal,
      reposMetadata: stats.reposMetadata,
      readmesFetched: stats.readmesFetched,
      lastSyncedAt: nowIso(),
      lastError: null
    });

    return { ok: true };
  });

/**
 * Tier 1 (local): fetch dirty READMEs, refresh FTS, embed the semantic window
 * and rewrite `vectors/{login}.bin` (+ ids sidecar) in one pass.
 *
 * Repos whose persisted `readme_hash` matches the current README and that
 * already have a vector in the previous blob are skipped, so an interrupted
 * full sync can simply be re-run.
 */
const semanticBody = (
  deps: LocalSyncDeps,
  login: string
): Effect.Effect<void, never, RepoStore | UserFts | GithubClient | Embedder> =>
  Effect.gen(function* () {
    const repos = yield* RepoStore;
    const fts = yield* UserFts;
    const github = yield* GithubClient;
    const embedder = yield* Embedder;

    const all = yield* repos.listReposForSearch(login, {}).pipe(Effect.orDie);
    const windowRepos = all.slice(0, SEMANTIC_WINDOW);
    if (windowRepos.length === 0) {
      yield* patchState(login, { phase: "ready", semanticDocs: 0 });
      return;
    }
    const windowIds = new Set(windowRepos.map((repo) => repo.id));

    // ---- READMEs: only repos whose pushed_at moved are refetched ----------
    const states = yield* repos.getReadmeStates(login).pipe(Effect.orDie);
    const storedTexts = yield* repos.getReadmeTexts(login, [...windowIds]).pipe(Effect.orDie);
    const readmeText = new Map<number, string>(storedTexts);
    const storedHashes = new Map<number, string>();
    for (const [id, text] of storedTexts) storedHashes.set(id, hashReadme(text));

    const batches = planReadmeWork(all, states, { batchSize: README_FETCH_BATCH });
    for (const batch of batches) {
      const repoRows = yield* repos.getRepos(login, batch).pipe(Effect.orDie);
      const repoById = new Map(repoRows.map((repo) => [repo.id, repo] as const));
      for (const id of batch) {
        const repo = repoById.get(id);
        if (repo === undefined) continue;
        const fetched = yield* github.getReadme(repo.fullName, "HEAD").pipe(
          Effect.matchEffect({
            onSuccess: (value) => Effect.succeed({ ok: true as const, value }),
            onFailure: (error) => Effect.succeed({ ok: false as const, message: describeGithubError(error) })
          })
        );
        if (!fetched.ok) {
          // README failures only degrade this repo's semantic freshness.
          yield* Effect.logWarning(
            `local sync: README fetch failed for ${repo.fullName}: ${fetched.message}`
          );
          continue;
        }
        if (fetched.value === null) {
          yield* repos
            .putReadme(id, { text: null, hash: null, state: "missing", checkedAt: nowIso() })
            .pipe(Effect.orDie);
          readmeText.set(id, "");
        } else {
          const text =
            fetched.value.text.length > README_MAX_CHARS
              ? fetched.value.text.slice(0, README_MAX_CHARS)
              : fetched.value.text;
          yield* repos
            .putReadme(id, { text, hash: hashReadme(text), state: "present", checkedAt: nowIso() })
            .pipe(Effect.orDie);
          readmeText.set(id, text);
        }
      }
      yield* fts
        .upsertUserDocs(
          login,
          batch.flatMap((id) => {
            const repo = repoById.get(id);
            return repo === undefined
              ? []
              : [
                  {
                    repoId: repo.id,
                    fullName: repo.fullName,
                    description: repo.description,
                    topics: repo.topics,
                    readme: readmeText.get(id) ?? ""
                  }
                ];
          })
        )
        .pipe(Effect.orDie);
    }

    // ---- reuse vectors from the previous blob when unchanged ---------------
    const existingBytes = yield* deps.vectorFiles.getBytes(vectorBlobBinKey(login)).pipe(Effect.orDie);
    const existingIds = yield* deps.vectorFiles.getIds(vectorIdsKey(login)).pipe(Effect.orDie);
    const existingVectors = new Map<number, Float32Array>();
    if (existingBytes !== null && existingIds !== null) {
      const decoded = yield* Effect.try({
        try: () => decodeVectors(existingBytes),
        catch: (cause) => cause
      }).pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<Float32Array>));
      if (decoded.length === existingIds.length) {
        for (let index = 0; index < existingIds.length; index++) {
          const id = existingIds[index];
          const vector = decoded[index];
          if (id !== undefined && vector !== undefined && windowIds.has(id)) {
            existingVectors.set(id, vector);
          }
        }
      }
    }

    const dirty: Array<{ readonly id: number; readonly text: string }> = [];
    for (const repo of windowRepos) {
      const readme = readmeText.get(repo.id) ?? "";
      const hash = hashReadme(readme);
      if (storedHashes.get(repo.id) === hash && existingVectors.has(repo.id)) continue;
      dirty.push({ id: repo.id, text: repoEmbeddingText(repo, readme) });
    }

    const vectorsById = new Map<number, Float32Array>(existingVectors);
    if (dirty.length > 0) {
      yield* patchState(login, { phase: "embedding" });
      for (const batch of chunk(dirty, EMBED_BATCH)) {
        const vectors = yield* embedder.embed(batch.map((entry) => entry.text)).pipe(Effect.orDie);
        if (vectors.length !== batch.length) {
          return yield* Effect.die(
            new Error(`embedder returned ${vectors.length} vectors for ${batch.length} texts`)
          );
        }
        for (let index = 0; index < batch.length; index++) {
          const entry = batch[index];
          const vector = vectors[index];
          if (entry !== undefined && vector !== undefined) vectorsById.set(entry.id, vector);
        }
      }
    }

    // ---- write the canonical blob + pointer --------------------------------
    const selected: Array<{ readonly id: number; readonly vector: Float32Array }> = [];
    for (const repo of windowRepos) {
      const vector = vectorsById.get(repo.id);
      if (vector !== undefined) selected.push({ id: repo.id, vector });
    }
    const ids = selected.map((entry) => entry.id);
    const vectors = selected.map((entry) => entry.vector);
    const upToDate =
      existingIds !== null &&
      existingIds.length === ids.length &&
      existingIds.every((id, index) => ids[index] === id);
    if (vectors.length > 0 && (dirty.length > 0 || !upToDate)) {
      const bytes = encodeVectors(vectors);
      yield* deps.vectorFiles.putBytes(vectorBlobBinKey(login), bytes).pipe(Effect.orDie);
      yield* deps.vectorFiles.putIds(vectorIdsKey(login), ids).pipe(Effect.orDie);
      yield* repos.putVectorBlob(login, vectors[0]?.length ?? 0, bytes.byteLength).pipe(Effect.orDie);
    }

    const stats = yield* repos.countStats(login).pipe(Effect.orDie);
    const previousState = yield* repos.getIndexState(login).pipe(Effect.orDie);
    yield* patchState(login, {
      phase: "ready",
      readmesFetched: stats.readmesFetched,
      semanticDocs: vectors.length,
      lastSyncedAt: previousState?.lastSyncedAt ?? nowIso()
    });
  });

/** One local run: listing always, semantic pass only for `full` syncs. */
export const runLocalSync = (
  deps: LocalSyncDeps,
  login: string,
  full: boolean
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const outcome = yield* listingBody(login, full);
    if (outcome.ok && full) {
      yield* semanticBody(deps, login);
    }
  }).pipe(Effect.provide(runLayers(deps)));

/** Statuses the local job map reports; a superset-compatible subset of CF's. */
export type LocalSyncStatus = "queued" | "running" | "complete" | "errored";

export interface LocalSyncInstance {
  readonly id: string;
  readonly status: () => Effect.Effect<{ readonly status: LocalSyncStatus | "unknown" }>;
}

/**
 * `Cloudflare.WorkflowHandle`-compatible stub for `POST /users/:login/sync`.
 *
 * Jobs are tracked in a Map and executed on daemon fibers, so requests return
 * immediately and `GET /sync` can poll the state table exactly like it does in
 * production.
 */
export const startLocalSync = (deps: LocalSyncDeps): Cloudflare.WorkflowHandle<StarListingInput, unknown> => {
  const jobs = new Map<string, LocalSyncStatus>();

  const instance = (id: string): LocalSyncInstance => ({
    id,
    status: () => Effect.succeed({ status: jobs.get(id) ?? "unknown" })
  });

  const handle = {
    create: (options?: { readonly id?: string; readonly params?: StarListingInput }) =>
      Effect.gen(function* () {
        const id = options?.id ?? `local-${crypto.randomUUID()}`;
        const params = options?.params;
        if (params === undefined) {
          return yield* Effect.die("local listing workflow requires params");
        }
        jobs.set(id, "queued");
        yield* Effect.forkDetach(
          Effect.gen(function* () {
            jobs.set(id, "running");
            const exit = yield* Effect.exit(runLocalSync(deps, params.login, params.full === true));
            if (Exit.isSuccess(exit)) {
              jobs.set(id, "complete");
            } else {
              jobs.set(id, "errored");
              yield* patchState(params.login, { phase: "failed", lastError: "local sync failed" }).pipe(
                Effect.provide(deps.storageLayer),
                Effect.ignore
              );
            }
          })
        );
        return instance(id);
      }),
    get: (id: string) => Effect.succeed(instance(id))
  };

  return handle as unknown as Cloudflare.WorkflowHandle<StarListingInput, unknown>;
};
