import { describe, expect, it } from "@effect/vitest";
import { GithubRateLimited, GithubUpstream, UserNotFound } from "@starwatch/domain";
import { isPerRepoReadmeFailure } from "../src/sync/refresh-workflow.ts";

/**
 * Which README fetch failures the refresh run survives.
 *
 * The distinction the pipeline turns on is *whose* problem the failure is. A
 * connection that never landed says nothing about the repo — GitHub's raw CDN
 * drops pooled connections, and the client already reports that as
 * `GithubUpstream` with `status: 0` — so one such repo must not cost the other
 * seven READMEs of its batch. Everything else (a 404, a 5xx, a rate limit, a
 * user that vanished) is an answer about the batch or the account and still
 * fails the run.
 */

const upstream = (status: number): GithubUpstream =>
  new GithubUpstream({ message: `upstream ${status}`, status });

describe("isPerRepoReadmeFailure", () => {
  it("treats a connection that never landed as a per-repo failure", () => {
    // Status 0 covers both a transport error and the client's own 20 s request
    // timeout: neither carries a fact about the repo.
    expect(isPerRepoReadmeFailure(upstream(0))).toBe(true);
  });

  it("keeps GitHub's own answers fatal to the batch", () => {
    expect(isPerRepoReadmeFailure(upstream(404))).toBe(false);
    expect(isPerRepoReadmeFailure(upstream(500))).toBe(false);
    expect(isPerRepoReadmeFailure(upstream(502))).toBe(false);
  });

  it("keeps limits and vanished accounts fatal to the run", () => {
    const limited = new GithubRateLimited({
      message: "rate limited",
      resetAt: null,
      retryAfterSeconds: 60,
    });

    // A rate limit has a reset to wait out (the batch loop's own path); a
    // deleted account is terminal for the whole run.
    expect(isPerRepoReadmeFailure(limited)).toBe(false);
    expect(isPerRepoReadmeFailure(new UserNotFound({ login: "gone" }))).toBe(false);
  });
});
