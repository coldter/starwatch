import { describe, expect, it } from "@effect/vitest";
import { MERGE_FAN_IN, README_FETCH_BATCH } from "../src/constants.ts";
import {
  vectorBlobBinKey,
  vectorIdsKey,
  vectorMergeBaseKey,
  vectorPartBaseKey,
} from "../src/adapters/vector-bucket.ts";
import {
  README_BATCHES_PER_INSTANCE,
  refreshChainStepBudget,
  refreshSliceId,
  refreshSliceStepBudget,
} from "../src/sync/refresh-workflow.ts";

/**
 * The refresh chain's structural budgets: steps per instance (the free plan caps
 * a workflow instance at 1,024) and per chained run, plus the instance ids the
 * chain hands work to — and which R2 keys its scratch objects live at (two
 * overlapping runs must not collide).
 */

describe("refreshSliceStepBudget", () => {
  it("counts the plan, the batch, the worst-case waits and the hand-off", () => {
    // 1 plan + 1 batch + 2 rate-limit waits (sleep + retry, the worst case is
    // per run) + 1 hand-off.
    expect(refreshSliceStepBudget(1)).toBe(1 + 1 + 4 + 1);
  });

  it("advances by at least one batch, so the chain always terminates", () => {
    expect(README_BATCHES_PER_INSTANCE).toBeGreaterThanOrEqual(1);
  });

  it("stays far under the 1,000-step per-instance cap", () => {
    expect(refreshSliceStepBudget(1)).toBeLessThan(1_000);
  });

  it("budgets an empty slice as plan plus close", () => {
    expect(refreshSliceStepBudget(0, 0)).toBe(2);
  });
});

describe("refreshChainStepBudget", () => {
  it("counts one instance per batch, the run's waits, heartbeats and merges", () => {
    const repos = 1_500;
    const batches = Math.ceil(repos / README_FETCH_BATCH);

    expect(batches).toBe(188);
    // 188 instances × (plan + batch + hand-off) + 2 waits × 2 steps
    // + 47 heartbeats (one per 4 batches) + 5 fan-in merges.
    expect(refreshChainStepBudget(repos)).toBe(188 * 3 + 4 + 47 + 5);
  });

  it("adds no merge level when the parts already fit the fan-in width", () => {
    const batches = MERGE_FAN_IN;

    expect(batches).toBe(40);
    // The merge loop only runs while `parts > MERGE_FAN_IN`, so a window whose
    // parts exactly fill one merge costs no merge step at all.
    expect(refreshChainStepBudget(batches * README_FETCH_BATCH)).toBe(40 * 3 + 4 + 10);
  });

  it("buys a handful of full windows inside a day's step budget", () => {
    // Free plan: 3,000 steps/day (docs/13 §2). This is the number that decides
    // how many accounts a day the deployment can index.
    expect(refreshChainStepBudget(1_500)).toBeLessThan(3_000);
    expect(Math.floor(3_000 / refreshChainStepBudget(1_500))).toBe(4);
  });
});

describe("refreshSliceId", () => {
  it("stays inside the 100-character instance-id limit", () => {
    const login = "a".repeat(39);
    const id = refreshSliceId(login, "b".repeat(36), 9_999);

    expect(id.length).toBeLessThanOrEqual(100);
  });

  it("is unique per slice and stable for a run", () => {
    expect(refreshSliceId("alice", "run-a", 0)).not.toBe(refreshSliceId("alice", "run-a", 8));
    expect(refreshSliceId("alice", "run-a", 8)).toBe(refreshSliceId("alice", "run-a", 8));
  });
});

describe("vector scratch keys", () => {
  it("scopes part and merge keys to one run", () => {
    const partA = vectorPartBaseKey("alice", "run-a", 3);
    const partB = vectorPartBaseKey("alice", "run-b", 3);

    expect(partA).not.toBe(partB);
    expect(partA).toContain("run-a");
    expect(vectorMergeBaseKey("alice", "run-a", 1, 0)).toContain("run-a");
    expect(vectorMergeBaseKey("alice", "run-a", 1, 0)).not.toContain("run-b");
  });

  it("keeps the published blob independent of any run token", () => {
    expect(vectorBlobBinKey("alice")).toBe("vectors/alice.bin");
    expect(vectorIdsKey("alice")).toBe("vectors/alice.ids.json");
  });

  it("namespaces scratch objects under the user, never beside the blob", () => {
    const part = vectorPartBaseKey("alice", "run-a", 0);
    const merge = vectorMergeBaseKey("alice", "run-a", 1, 0);

    expect(part.startsWith("vectors/alice/")).toBe(true);
    expect(merge.startsWith("vectors/alice/")).toBe(true);
    expect(part).not.toBe(vectorBlobBinKey("alice"));
  });
});
