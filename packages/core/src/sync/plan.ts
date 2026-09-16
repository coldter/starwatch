/**
 * Pure sync planning: no I/O, no clock, no randomness.
 *
 * The Worker feeds these functions persisted state and repo metadata; the
 * returned ids/batches drive README fetches and embedding. Determinism matters:
 * identical inputs must produce identical work so retries never double-spend
 * quotas (docs/09 §6, docs/08 §2.3).
 */

import type { Repo, SyncCooldowns } from "@starwatch/domain";
import { SEMANTIC_WINDOW } from "@starwatch/domain";

/** Added/removed repo ids between two snapshots (docs/03 §(g)). */
export interface StarDiff {
  readonly added: ReadonlyArray<number>;
  readonly removed: ReadonlyArray<number>;
}

/**
 * Compare previous and next star sets. `added` follows `nextIds` order,
 * `removed` follows `prevIds` order, so callers can keep listing order when
 * writing rows.
 */
export const diffStars = (
  prevIds: ReadonlyArray<number>,
  nextIds: ReadonlyArray<number>
): StarDiff => {
  const prev = new Set(prevIds);
  const next = new Set(nextIds);
  const added: number[] = [];
  const removed: number[] = [];

  for (const id of nextIds) {
    if (!prev.has(id)) added.push(id);
  }

  for (const id of prevIds) {
    if (!next.has(id)) removed.push(id);
  }

  return { added, removed };
};

/** Lifecycle of a repo's README as persisted by the sync workflow. */
export type ReadmeFetchStatus = "ok" | "missing" | "unavailable" | "error";

/** One row of README state, keyed by repo id. */
export interface ReadmeFetchState {
  readonly repoId: number;
  /** `pushed_at` recorded when this state was written (the change trigger). */
  readonly pushedAt: string | null;
  readonly status: ReadmeFetchStatus;
}

export type ReadmeStateMap = ReadonlyMap<number, ReadmeFetchState>;

export interface PlanReadmeWorkOptions {
  /** Repos per returned batch; docs/15 §5 models ~25-repo batches. */
  readonly batchSize?: number | undefined;
  /** Only the newest N repos get README/embedding work (free tier window). */
  readonly semanticWindow?: number | undefined;
}

/**
 * Order repos newest-starred first (docs/15 §2.1's semantic window).
 * `starredAt === null` sorts last; equal timestamps keep input order.
 */
const newestFirst = (repos: ReadonlyArray<Repo>): ReadonlyArray<Repo> => {
  const indexed = repos.map((repo, index) => ({ repo, index }));
  indexed.sort((a, b) => {
    const aTime = a.repo.starredAt;
    const bTime = b.repo.starredAt;

    if (aTime !== bTime) {
      if (aTime === null) return 1;

      if (bTime === null) return -1;

      return aTime > bTime ? -1 : 1;
    }

    return a.index - b.index;
  });

  return indexed.map((entry) => entry.repo);
};

const chunk = <A>(items: ReadonlyArray<A>, size: number): ReadonlyArray<ReadonlyArray<A>> => {
  const batches: A[][] = [];

  for (let i = 0; i < items.length; i += size) {
    batches.push(items.slice(i, i + size));
  }

  return batches;
};

/**
 * New or changed README work for the semantic window.
 *
 * A repo needs a fetch when there is no state row, the last attempt errored, or
 * `pushed_at` moved since the recorded state. `missing`/`unavailable` repos are
 * otherwise left alone (docs/09 §3.3 rechecks them on a 30–90 day cadence,
 * which the workflow layer owns).
 */
export const planReadmeWork = (
  repos: ReadonlyArray<Repo>,
  state: ReadmeStateMap,
  options: PlanReadmeWorkOptions = {}
): ReadonlyArray<ReadonlyArray<number>> => {
  const batchSize = options.batchSize ?? 25;
  const semanticWindow = options.semanticWindow ?? SEMANTIC_WINDOW;

  if (batchSize < 1) throw new RangeError(`batchSize must be >= 1, got ${batchSize}`);

  const window = newestFirst(repos).slice(0, Math.max(0, semanticWindow));
  const ids: number[] = [];

  for (const repo of window) {
    const existing = state.get(repo.id);

    if (existing === undefined) {
      ids.push(repo.id);
      continue;
    }

    if (existing.status === "error") {
      ids.push(repo.id);
      continue;
    }

    if (existing.pushedAt !== repo.pushedAt) {
      ids.push(repo.id);
    }
  }

  return chunk(ids, batchSize);
};

