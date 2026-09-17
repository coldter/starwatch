import type { GithubRateLimited } from "@starwatch/domain";

/**
 * Waiting out GitHub rate limits instead of failing the run (docs/03 §1.3).
 *
 * Two limits behave differently:
 *   * **Primary** (`x-ratelimit-reset`) resets at a known second — sleep until
 *     then and continue the same page/README batch.
 *   * **Secondary** is undocumented; GitHub sends `retry-after`, else we start
 *     at 60 s and double per attempt.
 *
 * Waits are bounded in count and duration: a run that keeps getting limited
 * must eventually *stop* (the handler converts that into a `paused` state the
 * user can retry) rather than sleep for hours inside one instance.
 */

/** Longest single wait. A primary reset 40 minutes out means "come back later". */
export const MAX_RATE_LIMIT_WAIT_MS = 15 * 60_000;

/** Waits per run before the run gives up and pauses. */
export const MAX_RATE_LIMIT_WAITS = 2;

/** Floor for a secondary-limit wait with no `retry-after` (docs/03 §1.3). */
const SECONDARY_BASE_WAIT_MS = 60_000;

export interface RateLimitWait {
  /** Milliseconds to sleep before retrying, 0 when the run must stop instead. */
  readonly waitMs: number;
  /** Absolute wake time for the log line (`null` when stopping). */
  readonly until: Date | null;
  /** Why this decision was made — logged, and the pause message when stopping. */
  readonly reason: "reset" | "retry-after" | "backoff" | "too-long" | "too-many";
}

/**
 * Decide how long to wait after a rate-limit error. Pure: the caller does the
 * sleeping (a Workflows step), which keeps the policy unit-testable.
 */
export const planRateLimitWait = (
  error: GithubRateLimited,
  options: {
    /** How many waits this run has already taken. */
    readonly waitsSoFar: number;
    /** Overridable clock, for tests. */
    readonly nowMs?: number;
    /** Secondary-limit attempt counter, used for the doubling backoff. */
    readonly attempt?: number;
  },
): RateLimitWait => {
  const nowMs = options.nowMs ?? Date.now();

  if (options.waitsSoFar >= MAX_RATE_LIMIT_WAITS) {
    return { waitMs: 0, until: null, reason: "too-many" };
  }

  const resetMs = error.resetAt === null ? Number.NaN : Date.parse(error.resetAt);

  if (Number.isFinite(resetMs) && resetMs > nowMs) {
    // +5 s of slack: the reset second is when the counter flips, not when a
    // request queued in the same second is safe.
    const waitMs = resetMs - nowMs + 5_000;

    return waitMs <= MAX_RATE_LIMIT_WAIT_MS
      ? { waitMs, until: new Date(nowMs + waitMs), reason: "reset" }
      : { waitMs: 0, until: null, reason: "too-long" };
  }

  const attempt = Math.max(1, options.attempt ?? 1);

  const retryAfterMs =
    error.retryAfterSeconds === null || error.retryAfterSeconds <= 0
      ? null
      : error.retryAfterSeconds * 1000;

  const waitMs = Math.max(
    SECONDARY_BASE_WAIT_MS,
    retryAfterMs ?? SECONDARY_BASE_WAIT_MS * 2 ** (attempt - 1),
  );

  if (waitMs > MAX_RATE_LIMIT_WAIT_MS) {
    return { waitMs: 0, until: null, reason: "too-long" };
  }

  return {
    waitMs,
    until: new Date(nowMs + waitMs),
    reason: retryAfterMs === null ? "backoff" : "retry-after",
  };
};
