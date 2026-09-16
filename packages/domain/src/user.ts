import * as Schema from "effect/Schema";

/** A public GitHub user whose stars are being indexed. */
export const UserProfile = Schema.Struct({
  login: Schema.String,
  id: Schema.Number,
  name: Schema.NullOr(Schema.String),
  avatarUrl: Schema.String,
  bio: Schema.NullOr(Schema.String),
  company: Schema.NullOr(Schema.String),
  location: Schema.NullOr(Schema.String),
  followers: Schema.Number,
  publicRepos: Schema.Number,
  createdAt: Schema.String
});

export type UserProfile = typeof UserProfile.Type;
