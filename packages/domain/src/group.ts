import * as Schema from "effect/Schema";

/**
 * A group = a GitHub public List imported for an indexed user
 * (read-only in v1). `id` is the GitHub GraphQL node id.
 */
export const Group = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  slug: Schema.String,
  position: Schema.Number,
  repoIds: Schema.Array(Schema.Number),
});

export type Group = typeof Group.Type;

/**
 * Whether this account's public GitHub Lists were readable on the last attempt.
 *
 * An empty `groups` array is ambiguous without this: `empty` means GitHub
 * answered and the account has no public Lists, while `error` means the import
 * could not read them (no token, rate limit, upstream failure) and the stored
 * lists — if any — are simply the last known ones.
 */
export const ListsState = Schema.Literals(["never", "ok", "empty", "error"]);

export type ListsState = typeof ListsState.Type;

/** Last public-Lists import outcome, carried on the user payload. */
export const ListsInfo = Schema.Struct({
  state: ListsState,
  /** Why the last attempt failed, when it did. */
  error: Schema.NullOr(Schema.String),
  checkedAt: Schema.NullOr(Schema.String),
});

export type ListsInfo = typeof ListsInfo.Type;
