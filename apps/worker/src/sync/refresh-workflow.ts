import { GithubRateLimited, GithubUpstream, SEMANTIC_WINDOW } from "@starwatch/domain";
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
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Predicate from "effect/Predicate";
import { SyncDeps } from "../deps.ts";
import { MERGE_FAN_IN, README_FETCH_BATCH, README_PROGRESS_EVERY } from "../constants.ts";
import { workflowInstanceLive } from "./liveness.ts";
import { elapsedMs, logError, logRun } from "./log.ts";
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
 * Tier 1 refresh: fetch changed READMEs for the newest `SEMANTIC_WINDOW`
 * repos, embed the dirty subset, and rewrite the per-user R2 vector blob
 * (docs/15 §2).
 *
 * Two modes, chosen once per run from `STARWATCH_SEMANTIC_SEARCH`:
 *   * **on** — everything below.
 *   * **off** — the README fetch and the FTS upsert still run, because README
 *     text is keyword-search material; every embedding, vector part, merge,
 *     blob write and `markReadmesPublished` is skipped. A row whose text was
 *     re-read stays `pending` (vector unpublished) so the next on-deployment
 *     re-embeds exactly what changed meanwhile, and the R2 objects and the
 *     stored `semantic_docs` are left exactly as the last on-run wrote them.
 *
 * **One run, many instances.** The free plan caps external subrequests per
 * Workflow *instance* at 50 (docs/13 §2), and the cap counts per instance, not
 * per invocation: it does not reset on `sleep`, and `limits.subrequests` is a
 * paid-plan setting. One batch can spend `README_FETCH_BATCH` (8) × 6 (five raw
 * candidates plus the REST fallback per repo) = 48, so a single batch is the
 * largest slice that provably fits. A run is therefore a chain: the first
 * instance plans it ({@link StarRefreshRun}) and executes the first slice, each
 * later instance executes {@link README_BATCHES_PER_INSTANCE} more and starts
 * its successor, and the instance that finds nothing left merges the run's parts
 * and finalizes it. The plan travels with the chain, so no slice re-plans — and
 * no slice sees its own `pending` writes reshuffle the work.
 *
 * Free-tier budget per instance (docs/13 §1):
 *   * external subrequests ≤ 50 → one batch: 8 × 6 = 48 worst case, see above.
 *     D1 and R2 calls are Cloudflare-service subrequests, budgeted separately.
 *   * D1 queries ≤ 50 → per 8-repo batch: 1 `getRepos` + 1 `getReadmeTexts`
 *     + 8 `putReadme` + ≤6 FTS upsert statements ≈ 16.
 *   * AI: one `embed` call per non-empty batch (≤32 texts, one subrequest).
 *   * R2: 2 puts per batch (part `.bin` + `.ids.json`).
 *
 * Step count: one instance is `1 plan + 1 batch + 1 hand-off`, plus a heartbeat
 * in every fourth instance and up to 4 wait steps if GitHub limits the run — 8
 * at worst, against the 1,024-step cap ({@link refreshSliceStepBudget}); a full
 * 1,500-repo window is 188 instances plus the run's waits, its 47 heartbeats and
 * the final instance's 5 fan-in merges ({@link refreshChainStepBudget}). A batch
 * that hits a GitHub limit retries in place after a bounded wait (docs/03 §1.3):
 * the wait is one `step.sleep` (2 steps per retry with the attempt), and a batch
 * that hits our own ceiling is skipped rather than retried, so its step is
 * counted once.
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
  /**
   * The run this instance is a slice of. Absent on the first instance of a
   * chain — the one that plans — present on every other (see
   * {@link StarRefreshRun}).
   */
  readonly run?: StarRefreshRun;
}

/**
 * One tier-1 run, carried by the chain of instances that executes it.
 *
 * The first instance plans the run and starts a successor with this value when
 * batches are left; each successor runs its slice and hands the remainder on.
 * Carrying the plan, instead of letting every slice re-plan from D1, is what
 * keeps the chain on one set of batches: a slice's own writes flip rows to
 * `pending` — which the planner reads as work — so a chain that re-planned would
 * have to assume its second reading of D1 agreed with its first.
 */
