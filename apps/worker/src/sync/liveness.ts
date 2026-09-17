import type { SyncPhase } from "@starwatch/domain";
import type * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

/**
 * Workflow-instance liveness (docs/08 §2.5).
 *
 * The stored `phase` is a *claim* about background work; the engine knows
 * whether that work still exists. A run can be killed at a platform limit
 * (steps, CPU, abort) or never picked up, and the claim then blocks
 * `POST /sync` with 409 forever — a spinner with no way out.
 *
 * **The owner is recorded, never guessed.** `user_index_state.run_instance_id`
 * (migration 0004) holds the id the handler actually created. Deriving it from
 * a naming convention used to fail in exactly one way: once the fixed id
 * `listing-<login>` was taken by a *terminal* instance still inside its
 * retention window, the run that really owned the account got a timestamped id
 * that nothing could look up — a live run became invisible to both the
 * abandonment check and the dedupe probe. The legacy ids stay in the candidate
 * list so rows written before the migration behave as they did.
 */

/** Instance states that mean a run is in flight (mirrors the engine's list). */
const LIVE_STATUSES: ReadonlyArray<string> = [
  "queued",
  "running",
  "paused",
  "waiting",
  "waitingForPause",
];

export const isLiveWorkflowStatus = (status: string): boolean => LIVE_STATUSES.includes(status);

/**
 * Engine state for one instance: `null` when the instance is gone (or the
 * engine could not be reached — which must not lock a user out of retrying).
 */
export const workflowInstanceStatus = (
  handle: Cloudflare.WorkflowHandle<unknown, unknown>,
  instanceId: string,
): Effect.Effect<string | null> =>
  Effect.gen(function* () {
    const instance = yield* Effect.exit(handle.get(instanceId));

    if (Exit.isFailure(instance)) return null;

    const status = yield* Effect.exit(instance.value.status());

    if (Exit.isFailure(status)) return null;

    return status.value.status;
  }).pipe(Effect.orElseSucceed(() => null));

export const workflowInstanceLive = (
  handle: Cloudflare.WorkflowHandle<unknown, unknown>,
  instanceId: string,
): Effect.Effect<boolean> =>
  workflowInstanceStatus(handle, instanceId).pipe(
    Effect.map((status) => status !== null && isLiveWorkflowStatus(status)),
  );

/** Workflow handles the worker init phase holds on to. */
export interface RunHandles {
  readonly listing: Cloudflare.WorkflowHandle<unknown, unknown>;
  readonly refresh: Cloudflare.WorkflowHandle<unknown, unknown>;
}

/** Where an active phase's run could plausibly live. */
export interface RunCandidates {
  readonly handle: keyof RunHandles;
  readonly id: string;
}

/**
 * Candidate instance ids for an active phase, most authoritative first.
 *
 * The recorded id is probed on **both** handles: deriving the handle from the
 * phase is a guess, and it is wrong for a `paused` row — the listing publishes
 * `paused` while it sleeps out a rate limit just like the refresh does, so a
 * phase-based guess left a paused listing un-terminatable (and a pre-migration
 * paused listing invisible, since only the refresh ids were probed).
 *
 * Legacy ids follow, so rows written before migration 0004 still resolve.
 */
export const runCandidates = (
  login: string,
  phase: SyncPhase,
  recordedId: string | null,
  now: Date = new Date(),
): ReadonlyArray<RunCandidates> => {
  const candidates: Array<RunCandidates> = [];

  if (recordedId !== null && recordedId.length > 0) {
    candidates.push({ handle: "listing", id: recordedId }, { handle: "refresh", id: recordedId });
  }

  candidates.push({ handle: "listing", id: `listing-${login}` });

  // A refresh that started before midnight UTC is still the run behind
  // `fetching-readmes`/`embedding`, so check yesterday's legacy id too.
  const today = now.toISOString().slice(0, 10);
  const yesterday = new Date(now.getTime() - 86_400_000).toISOString().slice(0, 10);

  candidates.push(
    { handle: "refresh", id: `refresh-${login}-${today}` },
    { handle: "refresh", id: `refresh-${login}-${yesterday}` },
  );

  return candidates;
};

/**
 * Engine state for the run that owns an account, whichever workflow it is.
 * The recorded id does not say which handle owns it, and deriving that from a
 * name prefix would reintroduce the guessing this module exists to remove, so
 * both handles are probed. Only used on the attach path.
 */
export const ownerRunState = (
  handles: RunHandles,
  ownerId: string,
): Effect.Effect<ActiveRunState> =>
  Effect.gen(function* () {
    for (const handle of [handles.listing, handles.refresh]) {
      const status = yield* workflowInstanceStatus(handle, ownerId);

      if (status !== null && isLiveWorkflowStatus(status)) {
        return { live: true, status, instanceId: ownerId };
      }
    }

    return { live: false, status: null, instanceId: null };
  });

/** What the engine says about the run behind a phase. */
export interface ActiveRunState {
  readonly live: boolean;
  /** Engine status of the live instance (`queued`, `running`, …), else `null`. */
  readonly status: string | null;
  readonly instanceId: string | null;
}

/** Resolve the run behind an active phase: recorded id first, then legacy ids. */
export const activeRunState = (
  handles: RunHandles,
  login: string,
  phase: SyncPhase,
  recordedId: string | null,
  now: Date = new Date(),
): Effect.Effect<ActiveRunState> =>
  Effect.gen(function* () {
    for (const candidate of runCandidates(login, phase, recordedId, now)) {
      const status = yield* workflowInstanceStatus(handles[candidate.handle], candidate.id);

      if (status !== null && isLiveWorkflowStatus(status)) {
        return { live: true, status, instanceId: candidate.id };
      }
    }

    return { live: false, status: null, instanceId: null };
  });

/**
 * Terminate the instances that could own this active phase. Only used once a
 * run has provably stopped progressing: a stuck instance keeps its id, so a
 * replacement would queue behind work that never resumes. Best-effort — a
 * missing or already-finished instance is fine.
 */
export const terminateActiveRuns = (
  handles: RunHandles,
  login: string,
  phase: SyncPhase,
  recordedId: string | null,
  now: Date = new Date(),
): Effect.Effect<ReadonlyArray<string>> =>
  Effect.gen(function* () {
    const terminated: Array<string> = [];

    for (const candidate of runCandidates(login, phase, recordedId, now)) {
      const instance = yield* Effect.exit(handles[candidate.handle].get(candidate.id));

      if (Exit.isFailure(instance)) continue;

      const done = yield* Effect.exit(instance.value.terminate());

      if (Exit.isSuccess(done)) terminated.push(candidate.id);
    }

    return terminated;
  });
