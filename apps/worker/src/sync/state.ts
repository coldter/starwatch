import type { SyncPhase, UserIndexState } from "@starwatch/domain";
import type { GithubClientError } from "@starwatch/core/sync";
import { RepoStore } from "@starwatch/cloudflare/storage";
import * as Effect from "effect/Effect";
import * as Match from "effect/Match";

/**
 * How long an active phase may go without a state write before the run counts
 * as abandoned. Every active-phase writer heartbeats (listing: per page,
 * refresh: per README batch), so a quiet row means the workflow is gone —
 * killed at a platform limit, aborted, or never picked up.
 */
export const STALE_RUN_MS = 5 * 60_000;

/**
 * Is an active phase actually being worked on? `live` comes from the workflow
 * engine (`listing` / `refresh` instance status), the age from `updatedAt`.
 *
 * Only an abandoned run may be restarted — otherwise a healthy run's progress
 * would be thrown away by a second one racing it.
 */
export const isRunAbandoned = (
  state: Pick<UserIndexState, "phase" | "updatedAt">,
  live: boolean,
  now: number = Date.now(),
): boolean => {
  if (live) return false;

  const stamp = Date.parse(state.updatedAt);

  // An unreadable stamp is not evidence of abandonment.
  if (Number.isNaN(stamp)) return false;

  return now - stamp > STALE_RUN_MS;
};

/**
 * How long a *live* instance may go without a heartbeat before it counts as
 * stuck inside a step.
 *
 * Must stay comfortably above `MAX_RATE_LIMIT_WAIT_MS` (15 min): a run sleeping
 * out a GitHub rate limit publishes `paused` and then writes nothing for as
 * long as that wait, and the engine still reports it as `running`. A threshold
 * equal to the wait would terminate exactly the instance the paused phase
 * exists to protect. Every *other* silence is bounded by a 20–60 s request
 * ceiling or the 3-min batch ceiling, so 20 min leaves margin on both sides.
 */
export const STUCK_LIVE_RUN_MS = 20 * 60_000;

/** A run the engine reports as live, but which has stopped making progress. */
export const isRunStuck = (
  state: Pick<UserIndexState, "phase" | "updatedAt">,
  live: boolean,
  now: number = Date.now(),
): boolean => {
  if (!live) return false;

  const stamp = Date.parse(state.updatedAt);

  if (Number.isNaN(stamp)) return false;

  return now - stamp > STUCK_LIVE_RUN_MS;
};

/** Single ISO-8601 clock for workflow writes. */
export const nowIso = (): string => new Date().toISOString();

/** Readable one-liner for any GitHub client failure (state `last_error`). */
export const describeGithubError = (error: GithubClientError): string =>
  Match.value(error).pipe(
    Match.tagsExhaustive({
      GithubRateLimited: (error) => `GitHub rate limit (reset ${error.resetAt ?? "unknown"})`,
      // Status 0 is "we never reached GitHub" (no token, timeout); the message
      // already says which, so do not wrap it in a fake HTTP status.
      GithubUpstream: (error) =>
        error.status === 0
          ? error.message
          : `GitHub upstream error ${error.status}: ${error.message}`,
      UserNotFound: (error) => `GitHub user ${error.login} not found`,
    }),
  );

export interface StatePatch {
  readonly phase: SyncPhase;
  readonly lastError?: string | null;
  readonly lastSyncedAt?: string | null;
  readonly starsTotal?: number;
  readonly reposMetadata?: number;
  readonly readmesFetched?: number;
  readonly semanticDocs?: number;
}

/**
 * Merge a patch into `user_index_state`, creating the row when absent.
 * Reads the previous row first so callers never have to thread counters
 * through workflow steps. Storage failures are defects (workflow retries).
 */
export const patchState = (
  login: string,
  patch: StatePatch,
): Effect.Effect<void, never, RepoStore> =>
  Effect.gen(function* () {
    const repos = yield* RepoStore;
    const previous = yield* repos.getIndexState(login).pipe(Effect.orDie);
    yield* repos
      .upsertIndexState({
        login,
        phase: patch.phase,
        starsTotal: patch.starsTotal ?? previous?.starsTotal ?? 0,
        reposMetadata: patch.reposMetadata ?? previous?.reposMetadata ?? 0,
        readmesFetched: patch.readmesFetched ?? previous?.readmesFetched ?? 0,
        semanticDocs: patch.semanticDocs ?? previous?.semanticDocs ?? 0,
        lastSyncedAt:
          patch.lastSyncedAt !== undefined ? patch.lastSyncedAt : (previous?.lastSyncedAt ?? null),
        lastError: patch.lastError ?? null,
        updatedAt: nowIso(),
      })
      .pipe(Effect.orDie);
  });

/**
 * Did the previous attempt fail to *finish*? A `ready`/`idle` row is a settled
 * index; anything else — active, `paused`, `failed` — means a run took the
 * 24-hour window without producing one. Blocking those for a day turns a
 * transient GitHub limit into a day-long outage, so the start handler exempts
 * them, and the WebUI mirrors this exact rule when it greys out the buttons.
 */
export const isRunIncomplete = (state: Pick<UserIndexState, "phase"> | null): boolean =>
  state !== null && state.phase !== "ready" && state.phase !== "idle";

/**
 * May a request take the account away from the run the engine reports?
 *
 * Only two ways: the engine no longer has that run (`!live` — killed at a
 * platform limit, or never picked up), or the run is `running` but has stopped
 * heartbeating past `STUCK_LIVE_RUN_MS`. A `queued` instance is deliberately
 * *not* stuck: it has not executed a step yet, so its stamp is old by
 * construction, and terminating it would throw away a run that is merely
 * waiting for capacity.
 */
/**
 * How long a *queued* instance may sit without being picked up before it counts
 * as lost. The engine queues when capacity is tight, so patience is right — but
 * "forever" is not: an instance that is never picked up would answer 409 to
 * every retry for the rest of its retention window.
 */
export const STUCK_QUEUED_RUN_MS = 60 * 60_000;

/** Age of the last progress write, or `null` when the stamp is unreadable. */
const quietMs = (state: Pick<UserIndexState, "updatedAt">, now: number): number | null => {
  const stamp = Date.parse(state.updatedAt);

  return Number.isNaN(stamp) ? null : Math.max(0, now - stamp);
};

export const shouldTakeOver = (
  state: Pick<UserIndexState, "phase" | "updatedAt">,
  run: { readonly live: boolean; readonly status: string | null },
  now: number = Date.now(),
): boolean => {
  // A live instance that stopped heartbeating: the only way to recover a step
  // that never returns.
  if (run.status === "running" && isRunStuck(state, true, now)) return true;

  // Waiting for capacity is normal; waiting an hour is not.
  if (run.status === "queued" || run.status === "waiting") {
    const quiet = quietMs(state, now);

    return quiet !== null && quiet > STUCK_QUEUED_RUN_MS;
  }

  // Nothing in the engine, but the stamp is fresh: the run may be starting up,
  // and the engine probe can also fail transiently. Wait out the abandonment
  // window instead of racing a healthy run into a duplicate.
  return !run.live && isRunAbandoned(state, false, now);
};