export interface StarRefreshRun {
  /** Every batch of the run, in plan order; the first `done` are already run. */
  readonly batches: ReadonlyArray<ReadonlyArray<number>>;
  /**
   * R2 scratch namespace and instance-id stem for the whole chain, minted by the
   * first instance (`runTokenOf`) and carried from there.
   */
  readonly runToken: string;
  /** Batches earlier instances of the chain have executed. */
  readonly done: number;
  /** The run's semantic window (`plan.windowIds`); read by the final instance. */
  readonly windowIds: ReadonlyArray<number>;
  /** Account vectors published before this run (semantic dirty check). */
  readonly publishedIds: ReadonlyArray<number>;
  /**
   * Resolved once, by the run's first instance: a redeploy that flips
   * `STARWATCH_SEMANTIC_SEARCH` mid-chain must not make a later slice embed (or
   * skip) work the run's own finalize disagrees with.
   */
  readonly semantic: boolean;
  /**
   * Run-wide counters. They bound the *run*, not the instance (`MAX_RATE_LIMIT_WAITS`,
   * `MAX_TIMED_OUT_BATCHES`, `MAX_UNAVAILABLE_READMES`), so every slice inherits
   * them and hands them back. A chain that reset them per instance would let a
   * rate-limited or unreachable GitHub be waited on — or silently tolerated —
   * once per batch and still call the run finished.
   */
  readonly waits: number;
  readonly timedOutBatches: number;
  readonly unavailable: number;
  /** The first dropped connection, kept for the failure message. */
  readonly unavailableError: string | null;
  /** Vectors this run embedded so far, across its slices. */
  readonly embedded: number;
  /**
   * Part bases earlier instances wrote, for the final merge. Empty with
   * semantic search off — off batches write no parts — and carried regardless:
   * a flag flipped mid-chain can leave parts from the instance that planned it.
   */
  readonly partBases: ReadonlyArray<string>;
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
  /**
   * Repos this batch could not read at all because the connection dropped.
   * They are marked for a later run (see `markNeedsReembed`) while the rest of
   * the batch proceeds.
   */
  readonly unavailable: ReadonlyArray<number>;
  /**
   * The first dropped connection of the batch, as the client described it. A
   * count alone cannot tell a flaky CDN edge from a blocked egress, and this is
   * the only place that fact survives into the account's `last_error`.
   */
  readonly unavailableError: string | null;
}

/** The rate-limit error behind a batch failure, if that is what it was. */
const rateLimitOf = (error: GithubClientError): GithubRateLimited | null =>
  error instanceof GithubRateLimited ? error : null;

/**
 * The dropped connection behind a batch failure, if that is what it was.
 *
 * The client reports "we never reached GitHub" as `GithubUpstream` with
 * `status: 0` — a transport error or its own 20 s request timeout. It is the
 * one failure that says nothing about the repo: a 404 means there is no
 * README, a 403 means we are being limited, but a dropped connection is this
 * request, this pool, this CDN edge. A *per-repo* failure, so the batch keeps
 * the other seven READMEs and the repo is re-checked next run.
 */
const transportOf = (error: GithubClientError): GithubUpstream | null =>
  error instanceof GithubUpstream && error.status === 0 ? error : null;

/** Exported for tests: is this fetch failure the repo's problem or the link's? */
export const isPerRepoReadmeFailure = (error: GithubClientError): boolean =>
  transportOf(error) !== null;

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

/**
 * README fetches one run may lose to dropped connections before it calls the
 * dependency gone — the per-repo counterpart of {@link MAX_TIMED_OUT_BATCHES}.
 * A handful of flakes costs a re-check on the next run; *every* fetch failing
 * means raw/API GitHub is unreachable from this deployment, and a `ready`
 * index that was never refreshed is worse than a failed run that says so.
 */
const MAX_UNAVAILABLE_READMES = 8;

/**
 * README batches one refresh instance runs.
 *
 * The free plan caps external subrequests **per Workflow instance** at 50, and
 * that cap is not per invocation: sleeping does not reset it, and
 * `limits.subrequests` is a paid-plan setting (docs/13 §2). One batch can spend
 * `README_FETCH_BATCH` (8) × 6 (five raw candidates plus the REST fallback per
 * repo) = 48, so a batch is the largest slice that provably fits. Raising this
 * means shrinking the per-repo request count first — the slice, not the batch,
 * is what the cap really bounds.
 *
 * It must stay ≥ 1: the hand-off cursor advances by one slice, so a zero-length
 * slice would make the chain start itself forever (asserted in the budget test).
 */
