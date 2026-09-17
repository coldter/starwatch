import { GithubRateLimited, SEMANTIC_WINDOW } from "@starwatch/domain";
import { encodeVectors } from "@starwatch/core/search";
import {
  Embedder,
  GithubClient,
  hashReadme,
  planEmbedWork,
  planReadmeWork,
  publishedReadmeHash,
  readmeBatchAction,
  type GithubClientError,
  type ReadmeStateMap,
} from "@starwatch/core/sync";
import { repoEmbeddingText } from "@starwatch/cloudflare/ai";
import { README_MAX_CHARS, RepoStore, UserFts } from "@starwatch/cloudflare/storage";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Predicate from "effect/Predicate";
import { SyncDeps } from "../deps.ts";
import { MERGE_FAN_IN, README_FETCH_BATCH, README_PROGRESS_EVERY } from "../constants.ts";
import { elapsedMs, logRun } from "./log.ts";
import { MAX_RATE_LIMIT_WAITS, planRateLimitWait, type RateLimitWait } from "./rate-limit.ts";
import { describeGithubError, nowIso, patchState } from "./state.ts";
import {
  decodeVectors,
  VectorBlobFiles,
  vectorIdsKey,
  vectorBlobBinKey,
  vectorMergeBaseKey,
  vectorPartBaseKey,
} from "../adapters/vector-bucket.ts";

/**
 * Tier 1 (semantic) refresh: fetch changed READMEs for the newest
 * `SEMANTIC_WINDOW` repos, embed the dirty subset, and rewrite the per-user
 * R2 vector blob (docs/15 §2).
 *
 * Free-tier step math (per invocation, docs/13 §1):
 *   * external subrequests ≤ 50 → README_FETCH_BATCH (8) × 6 worst-case raw
 *     probes/REST fallback = 48. D1 and R2 calls are Cloudflare-service
 *     subrequests, budgeted separately.
 *   * D1 queries ≤ 50 → per 8-repo batch: 1 `getRepos` + 1 `getReadmeTexts`
 *     + 8 `putReadme` + ≤6 FTS upsert statements ≈ 16.
 *   * AI: one `embed` call per non-empty batch (≤32 texts, one subrequest).
 *   * R2: 2 puts per batch (part `.bin` + `.ids.json`).
 *
 * Step count for a full 1,500-repo window (see {@link refreshStepBudget}):
 *   1 plan + 188 README batches (1,500 ÷ 8) + ≤2 rate-limit retries (the wait
 *   budget is per *run*, so two waits buy at most two extra batch attempts)
 *   + 47 heartbeats (every `README_PROGRESS_EVERY` batches, last one always)
 *   + 5 fan-in merges + 1 finalize = **244**, against the 1,000-step cap. A
 *   batch that hits a GitHub limit retries in place after a bounded wait
 *   (docs/03 §1.3): the wait is one `step.sleep` (2 steps per retry with the
 *   attempt), and a batch that hits our own ceiling is skipped rather than
 *   retried, so its step is counted once.
 */

export interface StarRefreshInput {
  readonly login: string;
  /**
   * Stable label for this run's R2 scratch namespace, passed by the caller that
   * started the run (the listing's `requestId`). When absent the plan step mints
   * one: the plan result is memoized, so every replay of this instance sees the
   * same token and therefore the same part/merge keys.
   */
  readonly runId?: string;
}

/** What one tier-1 refresh run reports back (workflow instance output). */
export interface StarRefreshResult {
  readonly ok: boolean;
  readonly semanticDocs: number;
  readonly embedded: number;
}

const chunk = <A>(items: ReadonlyArray<A>, size: number): ReadonlyArray<ReadonlyArray<A>> => {
  const out: Array<ReadonlyArray<A>> = [];

  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));

  return out;
};

interface BatchOutcome {
  readonly ok: boolean;
  /** Base key of the written part, or `null` when nothing was embedded. */
  readonly partBase: string | null;
  readonly embedded: number;
  readonly error: string | null;
  /**
   * Set when the batch failed on a GitHub limit: how long to wait before
   * retrying the same batch, or a stop decision (`waitMs === 0`). `null` for
   * every other failure, which must fail the run rather than wait.
   */
  readonly rateLimit: RateLimitWait | null;
  /** The batch hit our own ceiling: a stalled dependency, not a GitHub limit. */
  readonly timedOut: boolean;
}

