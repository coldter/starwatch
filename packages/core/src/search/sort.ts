/**
 * Explicit result ordering (docs/07 §4, docs/07 §5.5).
 *
 * Fusion owns *relevance* order. Every other key is a pure re-ordering of the
 * fused match set — never a re-rank — so `score` and `matchedBy` stay truthful
 * for the result card, and the relevance path is bit-identical to a search
 * without a sort.
 *
 * Tie-break ladder (docs/07 §5.5 steps 4–6): sort key desc → `starred_at` desc
 * → `repo_id` asc. `starred_at`/`pushed_at` are nullable, so missing dates sort
 * last rather than winning; the total order makes repeated requests byte-stable.
 */

import type { Repo, SearchSort } from "@starwatch/domain";

/** Structural minimum every hit must expose to be ordered by {@link sortHits}. */
export interface SortableHit {
  readonly repo: Repo;
}

/** Dates are ISO-8601 strings, but parse defensively: `null` and garbage last. */
const timeValue = (value: string | null): number => {
  if (value === null) return Number.NEGATIVE_INFINITY;

  const parsed = Date.parse(value);

  return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
};

/** Higher first; equal values tie (so the ladder falls through). */
const compareDesc = (left: number, right: number): number => (left === right ? 0 : right - left);

/** The user's chosen key, higher first. */
const primaryRank = (repo: Repo, sort: SearchSort): number => {
  if (sort === "stars") return repo.stars;

  return sort === "starred" ? timeValue(repo.starredAt) : timeValue(repo.pushedAt);
};

/** Total order for every explicit sort key; unused for `relevance`. */
export const compareHits = (left: SortableHit, right: SortableHit, sort: SearchSort): number =>
  compareDesc(primaryRank(left.repo, sort), primaryRank(right.repo, sort)) ||
  compareDesc(timeValue(left.repo.starredAt), timeValue(right.repo.starredAt)) ||
  left.repo.id - right.repo.id;

/**
 * Order fused hits by an explicit key. `relevance` keeps the incoming (fused)
 * order; everything else re-orders the same set. Never mutates the input.
 */
export const sortHits = <A extends SortableHit>(
  hits: ReadonlyArray<A>,
  sort: SearchSort,
): Array<A> => {
  const ordered = [...hits];

  if (sort === "relevance") return ordered;

  return ordered.sort((left, right) => compareHits(left, right, sort));
};
