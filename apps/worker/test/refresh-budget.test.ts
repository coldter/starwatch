import { describe, expect, it } from "@effect/vitest";
import { MERGE_FAN_IN, README_FETCH_BATCH, README_PROGRESS_EVERY } from "../src/constants.ts";
import {
  vectorBlobBinKey,
  vectorIdsKey,
  vectorMergeBaseKey,
  vectorPartBaseKey,
} from "../src/adapters/vector-bucket.ts";
import { refreshStepBudget } from "../src/sync/refresh-workflow.ts";

/**
 * The refresh workflow's two structural budgets: how many steps one run costs
 * (it must stay under the per-instance cap) and which R2 keys its scratch
 * objects live at (two overlapping runs must not collide).
 */

describe("refreshStepBudget", () => {
  it("counts plan, batches, retries, heartbeats, merges and finalize", () => {
    const repos = 1_500;
    const batches = Math.ceil(repos / README_FETCH_BATCH);

    expect(batches).toBe(188);
    // 1 plan + 188 batches + 2 rate-limit waits (each a sleep step) + 2 retry
    // attempts + 47 heartbeats + 5 fan-in merges + 1 finalize.
    expect(refreshStepBudget(repos)).toBe(1 + 188 + 4 + 47 + 5 + 1);
  });

  it("stays well under the 1,000-step per-instance cap for a full window", () => {
    expect(refreshStepBudget(1_500)).toBeLessThan(1_000);
    expect(refreshStepBudget(1_500)).toBe(246);
  });

  it("adds no merge level when the parts already fit the fan-in width", () => {
    const batches = MERGE_FAN_IN;

    expect(batches).toBe(40);
    // The merge loop only runs while `parts > MERGE_FAN_IN`, so a window whose
    // parts exactly fill one merge costs no merge step at all.
    expect(refreshStepBudget(batches * README_FETCH_BATCH)).toBe(
      1 + batches + 4 + Math.floor(batches / README_PROGRESS_EVERY) + 1,
    );
  });

  it("still budgets the fixed steps for an empty window", () => {
    expect(refreshStepBudget(0)).toBe(2);
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
