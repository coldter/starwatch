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

/** Cooldown policy (see docs/08, docs/14). */
export const SyncCooldowns = Schema.Struct({
  relistSeconds: Schema.Number,
  fullRefreshSeconds: Schema.Number,
});

export type SyncCooldowns = typeof SyncCooldowns.Type;

export const DEFAULT_SYNC_COOLDOWNS: SyncCooldowns = {
  relistSeconds: 15 * 60,
  fullRefreshSeconds: 24 * 60 * 60,
};

/** Full-index ceiling (docs/13, docs/14: MAX_STARS). */
export const MAX_STARS = 10_000;

/** Newest-N repos that get semantic vectors in the free tier (docs/15). */
export const SEMANTIC_WINDOW = 1_500;