/**
 * Stable content hash for README-derived embedding documents (FNV-1a/32).
 * Callers store this alongside the embedding and pass it back as
 * `existingReadmeHashes` to {@link planEmbedWork} to skip unchanged docs.
 */
export const hashReadme = (text: string): string => {
  let hash = 0x811c9dc5;

  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }

  return (hash >>> 0).toString(16).padStart(8, "0");
};

/**
 * Repo ids that need (re-)embedding, newest first.
 *
 * A repo is dirty when its README hash differs from the stored one; repos whose
 * README is absent (or still missing) hash as the empty string, so metadata-only
 * docs are embedded too and are re-embedded exactly once when the README lands.
 * Only the newest {@link SEMANTIC_WINDOW} repos are considered (docs/15 §2.1).
 */
export const planEmbedWork = (
  repos: ReadonlyArray<Repo>,
  readmesByRepoId: ReadonlyMap<number, string>,
  existingReadmeHashes: ReadonlyMap<number, string>
): ReadonlyArray<number> => {
  const window = newestFirst(repos).slice(0, SEMANTIC_WINDOW);
  const dirty: number[] = [];

  for (const repo of window) {
    const hash = hashReadme(readmesByRepoId.get(repo.id) ?? "");

    if (existingReadmeHashes.get(repo.id) !== hash) {
      dirty.push(repo.id);
    }
  }

  return dirty;
};

/** Persisted sync bookkeeping the admission check needs. */
export interface SyncState {
  /** A listing/semantic job is currently running for this login. */
  readonly inProgress: boolean;
  readonly lastRelistAtMs: number | null;
  readonly lastFullRefreshAtMs: number | null;
}

export type SyncDenialReason = "cooldown-relist" | "cooldown-full" | "in-progress" | "ok";

export interface CanSyncResult {
  readonly allowed: boolean;
  readonly reason: SyncDenialReason;
  /** Whole seconds until the blocking cooldown expires; 0 otherwise. */
  readonly retryAfterSeconds: number;
}

export interface CanSyncOptions {
  /** Operator/backfill override: bypasses cooldowns but never concurrency. */
  readonly force?: boolean | undefined;
}

const remainingMs = (lastMs: number | null, nowMs: number, windowSeconds: number): number => {
  if (lastMs === null) return 0;

  return Math.max(0, lastMs + windowSeconds * 1000 - nowMs);
};

/**
 * Admission control for a sync attempt (docs/08 §2.3): an in-progress job
 * always wins; otherwise `force` skips cooldowns; otherwise the full-refresh
 * cooldown is checked before the re-list cooldown because it is the stricter
 * window.
 */
export const canSync = (
  state: SyncState,
  nowMs: number,
  cooldowns: SyncCooldowns,
  options: CanSyncOptions = {}
): CanSyncResult => {
  if (state.inProgress) {
    return { allowed: false, reason: "in-progress", retryAfterSeconds: 0 };
  }

  if (options.force !== true) {
    const fullRemaining = remainingMs(
      state.lastFullRefreshAtMs,
      nowMs,
      cooldowns.fullRefreshSeconds
    );

    if (fullRemaining > 0) {
      return {
        allowed: false,
        reason: "cooldown-full",
        retryAfterSeconds: Math.ceil(fullRemaining / 1000)
      };
    }

    const relistRemaining = remainingMs(state.lastRelistAtMs, nowMs, cooldowns.relistSeconds);

    if (relistRemaining > 0) {
      return {
        allowed: false,
        reason: "cooldown-relist",
        retryAfterSeconds: Math.ceil(relistRemaining / 1000)
      };
    }
  }

  return { allowed: true, reason: "ok", retryAfterSeconds: 0 };
};