/** The rate-limit error behind a batch failure, if that is what it was. */
const rateLimitOf = (error: GithubClientError): GithubRateLimited | null =>
  error instanceof GithubRateLimited ? error : null;

/** May another wait be taken? The counter is run-wide, so this bounds the whole run. */
const canWaitAgain = (waitsSoFar: number): boolean => waitsSoFar < MAX_RATE_LIMIT_WAITS;

/**
 * Step name for one batch attempt. A retried attempt must be a *new* step:
 * the workflow cache would otherwise replay the rate-limited result and the
 * run would spin without ever calling GitHub again. `attempts` is per batch
 * (names only have to be unique per index), the wait *budget* is per run.
 */
const batchStepName = (index: number, attempts: number): string =>
  attempts === 0 ? `readme-batch-${index}` : `readme-batch-${index}-w${attempts}`;

/**
 * Hard ceiling for one batch: 8 README probes plus one embed call. Normal
 * batches finish in seconds, so minutes of silence mean a stalled connection or
 * an unavailable dependency — which we would rather report than let the step sit
 * until the platform's own step timeout decides. The timeout *interrupts* the
 * batch, so nothing keeps running in the background.
 */
const BATCH_TIMEOUT_MS = 3 * 60_000;

/**
 * Timed-out batches a run tolerates before it gives up. Skipping one keeps the
 * other 187 worth of work; skipping all of them would mean the dependency is
 * gone, and a partial semantic index is worth more than a failed run.
 */
const MAX_TIMED_OUT_BATCHES = 8;

interface FinalizeOutcome {
  readonly ok: boolean;
  readonly semanticDocs: number;
  readonly embedded: number;
  readonly error: string | null;
}

const decodePart = (bytes: Uint8Array): Effect.Effect<ReadonlyArray<Float32Array>, never> =>
  Effect.try({
    try: () => decodeVectors(bytes),
    catch: (cause) => cause,
  }).pipe(Effect.orDie);

const readPart = (
  base: string,
): Effect.Effect<
  { readonly ids: ReadonlyArray<number>; readonly vectors: ReadonlyArray<Float32Array> } | null,
  never,
  VectorBlobFiles
> =>
  Effect.gen(function* () {
    const vectorFiles = yield* VectorBlobFiles;
    const bytes = yield* vectorFiles.getBytes(`${base}.bin`).pipe(Effect.orDie);
    const ids = yield* vectorFiles.getIds(`${base}.ids.json`).pipe(Effect.orDie);

    if (bytes === null || ids === null) return null;
    const vectors = yield* decodePart(bytes);

    if (vectors.length !== ids.length) return null;

    return { ids, vectors };
  });

/**
 * R2 scratch keys embed the run token, so it must be a path-safe label: the
 * listing's `requestId` is a UUID, and the minted fallback is one too.
 */
const runTokenOf = (input: StarRefreshInput): string => {
  const sanitized = (input.runId ?? "").replace(/[^A-Za-z0-9_-]/g, "");

  // An empty or fully-sanitized-away runId would namespace every run under the
  // same `run-/part-N` keys, which is exactly the collision this token exists
  // to prevent.
  return sanitized.length > 0 ? sanitized : crypto.randomUUID();
};

/**
 * One refresh batch part, or `null` when the object is gone. `null` is always a
 * defect at the merge/finalize levels (the part was written by this run's own
 * memoized step) — a silently skipped part is a blob quietly missing vectors.
 */
const readExpectedPart = (
  base: string,
): Effect.Effect<
  { readonly ids: ReadonlyArray<number>; readonly vectors: ReadonlyArray<Float32Array> },
  never,
  VectorBlobFiles
> =>
  Effect.gen(function* () {
    const part = yield* readPart(base);

    return part === null ? yield* Effect.die(`missing vector part ${base}`) : part;
  });

/** Merge N part bases into one intermediate base (one of ≤MERGE_FAN_IN). */
const mergeParts = (
  login: string,
  runToken: string,
  round: number,
  index: number,
  bases: ReadonlyArray<string>,
): Effect.Effect<string, never, VectorBlobFiles> =>
  Effect.gen(function* () {
    const vectorFiles = yield* VectorBlobFiles;
    const vectors: Float32Array[] = [];
    const ids: number[] = [];

    for (const base of bases) {
      const part = yield* readExpectedPart(base);

      vectors.push(...part.vectors);
      ids.push(...part.ids);
    }

    const out = vectorMergeBaseKey(login, runToken, round, index);
    yield* vectorFiles.putPart(out, vectors, ids).pipe(Effect.orDie);

    return out;
  });

