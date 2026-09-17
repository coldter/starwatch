import * as Schema from "effect/Schema";

export const SyncPhase = Schema.Literals([
  "idle",
  "listing",
  "fetching-readmes",
  "embedding",
  "ready",
  "failed",
  "paused",
]);

export type SyncPhase = typeof SyncPhase.Type;

/**
 * Phases where a run is doing work in the background. Every writer that leaves
 * one of these behind makes `POST /sync` answer 409 `SyncInProgress` until the
 * state settles, so a run that dies without a final write strands the user.
 */
export const ACTIVE_SYNC_PHASES: ReadonlyArray<SyncPhase> = [
  "listing",
  "fetching-readmes",
  "embedding",
];

export const isActiveSyncPhase = (phase: SyncPhase): boolean => ACTIVE_SYNC_PHASES.includes(phase);

/** Public-facing index state for an indexed user. */
export const UserIndexState = Schema.Struct({
  login: Schema.String,
  phase: SyncPhase,
  starsTotal: Schema.Number,
  reposMetadata: Schema.Number,
  readmesFetched: Schema.Number,
  semanticDocs: Schema.Number,
  lastSyncedAt: Schema.NullOr(Schema.String),
  lastError: Schema.NullOr(Schema.String),
  updatedAt: Schema.String,
});

export type UserIndexState = typeof UserIndexState.Type;

/**
 * Per-account sync window (docs/08 §2.2, docs/14 §4). One indexed account is
 * touched at most once per day, whichever client asks: the public service
 * cannot tell users apart, so the *account* — not the caller — is the budget.
 * Retries of a run that produced nothing are exempt (see the start handler),
 * because otherwise a failed attempt would lock an account out for a day.
 */
export const SYNC_WINDOW_SECONDS = 24 * 60 * 60;

/** Cooldown policy (see docs/08, docs/14). */
export const SyncCooldowns = Schema.Struct({
  relistSeconds: Schema.Number,
  fullRefreshSeconds: Schema.Number,
});

export type SyncCooldowns = typeof SyncCooldowns.Type;

export const DEFAULT_SYNC_COOLDOWNS: SyncCooldowns = {
  // One window for both kinds of run: the account, not the caller, is the
  // budget (docs/14 §4). The start handler exempts the two cases where a
  // 24-hour lock would be harmful — a run that died mid-flight, and a run that
  // produced nothing to index.
  relistSeconds: SYNC_WINDOW_SECONDS,
  fullRefreshSeconds: SYNC_WINDOW_SECONDS,
};

/** Full-index ceiling (docs/13, docs/14: MAX_STARS). */
export const MAX_STARS = 10_000;

/** Newest-N repos that get semantic vectors in the free tier (docs/15). */
export const SEMANTIC_WINDOW = 1_500;
