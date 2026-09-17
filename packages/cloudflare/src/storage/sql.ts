import { Result, Schema } from "effect";
import { SyncPhase } from "@starwatch/domain";

/**
 * Shared SQL plumbing for the free-tier storage layer.
 *
 * The SQL drivers never rename result columns, so every `SqlClient` used with
 * this package must be constructed with `transformResultNames: camelize`
 * (`@effect/sql-sqlite-node` in tests, `@effect/sql-d1` in production). The
 * row schemas below describe the *post-transform* shape (snake_case columns,
 * camelCase keys) and double as runtime validation for values read back out
 * of D1.
 */

/** `snake_case` → `camelCase`; used as `transformResultNames`. */
export const camelize = (name: string): string =>
  name.replace(/_([a-z0-9])/gi, (_match: string, char: string) => char.toUpperCase());

/** Single ISO-8601 timestamp source for every `*_at` column. */
export const nowIso = (): string => new Date().toISOString();

/** Split an array into chunks of at most `size` (D1 allows 100 bound params). */
export const chunk = <A>(
  items: ReadonlyArray<A>,
  size: number,
): ReadonlyArray<ReadonlyArray<A>> => {
  if (size <= 0) {
    throw new Error(`chunk size must be positive, got ${size}`);
  }

  const out: Array<ReadonlyArray<A>> = [];

  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }

  return out;
};

/** SQLite stores booleans as 0/1. */
export const boolToInt = (value: boolean): number => (value ? 1 : 0);

/** SQLite stores booleans as 0/1. */
export const intToBool = (value: number): boolean => value !== 0;

const JsonStringArray = Schema.fromJsonString(Schema.Array(Schema.String));

/** Parse a `topics_json` column; malformed data degrades to "no topics". */
export const parseTopicsJson = (topicsJson: string): ReadonlyArray<string> => {
  const result = Schema.decodeUnknownResult(JsonStringArray)(topicsJson);

  return Result.isSuccess(result) ? result.success : [];
};

/** README lifecycle states written by the sync pipeline (docs/03). */
export const ReadmeState = Schema.Literals(["unknown", "present", "missing", "too_big", "error"]);

export type ReadmeState = typeof ReadmeState.Type;

/** Fields of the D1 README budget: 64 KB per repo (docs/14 §3.6). */
export const README_MAX_CHARS = 64 * 1024;

/**
 * Per-user FTS text budget (docs/14 §3.6): 20 MB of porter-indexed text.
 * The layer counts characters as a byte proxy; README text is ASCII-dominant.
 */
export const USER_FTS_MAX_CHARS = 20 * 1024 * 1024;

export const UserRow = Schema.Struct({
  login: Schema.String,
  id: Schema.Number,
  name: Schema.NullOr(Schema.String),
  avatarUrl: Schema.NullOr(Schema.String),
  bio: Schema.NullOr(Schema.String),
  company: Schema.NullOr(Schema.String),
  location: Schema.NullOr(Schema.String),
  followers: Schema.Number,
  publicRepos: Schema.Number,
  createdAtGh: Schema.NullOr(Schema.String),
  fetchedAt: Schema.String,
});

export type UserRow = typeof UserRow.Type;

export const RepoRow = Schema.Struct({
  id: Schema.Number,
  fullName: Schema.String,
  owner: Schema.String,
  name: Schema.String,
  description: Schema.NullOr(Schema.String),
  language: Schema.NullOr(Schema.String),
  topicsJson: Schema.String,
  stars: Schema.Number,
  forks: Schema.Number,
  archived: Schema.Number,
  license: Schema.NullOr(Schema.String),
  homepage: Schema.NullOr(Schema.String),
  pushedAt: Schema.NullOr(Schema.String),
  htmlUrl: Schema.String,
  readmeText: Schema.NullOr(Schema.String),
  readmeHash: Schema.NullOr(Schema.String),
  readmeState: Schema.String,
  readmeCheckedAt: Schema.NullOr(Schema.String),
  firstSeenAt: Schema.String,
  updatedAt: Schema.String,
  starredAt: Schema.NullOr(Schema.String),
});

export type RepoRow = typeof RepoRow.Type;

export const IndexStateRow = Schema.Struct({
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

export type IndexStateRow = typeof IndexStateRow.Type;

export const StarEtagRow = Schema.Struct({
  etag: Schema.String,
});

export type StarEtagRow = typeof StarEtagRow.Type;

export const GroupRow = Schema.Struct({
  id: Schema.String,
  login: Schema.String,
  name: Schema.String,
  slug: Schema.String,
  position: Schema.Number,
  updatedAt: Schema.String,
});

export type GroupRow = typeof GroupRow.Type;

export const GroupRepoRow = Schema.Struct({
  groupId: Schema.String,
  repoId: Schema.Number,
});

export type GroupRepoRow = typeof GroupRepoRow.Type;

export const VectorBlobRow = Schema.Struct({
  login: Schema.String,
  dims: Schema.Number,
  bytesLen: Schema.Number,
  updatedAt: Schema.String,
});

export type VectorBlobRow = typeof VectorBlobRow.Type;

export const GroupSlugRow = Schema.Struct({
  repoId: Schema.Number,
  slug: Schema.String,
});

export type GroupSlugRow = typeof GroupSlugRow.Type;

/** `readme_text` for a set of repos (snippet hydration on the search path). */
export const ReadmeTextRow = Schema.Struct({
  repoId: Schema.Number,
  readmeText: Schema.NullOr(Schema.String),
});

export type ReadmeTextRow = typeof ReadmeTextRow.Type;

/** README bookkeeping for a user's repos (`planReadmeWork` input). */
export const ReadmeStateRow = Schema.Struct({
  repoId: Schema.Number,
  pushedAt: Schema.NullOr(Schema.String),
  readmeState: Schema.String,
});

export type ReadmeStateRow = typeof ReadmeStateRow.Type;

/** One `user_stars` row's listing page (`NULL` when unattributed). */
export const StarPageRow = Schema.Struct({
  starPage: Schema.NullOr(Schema.Number),
  repoId: Schema.Number,
});

export type StarPageRow = typeof StarPageRow.Type;

export const RepoIdRow = Schema.Struct({
  repoId: Schema.Number,
});

export type RepoIdRow = typeof RepoIdRow.Type;

export const GroupIdRow = Schema.Struct({
  id: Schema.String,
});

export type GroupIdRow = typeof GroupIdRow.Type;

export const RepoStatsRow = Schema.Struct({
  starsTotal: Schema.Number,
  reposMetadata: Schema.Number,
  readmesFetched: Schema.Number,
});

export type RepoStatsRow = typeof RepoStatsRow.Type;

export const FtsHitRow = Schema.Struct({
  repoId: Schema.Number,
  score: Schema.Number,
});

export type FtsHitRow = typeof FtsHitRow.Type;
