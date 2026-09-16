/**
 * Sync-side service contracts shared by the Worker and (later) the CLI.
 *
 * These are deliberately transport-agnostic: `@starwatch/cloudflare` provides
 * the GitHub API + Workers AI implementations, `@starwatch/core/sync` owns the
 * pure planning functions. Nothing in this module touches `fetch`, D1 or R2.
 *
 * @see docs/09-public-data-and-limits.md — endpoints, ETags, Lists, README probing
 * @see docs/15-free-semantic-search.md — embedding model + repo text profile
 */

import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type {
  GithubRateLimited,
  GithubUpstream,
  Group,
  Repo,
  UserNotFound,
  UserProfile,
} from "@starwatch/domain";

/** Every error a GitHub client method can fail with (docs/03 §1.3 taxonomy). */
export type GithubClientError = UserNotFound | GithubRateLimited | GithubUpstream;

/** Options for one page of `GET /users/{login}/starred`. */
export interface ListStarPageOptions {
  readonly page: number;
  /** Previous response's `etag`; turns the request into a free 304 check. */
  readonly etag?: string | undefined;
  /** GitHub allows 1–100; the client defaults to 100. */
  readonly perPage?: number | undefined;
}

/**
 * One page of a user's public stars, decoded into domain repos.
 *
 * `starredAt` is both denormalized onto each {@link Repo} and kept as a map
 * keyed by repo id, because the planner only needs the timestamps while D1
 * writes want the joined shape.
 */
export interface StarPage {
  readonly repos: ReadonlyArray<Repo>;
  readonly starredAt: ReadonlyMap<number, string>;
  /** Strong ETag when authenticated; `undefined` when GitHub omitted it. */
  readonly etag: string | undefined;
  /** `true` for a 304 response (free quota, no body, `repos` empty). */
  readonly notModified: boolean;
  /** Next page number parsed from `Link: rel="next"`, if any. */
  readonly nextPage: number | undefined;
  readonly rateLimitRemaining: number;
  readonly rateLimitResetAt: string | undefined;
}

/** Public GitHub client surface used by sync workflows. */
export interface GithubClientService {
  readonly getUserProfile: (login: string) => Effect.Effect<UserProfile, GithubClientError>;
  readonly listStarPage: (
    login: string,
    options: ListStarPageOptions,
  ) => Effect.Effect<StarPage, GithubClientError>;
  /** Public Lists of any user (`user(login).lists`), private lists skipped. */
  readonly listGroups: (login: string) => Effect.Effect<ReadonlyArray<Group>, GithubClientError>;
  /**
   * README text via zero-quota raw probes, falling back to the REST
   * `/repos/{fullName}/readme` endpoint once. `null` means "no README".
   */
  readonly getReadme: (
    fullName: string,
    defaultBranch: string,
  ) => Effect.Effect<GithubReadme | null, GithubRateLimited | GithubUpstream>;
}

export class GithubClient extends Context.Service<GithubClient, GithubClientService>()(
  "@starwatch/GithubClient",
) {}

/** A README hit plus which path served it (docs/09 §3.2). */
export interface GithubReadme {
  readonly text: string;
  readonly source: "raw" | "rest";
}

/**
 * Workers AI embedding failure. Local to sync because it never crosses the
 * public API — embed errors are retried/degraded inside the workflow.
 */
export class EmbedFailed extends Schema.TaggedError<EmbedFailed>()("EmbedFailed", {
  message: Schema.String,
}) {}

/** Bounded-batch embedder; vectors are `Float32Array` rows in input order. */
export interface EmbedderService {
  readonly embed: (
    texts: ReadonlyArray<string>,
  ) => Effect.Effect<ReadonlyArray<Float32Array>, EmbedFailed>;
}

export class Embedder extends Context.Service<Embedder, EmbedderService>()("@starwatch/Embedder") {}
