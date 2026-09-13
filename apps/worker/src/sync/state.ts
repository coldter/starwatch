import type { SyncPhase } from "@starwatch/domain";
import type { GithubClientError } from "@starwatch/core/sync";
import { RepoStore } from "@starwatch/cloudflare/storage";
import * as Effect from "effect/Effect";

/** Single ISO-8601 clock for workflow writes. */
export const nowIso = (): string => new Date().toISOString();

/** Readable one-liner for any GitHub client failure (state `last_error`). */
export const describeGithubError = (error: GithubClientError): string => {
  switch (error._tag) {
    case "GithubRateLimited":
      return `GitHub rate limit (reset ${error.resetAt ?? "unknown"})`;
    case "GithubUpstream":
      return `GitHub upstream error ${error.status}: ${error.message}`;
    case "UserNotFound":
      return `GitHub user ${error.login} not found`;
  }
};

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
  patch: StatePatch
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
        updatedAt: nowIso()
      })
      .pipe(Effect.orDie);
  });