export const README_BATCHES_PER_INSTANCE = 1;

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
 * This workflow's own handle, filled in by the worker once the class is
 * resolved.
 *
 * The chain starts its own successor, so the body needs the handle of the
 * workflow it runs inside. A class cannot resolve itself — the runtime hands it
 * the handle through `WorkflowScope`, whose service type is *not* part of
 * `WorkflowServices`, so requiring it there leaks into the stack's own
 * requirements — and a sibling class cannot express it either: each would need
 * the other's handle at init. The worker already resolves this handle, so it
 * passes it back through a deferred that the body awaits as it runs.
 */
export class RefreshSelf extends Context.Service<
  RefreshSelf,
  Deferred.Deferred<Cloudflare.WorkflowHandle<StarRefreshInput, StarRefreshResult>>
>()("starwatch/RefreshSelf") {}

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
 * Instance id for the slice that starts at batch `done`.
 *
 * Deterministic, so a replayed hand-off finds the instance it already created
 * instead of starting a second chain (see the hand-off: `create` + liveness
 * probe). The token is cut to 36 characters — enough for a UUID — so the id
 * stays inside the 100-character limit with a maximum-length login (39) in
 * front.
 */
export const refreshSliceId = (login: string, runToken: string, done: number): string =>
  `refresh-${login}-${runToken.slice(0, 36)}-b${done}`;

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
  Effect.gen(function* () {
    const repos = yield* RepoStore;

    yield* patchState(login, { phase: "failed", lastError: message });
    // Terminal: release the account's owner record. `claimRunInstance` is a
    // conditional UPDATE on that column, so a dead run that keeps its id makes
    // every later `POST /sync` lose the claim and strands the account in an
    // active phase nothing owns.
    yield* repos.setRunInstance(login, null).pipe(Effect.ignore);
  });

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
 * them (and re-embeds them when semantic search is on).
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

