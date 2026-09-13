import * as Schema from "effect/Schema";

export class UserNotFound extends Schema.TaggedError<UserNotFound>()("UserNotFound", {
  login: Schema.String
}) {}

export class RepoNotFound extends Schema.TaggedError<RepoNotFound>()("RepoNotFound", {
  fullName: Schema.String
}) {}

export class GithubRateLimited extends Schema.TaggedError<GithubRateLimited>()("GithubRateLimited", {
  message: Schema.String,
  resetAt: Schema.NullOr(Schema.String)
}) {}

export class GithubUpstream extends Schema.TaggedError<GithubUpstream>()("GithubUpstream", {
  message: Schema.String,
  status: Schema.Number
}) {}

export class SyncInProgress extends Schema.TaggedError<SyncInProgress>()("SyncInProgress", {
  login: Schema.String
}) {}

export class SyncCooldown extends Schema.TaggedError<SyncCooldown>()("SyncCooldown", {
  login: Schema.String,
  retryAfterSeconds: Schema.Number
}) {}

export class BudgetExceeded extends Schema.TaggedError<BudgetExceeded>()("BudgetExceeded", {
  scope: Schema.String,
  message: Schema.String
}) {}

export class IndexNotReady extends Schema.TaggedError<IndexNotReady>()("IndexNotReady", {
  login: Schema.String,
  phase: Schema.String
}) {}

export type ApiError =
  | UserNotFound
  | RepoNotFound
  | GithubRateLimited
  | GithubUpstream
  | SyncInProgress
  | SyncCooldown
  | BudgetExceeded
  | IndexNotReady;
