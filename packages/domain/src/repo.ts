import * as Schema from "effect/Schema";

/**
 * A starred repository, as stored in D1 and returned by the API.
 * `id` is GitHub's numeric repo id (stable across renames).
 * Dates are ISO-8601 strings (GitHub API format).
 */
export const Repo = Schema.Struct({
  id: Schema.Number,
  fullName: Schema.String,
  owner: Schema.String,
  name: Schema.String,
  description: Schema.NullOr(Schema.String),
  language: Schema.NullOr(Schema.String),
  topics: Schema.Array(Schema.String),
  stars: Schema.Number,
  forks: Schema.Number,
  archived: Schema.Boolean,
  license: Schema.NullOr(Schema.String),
  homepage: Schema.NullOr(Schema.String),
  pushedAt: Schema.NullOr(Schema.String),
  starredAt: Schema.NullOr(Schema.String),
  htmlUrl: Schema.String
});

export type Repo = typeof Repo.Type;