/**
 * Mark the user's state as failed without masking the underlying error. Used
 * at the workflow boundary, where every failure mode (typed or defect) must
 * still surface to the UI as a state change.
 */
const markFailed = (login: string, message: string): Effect.Effect<void, never, RepoStore> =>
  patchState(login, { phase: "failed", lastError: message });

/**
 * Persist one batch's README rows: `present` with the fetched text, or
 * `missing` when GitHub has no README for the repo. Called only after the
 * batch's vectors are durable (see the batch body) — the stored hash is what
 * `planEmbedWork` compares against, so writing it early makes a retry skip the
 * embedding it still owes.
 */
const persistReadmes = (
  login: string,
  runToken: string,
  texts: ReadonlyMap<number, string>,
  states: ReadonlyMap<number, "present" | "missing">,
): Effect.Effect<void, never, RepoStore> =>
  Effect.gen(function* () {
    const repos = yield* RepoStore;

    for (const [id, state] of states) {
      // `pending`, not `present`: the vectors for this batch are still in a
      // part until finalize merges them, and claiming otherwise is what made an
      // aborted run leave repos that the planner would never look at again.
      // `finalize` flips the published ids afterwards.
      // `pendingRun` names *this* run: only its finalize may publish these rows,
      // so a concurrent run's pending marker survives (the rows are shared
      // across users while the vector blobs are not).
      if (state === "missing") {
        yield* repos
          .putReadme(id, {
            text: null,
            hash: null,
            state: "pending",
            pendingRun: runToken,
            checkedAt: nowIso(),
          })
          .pipe(Effect.orDie);
        continue;
      }

      const text = texts.get(id) ?? "";

      yield* repos
        .putReadme(id, {
          text,
          hash: hashReadme(text),
          state: "pending",
          pendingRun: runToken,
          checkedAt: nowIso(),
        })
        .pipe(Effect.orDie);
    }
  });

/**
 * Hand the given repos back to the README planner so a later run re-fetches
 * and re-embeds them.
 *
 * Needed for the *current* batch on the timeout-skip and pause paths: those
 * batch ids were never written at all (the write is deferred until the part is
 * durable), so their stored text is the old one and the row still looks
 * published. `error` makes the repo selectable again; the text is deliberately
 * kept, because it feeds snippets and the `readmesFetched` counter for every
 * starrer of a shared repo — and the re-fetched text hashes against the
 * published-hash rule, not against the stored text.
 */
const markNeedsReembed = (
  login: string,
  ids: ReadonlyArray<number>,
): Effect.Effect<void, never, RepoStore> =>
  Effect.gen(function* () {
    const repos = yield* RepoStore;

    if (ids.length === 0) return;

    // One read for the whole set: the text is kept (it feeds snippets for every
    // starrer), only the state changes.
    const previous = yield* repos.getReadmeTexts(login, ids).pipe(Effect.orDie);

    for (const id of ids) {
      const text = previous.get(id);

      yield* repos
        .putReadme(id, {
          text: text ?? null,
          hash: text === undefined ? null : hashReadme(text),
          state: "error",
          checkedAt: nowIso(),
        })
        .pipe(Effect.orDie);
    }
  });

/** Every repo id the run has planned work for up to and including `lastIndex`. */
const idsThrough = (
  batches: ReadonlyArray<ReadonlyArray<number>>,
  lastIndex: number,
): ReadonlyArray<number> => batches.slice(0, lastIndex + 1).flat();

