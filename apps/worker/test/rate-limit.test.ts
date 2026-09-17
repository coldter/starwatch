import { describe, expect, it } from "@effect/vitest";
import { GithubRateLimited } from "@starwatch/domain";
import {
  MAX_RATE_LIMIT_WAIT_MS,
  MAX_RATE_LIMIT_WAITS,
  planRateLimitWait,
} from "../src/sync/rate-limit.ts";

/**
 * Waiting out GitHub limits is the difference between "the run pauses and
 * resumes" and "the user sees a failed index". The policy is pure, so these
 * tests pin the decisions docs/03 §1.3 promises: honour a known reset, honour
 * `retry-after`, back off otherwise, and never sleep for hours.
 */

const NOW = Date.parse("2026-09-17T12:00:00.000Z");

const limit = (overrides: Partial<GithubRateLimited> = {}): GithubRateLimited =>
  new GithubRateLimited({
    message: "GitHub rate limit",
    resetAt: null,
    retryAfterSeconds: null,
    ...overrides,
  });

describe("planRateLimitWait", () => {
  it("sleeps until a primary reset plus slack", () => {
    const resetAt = new Date(NOW + 4 * 60_000).toISOString();
    const plan = planRateLimitWait(limit({ resetAt }), { waitsSoFar: 0, nowMs: NOW });

    expect(plan.reason).toBe("reset");
    expect(plan.waitMs).toBe(4 * 60_000 + 5_000);
    expect(plan.until?.toISOString()).toBe(new Date(NOW + plan.waitMs).toISOString());
  });

  it("gives up when the reset is further out than the wait budget", () => {
    const resetAt = new Date(NOW + 40 * 60_000).toISOString();
    const plan = planRateLimitWait(limit({ resetAt }), { waitsSoFar: 0, nowMs: NOW });

    expect(plan).toEqual({ waitMs: 0, until: null, reason: "too-long" });
  });

  it("honours retry-after for a secondary limit, with a 60 s floor", () => {
    const short = planRateLimitWait(limit({ retryAfterSeconds: 10 }), {
      waitsSoFar: 0,
      nowMs: NOW,
    });

    expect(short.reason).toBe("retry-after");
    expect(short.waitMs).toBe(60_000);

    const long = planRateLimitWait(limit({ retryAfterSeconds: 180 }), {
      waitsSoFar: 0,
      nowMs: NOW,
    });

    expect(long.waitMs).toBe(180_000);
  });

  it("backs off exponentially when GitHub says nothing", () => {
    const first = planRateLimitWait(limit(), { waitsSoFar: 0, nowMs: NOW, attempt: 1 });
    const second = planRateLimitWait(limit(), { waitsSoFar: 1, nowMs: NOW, attempt: 2 });

    expect(first.reason).toBe("backoff");
    expect(first.waitMs).toBe(60_000);
    expect(second.waitMs).toBe(120_000);
  });

  it("stops a run that has already waited its share", () => {
    const plan = planRateLimitWait(limit({ retryAfterSeconds: 5 }), {
      waitsSoFar: MAX_RATE_LIMIT_WAITS,
      nowMs: NOW,
    });

    expect(plan).toEqual({ waitMs: 0, until: null, reason: "too-many" });
  });

  it("treats a past reset as a secondary limit instead of sleeping backwards", () => {
    const resetAt = new Date(NOW - 60_000).toISOString();

    const plan = planRateLimitWait(limit({ resetAt, retryAfterSeconds: 5 }), {
      waitsSoFar: 0,
      nowMs: NOW,
    });

    expect(plan.reason).toBe("retry-after");
    expect(plan.waitMs).toBe(60_000);
  });

  it("counts the reset slack against the wait budget", () => {
    // 10 s inside the budget minus the 5 s slack still fits…
    const fitting = new Date(NOW + MAX_RATE_LIMIT_WAIT_MS - 10_000).toISOString();
    const plan = planRateLimitWait(limit({ resetAt: fitting }), { waitsSoFar: 0, nowMs: NOW });

    expect(plan.reason).toBe("reset");
    expect(plan.waitMs).toBeLessThanOrEqual(MAX_RATE_LIMIT_WAIT_MS);

    // …while a reset exactly at the budget does not, because of the slack.
    const boundary = new Date(NOW + MAX_RATE_LIMIT_WAIT_MS).toISOString();
    expect(
      planRateLimitWait(limit({ resetAt: boundary }), { waitsSoFar: 0, nowMs: NOW }).reason,
    ).toBe("too-long");
  });
});
