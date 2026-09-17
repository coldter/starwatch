import {
  BudgetExceeded,
  Group,
  ListsInfo,
  Repo,
  RepoNotFound,
  SearchResponse,
  SyncCooldown,
  SyncInProgress,
  SyncPhase,
  UserIndexState,
  UserNotFound,
  UserProfile,
} from "@starwatch/domain";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import * as HttpApiSchema from "effect/unstable/httpapi/HttpApiSchema";
import * as Schema from "effect/Schema";

/**
 * The API spec is a pure value: clients can import it without Worker code.
 *
 * Route map (prefix `/api`):
 *   GET  /api/health
 *   GET  /api/users/:login
 *   POST /api/users/:login/sync
 *   GET  /api/users/:login/sync
 *   GET  /api/users/:login/sync/events   (SSE)
 *   GET  /api/users/:login/groups
 *   GET  /api/users/:login/search
 *   GET  /api/repos/:owner/:name
 *
 * Domain errors are annotated with their HTTP status here so the builder can
 * encode them; the handlers fail with the shared `@starwatch/domain` classes.
 */

export const Health = Schema.Struct({
  ok: Schema.Boolean,
  service: Schema.String,
  version: Schema.String,
});

const LoginParams = Schema.Struct({ login: Schema.String });

const RepoParams = Schema.Struct({ owner: Schema.String, name: Schema.String });

export const SyncRequest = Schema.Struct({
  full: Schema.optional(Schema.Boolean),
});

export const SyncAccepted = Schema.Struct({
  started: Schema.Boolean,
  phase: SyncPhase,
});

export const UserDetail = Schema.Struct({
  profile: UserProfile,
  state: UserIndexState,
  groups: Schema.Array(Group),
  lists: ListsInfo,
});

/** Result of an on-demand public-Lists import (`POST /users/:login/groups/refresh`). */
export const GroupsRefresh = Schema.Struct({
  groups: Schema.Array(Group),
  lists: ListsInfo,
});

export const RepoDetail = Schema.Struct({
  repo: Repo,
  groups: Schema.Array(Group),
});

/**
 * Search query params. Everything arrives as a string from the URL and is
 * parsed/clamped in the handler; comma-separated lists are split there too.
 * Topic semantics are **AND across all provided topics** (storage layer,
 * docs/04 §5.2); group semantics are **OR**.
 */
export const SearchQuery = Schema.Struct({
  q: Schema.String,
  mode: Schema.optional(Schema.String),
  sort: Schema.optional(Schema.String),
  lang: Schema.optional(Schema.String),
  topic: Schema.optional(Schema.String),
  group: Schema.optional(Schema.String),
  minStars: Schema.optional(Schema.String),
  maxStars: Schema.optional(Schema.String),
  archived: Schema.optional(Schema.String),
  license: Schema.optional(Schema.String),
  starredAfter: Schema.optional(Schema.String),
  starredBefore: Schema.optional(Schema.String),
  offset: Schema.optional(Schema.String),
  limit: Schema.optional(Schema.String),
});

export type SearchQuery = typeof SearchQuery.Type;

/** HTTP-status annotations (the handler still fails with the domain class). */
export const ApiUserNotFound = UserNotFound.pipe(HttpApiSchema.status(404));

export const ApiRepoNotFound = RepoNotFound.pipe(HttpApiSchema.status(404));

export const ApiSyncCooldown = SyncCooldown.pipe(HttpApiSchema.status(429));

export const ApiSyncInProgress = SyncInProgress.pipe(HttpApiSchema.status(409));

export const ApiBudgetExceeded = BudgetExceeded.pipe(HttpApiSchema.status(429));

const systemGroup = HttpApiGroup.make("system").add(
  HttpApiEndpoint.get("health", "/health", { success: Health }),
);

const usersGroup = HttpApiGroup.make("users")
  .add(
    HttpApiEndpoint.get("getUser", "/users/:login", {
      params: LoginParams,
      success: UserDetail,
      error: ApiUserNotFound,
    }),
  )
  .add(
    HttpApiEndpoint.post("startSync", "/users/:login/sync", {
      params: LoginParams,
      payload: SyncRequest,
      success: SyncAccepted,
      error: [ApiUserNotFound, ApiSyncCooldown, ApiSyncInProgress, ApiBudgetExceeded],
    }),
  )
  .add(
    HttpApiEndpoint.get("getSyncState", "/users/:login/sync", {
      params: LoginParams,
      success: UserIndexState,
      error: ApiUserNotFound,
    }),
  )
  .add(
    HttpApiEndpoint.get("syncEvents", "/users/:login/sync/events", {
      params: LoginParams,
      success: HttpApiSchema.StreamSse({ data: UserIndexState }),
      error: ApiUserNotFound,
    }),
  )
  .add(
    HttpApiEndpoint.get("getUserGroups", "/users/:login/groups", {
      params: LoginParams,
      success: Schema.Array(Group),
      error: ApiUserNotFound,
    }),
  )
  .add(
    HttpApiEndpoint.post("refreshUserGroups", "/users/:login/groups/refresh", {
      params: LoginParams,
      success: GroupsRefresh,
      error: [ApiUserNotFound, ApiBudgetExceeded],
    }),
  );

const searchGroup = HttpApiGroup.make("search").add(
  HttpApiEndpoint.get("searchRepos", "/users/:login/search", {
    params: LoginParams,
    query: SearchQuery,
    success: SearchResponse,
    error: ApiBudgetExceeded,
  }),
);

const reposGroup = HttpApiGroup.make("repos").add(
  HttpApiEndpoint.get("getRepo", "/repos/:owner/:name", {
    params: RepoParams,
    success: RepoDetail,
    error: ApiRepoNotFound,
  }),
);

export const StarwatchApi = HttpApi.make("StarwatchApi")
  .add(systemGroup)
  .add(usersGroup)
  .add(searchGroup)
  .add(reposGroup)
  .prefix("/api");