const refreshBody = Effect.fn("StarRefreshWorkflow.body")(function* (
  input: StarRefreshInput,
  semanticSearch: boolean,
  self: Cloudflare.WorkflowHandle,
) {
  const startedAt = Date.now();
  const login = input.login;
  const repos = yield* RepoStore;
  const fts = yield* UserFts;
  const github = yield* GithubClient;
  const embedder = yield* Embedder;
  const vectorFiles = yield* VectorBlobFiles;

  // ---- plan (first instance) or carried plan (every later slice) --------
  const planRun: Effect.Effect<StarRefreshRun, never, RepoStore | VectorBlobFiles> = Effect.gen(
    function* () {
      const all = yield* repos.listReposForSearch(login, {}).pipe(Effect.orDie);
      const states: ReadmeStateMap = yield* repos.getReadmeStates(login).pipe(Effect.orDie);

      // The vectors belong to *this* account while README rows are shared, so
      // the plan needs the account's published ids: a window repo missing from
      // them is embed work even when its README is current. `null` (no blob
      // yet) becomes an empty set and every window repo is planned. With
      // semantic search off the sidecar is not consulted at all — that R2 read
      // is the first thing the flag must remove.
      const publishedIds = semanticSearch
        ? ((yield* vectorFiles.getIds(vectorIdsKey(login)).pipe(Effect.orDie)) ?? [])
        : [];

      const batches = planReadmeWork(all, states, {
        batchSize: README_FETCH_BATCH,
        existingVectorIds: semanticSearch ? new Set(publishedIds) : undefined,
      });

      // The window only bounds vector storage; with nothing to embed it is not
      // computed, and finalize's overlay never runs.
      const windowIds = semanticSearch ? all.slice(0, SEMANTIC_WINDOW).map((repo) => repo.id) : [];

      // Minted inside the memoized plan so every replay of this instance files
      // its scratch objects under one token (see `vectorPartBaseKey`). The mode
      // rides along for the same reason: later steps read `plan.semantic`, so a
      // redeploy that flips the flag mid-run cannot make a step disagree with
      // the plan it replays.
      return {
        batches,
        done: 0,
        windowIds,
        publishedIds,
        runToken: runTokenOf(input),
        semantic: semanticSearch,
        waits: 0,
        timedOutBatches: 0,
        unavailable: 0,
        unavailableError: null,
        embedded: 0,
        partBases: [],
      } satisfies StarRefreshRun;
    },
  );

  // Only the first instance plans; the rest were handed a run by their
  // predecessor, and reading D1 again could only disagree with it.
  const plan =
    input.run ??
    (yield* Cloudflare.Workflows.task("plan", planRun, {
      retries: { limit: 2, delay: "5 seconds" },
    }));

  // The mode this run executes with, as resolved by its own plan step.
  const semantic = plan.semantic;

  // ---- this instance's slice of the run ---------------------------------
  const from = Math.min(plan.done, plan.batches.length);
  const through = Math.min(from + README_BATCHES_PER_INSTANCE, plan.batches.length);

  logRun("starwatch.sync.refresh.start", {
    login,
    phase: "fetching-readmes",
    semantic,
    batch: from,
    batches: plan.batches.length,
    window: plan.windowIds.length,
    runToken: plan.runToken,
  });

  // ---- per-batch README fetch + embed + part write ----------------------
  const partBases: string[] = [];
  // Each of these is run-wide, so it starts from what earlier slices spent or
  // lost (see `StarRefreshRun`).
  let embeddedTotal = plan.embedded;
  let timedOutBatches = plan.timedOutBatches;
  // Repos lost to dropped connections: bounded by `MAX_UNAVAILABLE_READMES` so a
  // dead dependency cannot masquerade as a few unlucky requests (see the skip
  // site in the batch).
  let unavailableTotal = plan.unavailable;
  // The first dropped connection of the run, kept for the failure message: a
  // count says the run lost repos, the message says to what.
  let unavailableError: string | null = plan.unavailableError;
  // Run-wide wait budget (docs/03 §1.3): `MAX_RATE_LIMIT_WAITS` is a bound on
  // the *run*, not per batch, so a systemic limit stops the run after two
  // bounded waits instead of 188 × 2 × 15 minutes of sleeping.
  let rateLimitWaits = plan.waits;

  /**
   * Terminal failure for a batch: nothing this run wrote will be published, so
   * hand every batch it touched back to the planner, drop the scratch parts and
   * settle the row. Skipped/unavailable repos are covered by `idsThrough`,
   * which is exactly what a later run needs to re-plan.
   */
  const abortRun = (
    reason: string,
    throughIndex: number,
  ): Effect.Effect<StarRefreshResult, never, RepoStore | VectorBlobFiles> =>
    Effect.gen(function* () {
      const touched = idsThrough(plan.batches, throughIndex);

      yield* markNeedsReembed(login, touched);
      logError("starwatch.sync.refresh.reembed", {
        login,
        phase: "failed",
        ids: touched.length,
        batch: throughIndex,
      });

      // Early exit: the parts this run wrote will never be merged, so delete
      // them here rather than leaking ~2 MB per full window per aborted run.
      // Earlier slices' parts are in `plan.partBases` and are this run's too.
      const scratch = [...plan.partBases, ...partBases].flatMap((base) => [
        `${base}.bin`,
        `${base}.ids.json`,
      ]);

      if (scratch.length > 0) {
        yield* vectorFiles.deleteMany(scratch).pipe(Effect.ignore);
      }

      logError("starwatch.sync.refresh.failed", {
        login,
        phase: "failed",
        batch: throughIndex,
        error: reason,
        elapsedMs: elapsedMs(startedAt),
      });
      yield* markFailed(login, reason);

      return { ok: false, semanticDocs: 0, embedded: embeddedTotal } satisfies StarRefreshResult;
    });

  for (let index = from; index < through; index++) {
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
            const existingHashes = new Map<number, string>();

            // The published-hash comparison exists only to decide re-embedding;
            // with semantic search off the plan carries no published ids and
            // nothing below this step is embedded.
            if (semantic) {
              const publishedSet = new Set(plan.publishedIds);

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
            }

            const newTexts = new Map<number, string>();
            const states = new Map<number, "present" | "missing">();
            /** Repos whose text this attempt actually re-read from GitHub. */
            const refetched = new Set<number>();
            /** Repos a dropped connection kept this attempt from reading. */
            const unavailable: number[] = [];
            let unavailableError: string | null = null;

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

                // A dropped connection is a property of the request, not of the
                // repo: GitHub's raw CDN closes pooled connections, and the
                // next run re-reads the text from scratch. Skipping just this
                // repo keeps the other seven READMEs of the batch, and the
                // `error` state is already the one that makes a repo
                // selectable again (`needsReadmeFetch`). Anything else — a rate
                // limit we can wait out, a 5xx, a decode failure — is an answer
                // about the whole batch and still fails it.
                if (limited === null && transportOf(fetched.error) !== null) {
                  unavailable.push(id);

                  if (unavailableError === null) {
                    unavailableError = describeGithubError(fetched.error);
                  }

                  continue;
                }

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
                  unavailable: [],
                  unavailableError: null,
                } satisfies BatchOutcome;
              }

              const readme = fetched.value;

              refetched.add(id);

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

            // Semantic off: the fetch + FTS half is the whole batch. Only the
            // rows this attempt re-read are written, and they stay `pending`
            // (text stored, vector unpublished) so the next on-deployment
            // re-embeds exactly the text that changed meanwhile. Rewriting
            // untouched rows would demote every published hash to dirty and
            // turn a flag flip into a full re-embed.
            if (!semantic) {
              // A batch that re-read nothing changes nothing: the stored text
              // was already upserted when it was written, and `pending` rows
              // are re-planned until the flag returns, so rewriting FTS for
              // them on every daily run would be pure write cost.
              if (refetched.size > 0) {
                yield* fts.upsertUserDocs(login, docs).pipe(Effect.orDie);
              }

              yield* persistReadmes(
                login,
                plan.runToken,
                newTexts,
                new Map([...states].filter(([id]) => refetched.has(id))),
              );

              return {
                ok: true,
                partBase: null,
                embedded: 0,
                error: null,
                rateLimit: null,
                timedOut: false,
                unavailable,
                unavailableError,
              } satisfies BatchOutcome;
            }

            // Keep lexical search fresh with the fetched README text. FTS has
            // its own copy, so it stays correct even when the README rows are
            // rewritten below (see `markNeedsReembed`).
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
                unavailable,
                unavailableError,
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
              unavailable,
              unavailableError,
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
                  unavailable: [],
                  unavailableError: null,
                } satisfies BatchOutcome),
            }),
          ),
        );

        const wait = attempt.ok ? null : attempt.rateLimit;

        if (wait === null || wait.waitMs <= 0 || !canWaitAgain(rateLimitWaits)) return attempt;

        logError("starwatch.sync.refresh.rate-limit", {
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

    // Repos the batch could not read at all. Marked `error` so a later run
    // re-plans them (`needsReadmeFetch`) and counted run-wide: a run that keeps
    // losing *every* connection is not unlucky, it is unrefreshed, and it must
    // fail rather than publish a "ready" index nobody re-checked.
    if (outcome.unavailable.length > 0) {
      unavailableTotal += outcome.unavailable.length;

      if (unavailableError === null) unavailableError = outcome.unavailableError;

      yield* markNeedsReembed(login, outcome.unavailable);
      logError("starwatch.sync.refresh.readme-unavailable", {
        login,
        phase: "fetching-readmes",
        batch: index,
        repos: outcome.unavailable.length,
        total: unavailableTotal,
        limit: MAX_UNAVAILABLE_READMES,
        error: outcome.unavailableError,
      });

      if (unavailableTotal > MAX_UNAVAILABLE_READMES) {
        return yield* abortRun(
          `GitHub README fetches kept dropping (${unavailableTotal} repos: ${unavailableError ?? "unknown"})`,
          index,
        );
      }
    }

    // A timed-out batch is skipped rather than fatal — but it is *marked*, and
    // the run carries on to the heartbeat below so a long run of skipped
    // batches cannot look like a dead one.
    const skipped = !outcome.ok && outcome.timedOut && timedOutBatches < MAX_TIMED_OUT_BATCHES;

    if (skipped) {
      timedOutBatches += 1;
      logError("starwatch.sync.refresh.batch-skipped", {
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
      logError("starwatch.sync.refresh.reembed", {
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
      logError("starwatch.sync.refresh.reembed", {
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

        logError("starwatch.sync.refresh.paused", {
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
        // Terminal — this run gives up rather than waiting, so it must not keep
        // the account's owner record (see `markFailed`).
        yield* repos.setRunInstance(login, null).pipe(Effect.ignore);

        const scratch = partBases.flatMap((base) => [`${base}.bin`, `${base}.ids.json`]);

        if (scratch.length > 0) {
          yield* vectorFiles.deleteMany(scratch).pipe(Effect.ignore);
        }

        return { ok: false, semanticDocs: 0, embedded: embeddedTotal } satisfies StarRefreshResult;
      }

      return yield* abortRun(outcome.error ?? "README batch failed", index);
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

  // ---- chain: hand the rest of the run to the next instance -------------
  // One instance cannot finish a run: the free plan caps external subrequests
  // per instance at 50 and a batch may spend 48 (see the header). When batches
  // are left, this instance starts its successor with the plan, the cursor and
  // the run-wide counters, and stops. The successor is the account's owner from
  // then on; the instance that finds nothing left runs the merge and finalize
  // below.
  if (through < plan.batches.length) {
    const nextId = refreshSliceId(login, plan.runToken, through);

    const next: StarRefreshRun = {
      ...plan,
      done: through,
      waits: rateLimitWaits,
      timedOutBatches,
      unavailable: unavailableTotal,
      unavailableError,
      embedded: embeddedTotal,
      partBases: [...plan.partBases, ...partBases],
    };

    const handedOff = yield* Cloudflare.Workflows.task(
      `handoff-${through}`,
      Effect.gen(function* () {
        const created = yield* Effect.exit(
          self.create({ id: nextId, params: { login, run: next } satisfies StarRefreshInput }),
        );

        // A create that lost a race with an existing id is not a failure: the
        // instance this hand-off needs is already there. A replayed hand-off
        // (deterministic id) lands here, which is what makes the step safe.
        if (Exit.isSuccess(created)) return true;

        return yield* workflowInstanceLive(self, nextId);
      }),
    );

    if (!handedOff) {
      return yield* abortRun(`The indexing queue rejected the next slice (${nextId})`, through - 1);
    }

    // Ownership moves with the work. The recorded id is what the attach path
    // probes, so a chain that kept naming a finished instance would look
    // abandoned — and an abandoned `fetching-readmes` account invites a takeover
    // of a run that is still fetching.
    yield* repos.setRunInstance(login, nextId).pipe(Effect.orDie);

    logRun("starwatch.sync.refresh.chained", {
      login,
      phase: "fetching-readmes",
      batch: through,
      batches: plan.batches.length,
      next: nextId,
      elapsedMs: elapsedMs(startedAt),
    });

    return { ok: true, semanticDocs: 0, embedded: embeddedTotal } satisfies StarRefreshResult;
  }

  // ---- fan-in merge: keep every merge step under the subrequest cap ----
  // With semantic search off no batch produced a part, so this loop and the
  // overlay below have nothing to merge.
  const intermediateBases: string[] = [];
  // Earlier slices' parts come first: the run's parts are all one level, and
  // only this final instance merges them.
  let current = [...plan.partBases, ...partBases];
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

      // Semantic off: a state-only terminal write. No R2 read, no blob rewrite,
      // no `markReadmesPublished` — whatever the last on-run published stays
      // published, and rows written `pending` here wait for the flag to return.
      // The stored `semantic_docs` is carried through, never zeroed, so turning
      // semantic search back on finds the real count and the same blobs.
      if (!semantic) {
        const stats = yield* repos.countStats(login).pipe(Effect.orDie);

        yield* repos
          .upsertIndexState({
            login,
            phase: "ready",
            starsTotal: stats.starsTotal,
            reposMetadata: stats.reposMetadata,
            readmesFetched: stats.readmesFetched,
            semanticDocs: previous?.semanticDocs ?? 0,
            lastSyncedAt: previous?.lastSyncedAt ?? null,
            lastError: null,
            updatedAt: nowIso(),
          })
          .pipe(Effect.orDie);

        // Same single terminal write as the on path: releasing the instance id
        // is what lets the next request attach, take over, or start cleanly.
        yield* repos.setRunInstance(login, null).pipe(Effect.ignore);

        // Off batches write no parts, so this is empty on a run that was off
        // from its plan onwards. It is not *always* empty: an instance whose
        // plan ran while the flag was on can still have run-scoped parts on
        // disk, and nothing else would ever collect them.
        const scratch = [...plan.partBases, ...partBases, ...intermediateBases].flatMap((base) => [
          `${base}.bin`,
          `${base}.ids.json`,
        ]);

        if (scratch.length > 0) {
          yield* vectorFiles.deleteMany(scratch).pipe(Effect.ignore);
        }

        return {
          ok: true,
          semanticDocs: previous?.semanticDocs ?? 0,
          embedded: 0,
          error: null,
        } satisfies FinalizeOutcome;
      }

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
      const scratch = [...plan.partBases, ...partBases, ...intermediateBases].flatMap((base) => [
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
    semantic,
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
  // Free per-instance cap is 1,024 steps; one slice budgets 8.
  { limits: { steps: 1_000 } },
  Effect.gen(function* () {
    const deps = yield* SyncDeps;
    const selfHandle = yield* RefreshSelf;

    return Effect.fn(function* (input: StarRefreshInput) {
      // Resolved by the worker right after this class was created; the body runs
      // strictly later, once per instance, which is what makes this await safe.
      const self = yield* Deferred.await(selfHandle);

      // The flag is read once per isolate here; the body records the resolved
      // mode in its memoized plan step, and every later step reads that plan
      // value, so a redeploy mid-run cannot make a step disagree with the plan
      // it replays. Chained instances carry the value on (see `StarRefreshRun`).
      const exit = yield* Effect.exit(
        refreshBody(input, deps.semanticSearch, self).pipe(Effect.provide(deps.runLayers)),
      );

      if (Exit.isSuccess(exit)) return exit.value;
      logError("starwatch.sync.refresh.failed", {
        login: input.login,
        phase: "failed",
        reason: "unhandled failure",
      });
      yield* markFailed(input.login, "index refresh failed").pipe(
        Effect.provide(deps.runLayers),
        Effect.ignore,
      );

      return { ok: false, semanticDocs: 0, embedded: 0 } satisfies StarRefreshResult;
    });
  }),
) {}

/**
 * Steps one refresh instance spends on a slice of `sliceBatches` batches, worst
 * case: the plan (or the carried plan), the batches, the run's remaining
 * rate-limit waits (`sleep` + attempt), and the hand-off (or the finalize) that
 * closes the instance. A heartbeat lands in every fourth instance of a chain and
 * is counted there by {@link refreshChainStepBudget}, not per slice.
 *
 * Exported for tests: the per-instance ceiling (1,024 steps on the free plan)
 * is what makes the slice size a correctness constraint rather than a tuning
 * knob.
 */
export const refreshSliceStepBudget = (
  sliceBatches: number,
  waits: number = MAX_RATE_LIMIT_WAITS * 2,
): number => 1 + sliceBatches + waits + 1;

/** Fan-in merge steps for `parts` parts: one per group, level by level. */
const mergeSteps = (parts: number): number => {
  let level = parts;
  let merges = 0;

  while (level > MERGE_FAN_IN) {
    level = Math.ceil(level / MERGE_FAN_IN);
    merges += level;
  }

  return merges;
};

/**
 * Steps a whole chained run over `repoCount` repos spends, across its instances:
 * every slice, the run's rate-limit waits once, and the final instance's fan-in
 * merges. The free plan counts steps per day (docs/13 §2), so this is the number
 * that decides how many accounts a day the deployment can index.
 */
export const refreshChainStepBudget = (repoCount: number): number => {
  const batches = Math.ceil(Math.max(0, repoCount) / README_FETCH_BATCH);

  if (batches === 0) return refreshSliceStepBudget(0, 0);

  const instances = Math.ceil(batches / README_BATCHES_PER_INSTANCE);
  const slice = refreshSliceStepBudget(README_BATCHES_PER_INSTANCE, 0);

  const heartbeats =
    Math.floor(batches / README_PROGRESS_EVERY) + (batches % README_PROGRESS_EVERY === 0 ? 0 : 1);

  return instances * slice + MAX_RATE_LIMIT_WAITS * 2 + heartbeats + mergeSteps(batches);
};