const refreshBody = Effect.fn("StarRefreshWorkflow.body")(function* (input: StarRefreshInput) {
  const startedAt = Date.now();
  const login = input.login;
  const repos = yield* RepoStore;
  const fts = yield* UserFts;
  const github = yield* GithubClient;
  const embedder = yield* Embedder;
  const vectorFiles = yield* VectorBlobFiles;

  // ---- plan: which READMEs are dirty, and the semantic window -----------
  const plan = yield* Cloudflare.Workflows.task(
    "plan",
    Effect.gen(function* () {
      const all = yield* repos.listReposForSearch(login, {}).pipe(Effect.orDie);
      const states: ReadmeStateMap = yield* repos.getReadmeStates(login).pipe(Effect.orDie);

      // The vectors belong to *this* account while README rows are shared, so
      // the plan needs the account's published ids: a window repo missing from
      // them is embed work even when its README is current. `null` (no blob
      // yet) becomes an empty set and every window repo is planned.
      const publishedIds =
        (yield* vectorFiles.getIds(vectorIdsKey(login)).pipe(Effect.orDie)) ?? [];

      const batches = planReadmeWork(all, states, {
        batchSize: README_FETCH_BATCH,
        existingVectorIds: new Set(publishedIds),
      });

      const windowIds = all.slice(0, SEMANTIC_WINDOW).map((repo) => repo.id);

      // Minted inside the memoized plan so every replay of this instance files
      // its scratch objects under one token (see `vectorPartBaseKey`).
      return { batches, windowIds, publishedIds, runToken: runTokenOf(input) };
    }),
    { retries: { limit: 2, delay: "5 seconds" } },
  );

  logRun("starwatch.sync.refresh.start", {
    login,
    phase: "fetching-readmes",
    batches: plan.batches.length,
    window: plan.windowIds.length,
    runToken: plan.runToken,
  });

  // ---- per-batch README fetch + embed + part write ----------------------
  const partBases: string[] = [];
  let embeddedTotal = 0;
  let timedOutBatches = 0;
  // Run-wide wait budget (docs/03 §1.3): `MAX_RATE_LIMIT_WAITS` is a bound on
  // the *run*, not per batch, so a systemic limit stops the run after two
  // bounded waits instead of 188 × 2 × 15 minutes of sleeping.
  let rateLimitWaits = 0;

  for (let index = 0; index < plan.batches.length; index++) {
    const ids = plan.batches[index] ?? [];

    // One batch, retried in place while GitHub is limiting us. The wait lives
    // here (not inside the batch) so the batch stays a pure, memoizable step:
    // a wait is `step.sleep` and the retry is a differently-named step.
    const outcome = yield* Effect.gen(function* () {
      let attempts = 0;

      for (;;) {
        const attempt = yield* Cloudflare.Workflows.task(
          batchStepName(index, attempts),
          Effect.gen(function* () {
            const repoRows = yield* repos.getRepos(login, ids).pipe(Effect.orDie);
            const repoById = new Map(repoRows.map((repo) => [repo.id, repo] as const));
            const previousTexts = yield* repos.getReadmeTexts(login, ids).pipe(Effect.orDie);
            // A repo counts as embedded only when *this account's* published
            // blob has it. README rows are shared across users, so the row's
            // `present` state alone would let a second starrer inherit a vector
            // that was never built for them. `pending` means a previous run
            // stored the text but died before the blob merge, and any
            // unreadable state is treated as dirty: the empty marker can never
            // collide with a real hash, so the repo is re-embedded instead of
            // silently kept on a vector that was never published.
            const published = yield* repos.getReadmeStates(login).pipe(Effect.orDie);
            const publishedSet = new Set(plan.publishedIds);
            const existingHashes = new Map<number, string>();

            for (const id of ids) {
              const text = previousTexts.get(id);
              const known = published.get(id);

              existingHashes.set(
                id,
                publishedSet.has(id) && known !== undefined
                  ? publishedReadmeHash(known.status, text)
                  : "",
              );
            }

            const newTexts = new Map<number, string>();
            const states = new Map<number, "present" | "missing">();

            for (const id of ids) {
              const repo = repoById.get(id);

              if (repo === undefined) continue;

              const known = published.get(id);
              const action = readmeBatchAction(repo, known, previousTexts.get(id));

              // The stored text is authoritative while the README is current.
              // A restart after a killed run finds `pending` rows whose text is
              // already in D1: re-reading it from GitHub would spend the same
              // subrequest budget twice and throw away the fetch that already
              // succeeded. Only the embedding (never published) is redone.
              if (action.kind === "reuse") {
                newTexts.set(id, action.text);
                states.set(id, action.state);
                continue;
              }

              // `Repo` carries no default branch (schema freeze), so probe the
              // forgiving `HEAD` ref; the README client tries the raw variants
              // then the one-request REST fallback (docs/09 §3.3).
              const fetched = yield* github.getReadme(repo.fullName, "HEAD").pipe(
                Effect.matchEffect({
                  onSuccess: (value) => Effect.succeed({ ok: true as const, value }),
                  onFailure: (error) => Effect.succeed({ ok: false as const, error }),
                }),
              );

              if (!fetched.ok) {
                const limited = rateLimitOf(fetched.error);

                return {
                  ok: false,
                  partBase: null,
                  embedded: 0,
                  error: describeGithubError(fetched.error),
                  rateLimit:
                    limited === null
                      ? null
                      : planRateLimitWait(limited, {
                          waitsSoFar: rateLimitWaits,
                          attempt: attempts + 1,
                        }),
                  timedOut: false,
                } satisfies BatchOutcome;
              }

              const readme = fetched.value;

              if (readme === null) {
                newTexts.set(id, "");
                states.set(id, "missing");
                continue;
              }

              newTexts.set(
                id,
                readme.text.length > README_MAX_CHARS
                  ? readme.text.slice(0, README_MAX_CHARS)
                  : readme.text,
              );
              states.set(id, "present");
            }

            // Keep lexical search fresh with the fetched README text. FTS has
            // its own copy, so it stays correct even when the README rows are
            // rewritten below (see `markNeedsReembed`).
            const docs = ids.flatMap((id) => {
              const repo = repoById.get(id);

              return repo === undefined
                ? []
                : [
                    {
                      repoId: repo.id,
                      fullName: repo.fullName,
                      description: repo.description,
                      topics: repo.topics,
                      readme: newTexts.get(id) ?? "",
                    },
                  ];
            });

            yield* fts.upsertUserDocs(login, docs).pipe(Effect.orDie);

            // Semantic work is content-hash driven (docs/15 §2.1): only docs
            // whose distilled text changed are re-embedded.
            const dirty = planEmbedWork(repoRows, newTexts, existingHashes);

            // A README row is only written once its vector is durable. Writing
            // it first makes a retry of this step (or the timeout path) see the
            // new text already stored — `planEmbedWork` then reports nothing
            // dirty and the vector is never built.
            const partBase = vectorPartBaseKey(login, plan.runToken, index);

            if (dirty.length === 0) {
              // Every repo in this batch is already published, so there is
              // nothing to embed. (A replayed step whose part was written but
              // whose result was never recorded cannot land here: its rows are
              // `pending`, which `publishedReadmeHash` reports as dirty, so it
              // re-embeds instead of relying on a leftover part.)
              yield* persistReadmes(login, plan.runToken, newTexts, states);

              return {
                ok: true,
                partBase: null,
                embedded: 0,
                error: null,
                rateLimit: null,
                timedOut: false,
              } satisfies BatchOutcome;
            }

            const texts = dirty.flatMap((id) => {
              const repo = repoById.get(id);

              return repo === undefined ? [] : [repoEmbeddingText(repo, newTexts.get(id) ?? "")];
            });

            const vectors = yield* embedder.embed(texts);

            yield* vectorFiles.putPart(partBase, vectors, dirty).pipe(Effect.orDie);
            yield* persistReadmes(login, plan.runToken, newTexts, states);

            return {
              ok: true,
              partBase,
              embedded: dirty.length,
              error: null,
              rateLimit: null,
              timedOut: false,
            } satisfies BatchOutcome;
          }).pipe(
            // Our own ceiling, ahead of the platform's step timeout, *inside*
            // the step: the batch completes with a `timedOut` outcome instead
            // of the platform interrupting it and re-executing the work.
            Effect.timeout(BATCH_TIMEOUT_MS),
            // A failed batch must surface as a state, never fail the run
            // silently: embedding errors degrade, README errors pause. A thrown
            // defect (decode failure, storage error) carries no rate-limit
            // facts, so it can never turn into an unbounded wait.
            Effect.matchEffect({
              onSuccess: (value) => Effect.succeed(value),
              onFailure: (error) =>
                Effect.succeed({
                  ok: false,
                  partBase: null,
                  embedded: 0,
                  error: Predicate.isTagged(error, "TimeoutError")
                    ? `README batch timed out after ${BATCH_TIMEOUT_MS / 60_000} minutes`
                    : String(error),
                  rateLimit: null,
                  timedOut: Predicate.isTagged(error, "TimeoutError"),
                } satisfies BatchOutcome),
            }),
          ),
        );

        const wait = attempt.ok ? null : attempt.rateLimit;

        if (wait === null || wait.waitMs <= 0 || !canWaitAgain(rateLimitWaits)) return attempt;

        logRun("starwatch.sync.refresh.rate-limit", {
          login,
          phase: "fetching-readmes",
          batch: index,
          waitMs: wait.waitMs,
          until: wait.until === null ? null : wait.until.toISOString(),
          reason: wait.reason,
          waits: rateLimitWaits + 1,
        });

        // Same reasoning as the listing: a sleep must not look like a dead run
        // (a retry would terminate a merely waiting instance), and the paused
        // phase is the one the UI already explains as "resumes when the limit
        // resets". Restored right after the wait so the heartbeat resumes.
        yield* patchState(login, {
          phase: "paused",
          lastError: `GitHub rate limit; resuming ${wait.until?.toISOString() ?? "shortly"}`,
        });
        yield* Cloudflare.Workflows.sleep(`rate-limit-${index}-${attempts}`, wait.waitMs);
        yield* patchState(login, { phase: "fetching-readmes", lastError: null });
        rateLimitWaits += 1;
        attempts += 1;
      }
    });

    embeddedTotal += outcome.embedded;

    // A timed-out batch is skipped rather than fatal — but it is *marked*, and
    // the run carries on to the heartbeat below so a long run of skipped
    // batches cannot look like a dead one.
    const skipped = !outcome.ok && outcome.timedOut && timedOutBatches < MAX_TIMED_OUT_BATCHES;

    if (skipped) {
      timedOutBatches += 1;
      logRun("starwatch.sync.refresh.batch-skipped", {
        login,
        phase: "fetching-readmes",
        batch: index,
        skipped: timedOutBatches,
        limit: MAX_TIMED_OUT_BATCHES,
        elapsedMs: elapsedMs(startedAt),
      });

      // The batch may have written some README rows before it was interrupted;
      // those must be re-planned or their vectors never land.
      yield* markNeedsReembed(login, ids);
      logRun("starwatch.sync.refresh.reembed", {
        login,
        phase: "fetching-readmes",
        ids: ids.length,
        batch: index,
        reason: "batch-timeout",
      });
    }

    if (!outcome.ok && !skipped) {
      const wait = outcome.rateLimit;

      // Nothing this run embedded will be published (parts are merged only at
      // finalize), so hand every batch it touched back to the planner.
      const touched = idsThrough(plan.batches, index);

      yield* markNeedsReembed(login, touched);
      logRun("starwatch.sync.refresh.reembed", {
        login,
        phase: "paused",
        ids: touched.length,
        batch: index,
      });

      // Gave up waiting for GitHub: the account is paused with the reset time
      // in `last_error`, so the UI can say when a retry is worth trying
      // (docs/03 §1.3) instead of leaving an active phase behind.
      if (wait !== null) {
        const why =
          wait.reason === "too-many"
            ? `waited ${MAX_RATE_LIMIT_WAITS} times already`
            : "the reset is later than one run may wait";

        logRun("starwatch.sync.refresh.paused", {
          login,
          phase: "paused",
          batch: index,
          reason: wait.reason,
          error: outcome.error ?? null,
          elapsedMs: elapsedMs(startedAt),
        });
        yield* patchState(login, {
          phase: "paused",
          lastError: `${outcome.error ?? "GitHub rate limit"} (${why})`,
        });

        const scratch = partBases.flatMap((base) => [`${base}.bin`, `${base}.ids.json`]);

        if (scratch.length > 0) {
          yield* vectorFiles.deleteMany(scratch).pipe(Effect.ignore);
        }

        return { ok: false, semanticDocs: 0, embedded: embeddedTotal } satisfies StarRefreshResult;
      }

      // Early exit: the parts this run wrote will never be merged, so delete
      // them here rather than leaking ~2 MB per full window per aborted run.
      const scratch = partBases.flatMap((base) => [`${base}.bin`, `${base}.ids.json`]);

      if (scratch.length > 0) {
        yield* vectorFiles.deleteMany(scratch).pipe(Effect.ignore);
      }

      logRun("starwatch.sync.refresh.failed", {
        login,
        phase: "failed",
        batch: index,
        error: outcome.error ?? null,
        elapsedMs: elapsedMs(startedAt),
      });
      yield* markFailed(login, outcome.error ?? "README batch failed");

      return { ok: false, semanticDocs: 0, embedded: embeddedTotal } satisfies StarRefreshResult;
    }

    if (outcome.partBase !== null) partBases.push(outcome.partBase);

    // Heartbeat: the state row is how the client tells "still working" from
    // "died at a platform limit", and it is the only place the README counter
    // can move during the longest phase of the pipeline. One extra statement
    // every few batches keeps the free-tier query budget intact.
    if ((index + 1) % README_PROGRESS_EVERY === 0 || index === plan.batches.length - 1) {
      yield* Cloudflare.Workflows.task(
        `progress-${index}`,
        Effect.gen(function* () {
          const stats = yield* repos.countStats(login).pipe(Effect.orDie);

          yield* patchState(login, {
            phase: "fetching-readmes",
            reposMetadata: stats.reposMetadata,
            readmesFetched: stats.readmesFetched,
          });

          logRun("starwatch.sync.refresh.progress", {
            login,
            phase: "fetching-readmes",
            batch: index + 1,
            batches: plan.batches.length,
            readmesFetched: stats.readmesFetched,
            embedded: embeddedTotal,
            elapsedMs: elapsedMs(startedAt),
          });
        }),
        { retries: { limit: 1, delay: "2 seconds" } },
      );
    }
  }

  // ---- fan-in merge: keep every merge step under the subrequest cap ----
  const intermediateBases: string[] = [];
  let current = partBases;
  let round = 1;

  while (current.length > MERGE_FAN_IN) {
    const groups = chunk(current, MERGE_FAN_IN);
    const next: string[] = [];

    for (let index = 0; index < groups.length; index++) {
      const merged = yield* Cloudflare.Workflows.task(
        `merge-${round}-${index}`,
        mergeParts(login, plan.runToken, round, index, groups[index] ?? []),
      );

      next.push(merged);
    }

    intermediateBases.push(...next);
    current = next;
    round += 1;
  }

  // The final level holds every new vector exactly once: the part bases when
  // no merge ran, otherwise the last merge-intermediate set.
  const sourceBases = current;

  // ---- finalize: overlay existing + new vectors, write the canonical blob
  const finalize = yield* Cloudflare.Workflows.task(
    "finalize",
    Effect.gen(function* () {
      const previous = yield* repos.getIndexState(login).pipe(Effect.orDie);
      const windowSet = new Set(plan.windowIds);

      // Overlay: keep earlier vectors for unchanged window repos, replace
      // with fresh part vectors, drop anything outside the current window.
      const overlay = new Map<number, Float32Array>();
      const existingBytes = yield* vectorFiles.getBytes(vectorBlobBinKey(login)).pipe(Effect.orDie);
      const existingIds = yield* vectorFiles.getIds(vectorIdsKey(login)).pipe(Effect.orDie);

      if (existingBytes !== null && existingIds !== null) {
        const decoded = yield* decodePart(existingBytes);

        if (decoded.length === existingIds.length) {
          for (let i = 0; i < existingIds.length; i++) {
            const id = existingIds[i];
            const vector = decoded[i];

            if (id !== undefined && vector !== undefined && windowSet.has(id))
              overlay.set(id, vector);
          }
        }
      }

      // Final-level bases only; the fan-in merge already collapsed every
      // part exactly once, so this reads ≤MERGE_FAN_IN objects.
      for (const base of sourceBases) {
        const part = yield* readExpectedPart(base);

        for (let i = 0; i < part.ids.length; i++) {
          const id = part.ids[i];
          const vector = part.vectors[i];

          if (id !== undefined && vector !== undefined && windowSet.has(id))
            overlay.set(id, vector);
        }
      }

      const ids = [...overlay.keys()];
      const vectors = ids.map((id) => overlay.get(id)!);
      let semanticDocs = previous?.semanticDocs ?? 0;

      // Rewrite only when there is new material or the existing blob no
      // longer matches the current window set (unstars / window shrink).
      const upToDate =
        existingIds !== null &&
        existingIds.length === ids.length &&
        existingIds.every((id) => overlay.has(id));

      if (sourceBases.length > 0 || !upToDate) {
        if (vectors.length > 0) {
          const bytes = yield* Effect.try({
            try: () => encodeVectors(vectors),
            catch: (cause) => cause,
          }).pipe(Effect.orDie);

          yield* vectorFiles.putBytes(vectorBlobBinKey(login), bytes).pipe(Effect.orDie);
          yield* vectorFiles.putIds(vectorIdsKey(login), ids).pipe(Effect.orDie);
          const dims = vectors[0]?.length ?? 0;

          if (dims > 0) {
            yield* repos.putVectorBlob(login, dims, bytes.byteLength).pipe(Effect.orDie);
          }

          semanticDocs = vectors.length;
        }
      }

      // The blob is durable here, so this is the first moment the vectors can
      // be called published. Flipping the rows afterwards is what makes every
      // abort mode self-healing: whatever still says `pending` is dirty.
      yield* repos.markReadmesPublished(ids, plan.runToken).pipe(Effect.orDie);

      const stats = yield* repos.countStats(login).pipe(Effect.orDie);
      yield* repos
        .upsertIndexState({
          login,
          phase: "ready",
          starsTotal: stats.starsTotal,
          reposMetadata: stats.reposMetadata,
          readmesFetched: stats.readmesFetched,
          semanticDocs,
          lastSyncedAt: previous?.lastSyncedAt ?? null,
          lastError: null,
          updatedAt: nowIso(),
        })
        .pipe(Effect.orDie);

      // The refresh is the account's owner while it runs, and this is the only
      // terminal write: releasing the id here is what lets the next request
      // attach, take over, or start cleanly instead of probing a dead instance.
      yield* repos.setRunInstance(login, null).pipe(Effect.ignore);

      // One R2 delete call for every scratch object (parts + intermediates).
      const scratch = [...partBases, ...intermediateBases].flatMap((base) => [
        `${base}.bin`,
        `${base}.ids.json`,
      ]);

      yield* vectorFiles.deleteMany(scratch).pipe(Effect.orDie);

      return {
        ok: true,
        semanticDocs,
        embedded: embeddedTotal,
        error: null,
      } satisfies FinalizeOutcome;
    }),
    { retries: { limit: 3, delay: "5 seconds" } },
  );

  logRun("starwatch.sync.refresh.done", {
    login,
    phase: "ready",
    semanticDocs: finalize.semanticDocs,
    embedded: finalize.embedded,
    elapsedMs: elapsedMs(startedAt),
  });

  return {
    ok: finalize.ok,
    semanticDocs: finalize.semanticDocs,
    embedded: finalize.embedded,
  } satisfies StarRefreshResult;
});

