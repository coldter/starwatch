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
  nextIds: ReadonlyArray<number>,
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
export type ReadmeFetchStatus = "ok" | "missing" | "unavailable" | "error" | "pending";

/** One row of README state, keyed by repo id. */
export interface ReadmeFetchState {
  readonly repoId: number;
  /**
   * When this state was last written (`repos.readme_checked_at`), or `null`
   * for a row written before the column existed. The freshness anchor for
   * {@link needsReadmeFetch}: a repo pushed after the last check may have a
   * newer README.
   */
  readonly checkedAt: string | null;
  readonly status: ReadmeFetchStatus;
}

export type ReadmeStateMap = ReadonlyMap<number, ReadmeFetchState>;

export interface PlanReadmeWorkOptions {
  /** Repos per returned batch; docs/15 §5 models ~25-repo batches. */
  readonly batchSize?: number | undefined;
  /** Only the newest N repos get README/embedding work (free tier window). */
  readonly semanticWindow?: number | undefined;
  /**
   * Repo ids this account has already published vectors for. When given, a
   * window repo missing from this set is planned even though its README is
   * current: the vector belongs to the *account*, while `repos.readme_*` is a
   * shared row, so a second starrer of the same repo would otherwise never get
   * vectors for a README the first starrer already fetched.
   */
  readonly existingVectorIds?: ReadonlySet<number> | undefined;
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
 * Does this repo's stored README need a fetch from GitHub?
 *
 * Yes when nothing is known, when the last attempt errored, or when the repo
 * was pushed after the last check (`pushed_at > readme_checked_at`, the schema's
 * documented trigger). **`pending` is not automatically stale**: it means a
 * previous run stored the text and died before its vector was published, and
 * re-fetching that text on retry is exactly the waste this predicate exists to
 * prevent. The README is still re-embedded — {@link publishedReadmeHash} marks
 * `pending` dirty.
 */
export const needsReadmeFetch = (
  repo: Pick<Repo, "pushedAt">,
  state: ReadmeFetchState | undefined,
): boolean => {
  if (state === undefined) return true;

  if (state.status === "error") return true;

  // ISO-8601 UTC strings order lexicographically; an unknown push date can
  // never prove the stored text is stale.
  return repo.pushedAt !== null && (state.checkedAt === null || repo.pushedAt > state.checkedAt);
};

/**
 * What one README batch should do for one repo: re-read it from GitHub, or
 * reuse the text it already has stored.
 */
export type ReadmeBatchAction =
  | { readonly kind: "fetch" }
  | { readonly kind: "reuse"; readonly text: string; readonly state: "present" | "missing" };

/**
 * Decide one repo's batch work. The expensive half of a README batch is the
 * GitHub round-trip, so a retry after a killed run must reuse whatever text is
 * already stored (a `pending` row) instead of paying for the same fetch twice;
 * only the embedding — which never reached the published blob — is redone.
 */
export const readmeBatchAction = (
  repo: Pick<Repo, "pushedAt">,
  state: ReadmeFetchState | undefined,
  storedText: string | undefined,
): ReadmeBatchAction => {
  if (needsReadmeFetch(repo, state)) return { kind: "fetch" };

  // A stored row without text means GitHub confirmed there is no README; a
  // `pending` row with text is a fetch that already succeeded.
  if (storedText === undefined) return { kind: "reuse", text: "", state: "missing" };

  return { kind: "reuse", text: storedText, state: "present" };
};

/**
 * New or changed README work for the semantic window.
 *
 * A repo enters a batch when {@link needsReadmeFetch} says its text must be
 * re-read, when a previous run left it `pending` (text stored, vector
 * unpublished), or when the account has no published vector for it yet
 * (`existingVectorIds`). The batch decides for itself whether that work is a
 * GitHub fetch or an embed of the stored text — a restart must not pay for the
 * same README twice.
 */
export const planReadmeWork = (
  repos: ReadonlyArray<Repo>,
  state: ReadmeStateMap,
  options: PlanReadmeWorkOptions = {},
): ReadonlyArray<ReadonlyArray<number>> => {
  const batchSize = options.batchSize ?? 25;
  const semanticWindow = options.semanticWindow ?? SEMANTIC_WINDOW;
  const existingVectorIds = options.existingVectorIds;

  if (batchSize < 1) throw new RangeError(`batchSize must be >= 1, got ${batchSize}`);

  const window = newestFirst(repos).slice(0, Math.max(0, semanticWindow));
  const ids: number[] = [];

  for (const repo of window) {
    const existing = state.get(repo.id);
    const unpublished = existing?.status === "pending";

    if (
      needsReadmeFetch(repo, existing) ||
      unpublished ||
      (existingVectorIds !== undefined && !existingVectorIds.has(repo.id))
    ) {
      ids.push(repo.id);
    }
  }

  return chunk(ids, batchSize);
};

/**
 * The hash {@link planEmbedWork} should compare against for one repo: its
 * published README hash when the row is *published* (`ok`/`missing`), and the
 * empty marker otherwise.
 *
 * `pending` is the state the refresh writes when it stores README text but the
 * vector is still sitting in an unmerged part. Treating that as published is
 * what once let an aborted run leave repos the planner would never visit again;
 * an unreadable state is dirty for the same reason. The empty string can never
 * collide with a real FNV hash, so "dirty" and "unchanged" stay distinguishable.
 */
export const publishedReadmeHash = (
  status: ReadmeFetchStatus | undefined,
  text: string | undefined,
): string => (status === "ok" || status === "missing" ? hashReadme(text ?? "") : "");

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
  existingReadmeHashes: ReadonlyMap<number, string>,
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
  options: CanSyncOptions = {},
): CanSyncResult => {
  if (state.inProgress) {
    return { allowed: false, reason: "in-progress", retryAfterSeconds: 0 };
  }

  if (options.force !== true) {
    const fullRemaining = remainingMs(
      state.lastFullRefreshAtMs,
      nowMs,
      cooldowns.fullRefreshSeconds,
    );

    if (fullRemaining > 0) {
      return {
        allowed: false,
        reason: "cooldown-full",
        retryAfterSeconds: Math.ceil(fullRemaining / 1000),
      };
    }

    const relistRemaining = remainingMs(state.lastRelistAtMs, nowMs, cooldowns.relistSeconds);

    if (relistRemaining > 0) {
      return {
        allowed: false,
        reason: "cooldown-relist",
        retryAfterSeconds: Math.ceil(relistRemaining / 1000),
      };
    }
  }

  return { allowed: true, reason: "ok", retryAfterSeconds: 0 };
};