export class StarRefreshWorkflow extends Cloudflare.Workflow<StarRefreshWorkflow>()(
  "StarRefreshWorkflow",
  // Free per-instance cap is 1,000 steps; a full window budgets 244.
  { limits: { steps: 1_000 } },
  Effect.gen(function* () {
    const deps = yield* SyncDeps;

    return Effect.fn(function* (input: StarRefreshInput) {
      const exit = yield* Effect.exit(refreshBody(input).pipe(Effect.provide(deps.runLayers)));

      if (Exit.isSuccess(exit)) return exit.value;
      logRun("starwatch.sync.refresh.failed", {
        login: input.login,
        phase: "failed",
        reason: "unhandled failure",
      });
      yield* markFailed(input.login, "semantic refresh failed").pipe(
        Effect.provide(deps.runLayers),
        Effect.ignore,
      );

      return { ok: false, semanticDocs: 0, embedded: 0 } satisfies StarRefreshResult;
    });
  }),
) {}

/**
 * Pure step-count budget helper (documented math, exported for tests).
 *
 * Counts the *worst* case, not the happy path: every batch may be attempted
 * once per allowed wait, and a wait is a `sleep` step of its own — the
 * platform counts both, and the earlier version of this helper omitted them.
 * `MAX_RATE_LIMIT_WAITS` is per run, so only that many retries are possible in
 * total, which is what keeps the ceiling far below the 1,000-step cap.
 */
export const refreshStepBudget = (repoCount: number): number => {
  const batches = Math.ceil(Math.max(0, repoCount) / README_FETCH_BATCH);

  if (batches === 0) return 2;

  // Heartbeats: one per `README_PROGRESS_EVERY` batches, plus the final batch.
  const heartbeats =
    Math.floor(batches / README_PROGRESS_EVERY) + (batches % README_PROGRESS_EVERY === 0 ? 0 : 1);

  // Fan-in levels until one base remains; each level costs ⌈n ÷ MERGE_FAN_IN⌉
  // steps (alchemy runs them as one step each).
  let level = batches;
  let merges = 0;

  while (level > MERGE_FAN_IN) {
    level = Math.ceil(level / MERGE_FAN_IN);
    merges += level;
  }

  // The wait budget is per run, so at most `MAX_RATE_LIMIT_WAITS` extra batch
  // attempts exist across the whole run, and each of those waits is itself a
  // `sleep` step: the platform counts both.
  const waitSteps = MAX_RATE_LIMIT_WAITS * 2;

  return 1 + batches + waitSteps + heartbeats + merges + 1;
};
