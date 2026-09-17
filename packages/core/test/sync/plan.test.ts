import { describe, expect, it } from "@effect/vitest";
import type { Repo, SyncCooldowns } from "@starwatch/domain";
import {
  canSync,
  diffStars,
  hashReadme,
  planEmbedWork,
  planReadmeWork,
  publishedReadmeHash,
  readmeBatchAction,
  type ReadmeFetchState,
} from "../../src/sync/plan.ts";

const repo = (id: number, overrides: Partial<Repo> = {}): Repo => ({
  id,
  fullName: `owner${id}/repo${id}`,
  owner: `owner${id}`,
  name: `repo${id}`,
  description: null,
  language: null,
  topics: [],
  stars: 0,
  forks: 0,
  archived: false,
  license: null,
  homepage: null,
  pushedAt: null,
  starredAt: null,
  htmlUrl: `https://github.com/owner${id}/repo${id}`,
  ...overrides,
});

const at = (day: number): string => `2026-01-${String(day).padStart(2, "0")}T00:00:00Z`;

const state = (
  repoId: number,
  checkedAt: string | null,
  status: ReadmeFetchState["status"],
): ReadmeFetchState => ({ repoId, checkedAt, status });

describe("diffStars", () => {
  it("returns added and removed ids in input order", () => {
    expect(diffStars([1, 2, 3], [3, 4, 5])).toEqual({
      added: [4, 5],
      removed: [1, 2],
    });
  });

  it("handles empty sides", () => {
    expect(diffStars([], [1, 2])).toEqual({ added: [1, 2], removed: [] });
    expect(diffStars([1, 2], [])).toEqual({ added: [], removed: [1, 2] });
    expect(diffStars([], [])).toEqual({ added: [], removed: [] });
  });

  it("is stable for identical sets in different order", () => {
    expect(diffStars([2, 1], [1, 2])).toEqual({ added: [], removed: [] });
  });
});

describe("planReadmeWork", () => {
  const repos = [
    repo(1, { pushedAt: at(1), starredAt: at(1) }),
    repo(2, { pushedAt: at(10), starredAt: at(2) }),
    repo(3, { pushedAt: at(3), starredAt: at(3) }),
    repo(4, { pushedAt: at(4), starredAt: at(4) }),
  ];

  it("selects new, errored and pushed-after-check repos, newest first", () => {
    const stateMap = new Map<number, ReadmeFetchState>([
      [1, state(1, at(1), "ok")],
      [2, state(2, at(1), "ok")],
      [4, state(4, at(4), "error")],
    ]);

    const batches = planReadmeWork(repos, stateMap, {
      batchSize: 2,
      semanticWindow: 100,
    });

    expect(batches).toEqual([[4, 3], [2]]);
  });

  it("skips repos checked after their last push", () => {
    const stateMap = new Map<number, ReadmeFetchState>([
      [1, state(1, at(1), "ok")],
      [2, state(2, at(10), "missing")],
      [3, state(3, at(3), "unavailable")],
      [4, state(4, at(4), "ok")],
    ]);

    expect(planReadmeWork(repos, stateMap, { batchSize: 25, semanticWindow: 100 })).toEqual([]);
  });

  it("rechecks missing/unavailable repos when pushed_at moves", () => {
    const twoRepos = [
      repo(1, { pushedAt: at(5), starredAt: at(1) }),
      repo(2, { pushedAt: at(6), starredAt: at(2) }),
    ];

    const stateMap = new Map<number, ReadmeFetchState>([
      [1, state(1, at(1), "missing")],
      [2, state(2, at(1), "unavailable")],
    ]);

    expect(
      planReadmeWork(twoRepos, stateMap, {
        batchSize: 25,
        semanticWindow: 100,
      }),
    ).toEqual([[2, 1]]);
  });

  it("plans a fresh pending row: the text is stored, the vector is not", () => {
    const stateMap = new Map<number, ReadmeFetchState>([[2, state(2, at(10), "pending")]]);
    const pendingRepo = repo(2, { pushedAt: at(10), starredAt: at(2) });

    expect(planReadmeWork([pendingRepo], stateMap, { batchSize: 25 })).toEqual([[2]]);
  });

  it("plans window repos this account has not published a vector for", () => {
    // 1 and 2 are fresh (no fetch needed) but absent from the account's blob,
    // which is embed-only work a shared README row must not hide.
    const stateMap = new Map<number, ReadmeFetchState>([
      [1, state(1, at(1), "ok")],
      [2, state(2, at(2), "ok")],
      [3, state(3, at(3), "ok")],
      [4, state(4, at(4), "ok")],
    ]);

    const batches = planReadmeWork(repos, stateMap, {
      batchSize: 25,
      existingVectorIds: new Set([3, 4]),
    });

    expect(batches).toEqual([[2, 1]]);
  });

  it("limits work to the newest semanticWindow repos", () => {
    const batches = planReadmeWork(repos, new Map(), {
      batchSize: 10,
      semanticWindow: 2,
    });

    expect(batches).toEqual([[4, 3]]);
  });

  it("sorts null starredAt last and keeps input order for ties", () => {
    const unordered = [
      repo(10, { starredAt: null }),
      repo(11, { starredAt: at(5) }),
      repo(12, { starredAt: at(5) }),
    ];

    expect(
      planReadmeWork(unordered, new Map(), {
        batchSize: 10,
        semanticWindow: 10,
      }),
    ).toEqual([[11, 12, 10]]);
  });
});

describe("readmeBatchAction", () => {
  const repoRow = repo(1, { pushedAt: at(5) });

  it("reuses the stored text of a fresh pending row instead of re-fetching", () => {
    expect(readmeBatchAction(repoRow, state(1, at(5), "pending"), "stored readme")).toEqual({
      kind: "reuse",
      text: "stored readme",
      state: "present",
    });
  });

  it("reuses a confirmed-missing README as missing, without a fetch", () => {
    expect(readmeBatchAction(repoRow, state(1, at(5), "pending"), undefined)).toEqual({
      kind: "reuse",
      text: "",
      state: "missing",
    });
  });

  it("reuses a current published row that is only embed work", () => {
    expect(readmeBatchAction(repoRow, state(1, at(5), "ok"), "stored readme")).toEqual({
      kind: "reuse",
      text: "stored readme",
      state: "present",
    });
  });

  it("fetches when the last attempt errored or the repo moved since the check", () => {
    expect(readmeBatchAction(repoRow, state(1, at(5), "error"), "stale text")).toEqual({
      kind: "fetch",
    });
    expect(readmeBatchAction(repoRow, state(1, at(1), "ok"), "stale text")).toEqual({
      kind: "fetch",
    });
    expect(readmeBatchAction(repoRow, undefined, undefined)).toEqual({ kind: "fetch" });
  });
});

describe("hashReadme", () => {
  it("is stable and distinguishes content", () => {
    expect(hashReadme("hello")).toBe(hashReadme("hello"));
    expect(hashReadme("hello")).not.toBe(hashReadme("hello!"));
    expect(hashReadme("")).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe("planEmbedWork", () => {
  const repos = [
    repo(1, { starredAt: at(1) }),
    repo(2, { starredAt: at(2) }),
    repo(3, { starredAt: at(3) }),
    repo(4, { starredAt: at(4) }),
  ];

  it("returns repos whose README hash changed or is missing", () => {
    const readmes = new Map<number, string>([
      [1, "unchanged"],
      [2, "changed"],
      [3, ""],
      [4, "fresh"],
    ]);

    const existing = new Map<number, string>([
      [1, hashReadme("unchanged")],
      [2, hashReadme("old content")],
      [3, hashReadme("")],
    ]);

    expect(planEmbedWork(repos, readmes, existing)).toEqual([4, 2]);
  });

  it("treats an absent README as an empty document", () => {
    const readmes = new Map<number, string>([[1, ""]]);
    const existing = new Map<number, string>([[1, hashReadme("")]]);
    expect(
      planEmbedWork(
        [repo(1, { starredAt: at(1) }), repo(2, { starredAt: at(2) })],
        readmes,
        existing,
      ),
    ).toEqual([2]);
  });

  it("only embeds the newest 1,500 repos", () => {
    const many = Array.from({ length: 1_501 }, (_, index) =>
      repo(index + 1, { starredAt: at(1 + (index % 28)) }),
    );

    const dirty = planEmbedWork(many, new Map(), new Map());
    expect(dirty).toHaveLength(1_500);
    expect(dirty[0]).toBe(28);
  });
});

describe("canSync", () => {
  const cooldowns: SyncCooldowns = {
    relistSeconds: 900,
    fullRefreshSeconds: 24 * 60 * 60,
  };

  const nowMs = 1_800_000_000_000;

  it("blocks while a job is in progress, even with force", () => {
    const result = canSync(
      { inProgress: true, lastRelistAtMs: null, lastFullRefreshAtMs: null },
      nowMs,
      cooldowns,
      { force: true },
    );

    expect(result).toEqual({
      allowed: false,
      reason: "in-progress",
      retryAfterSeconds: 0,
    });
  });

  it("allows a first sync", () => {
    expect(
      canSync(
        { inProgress: false, lastRelistAtMs: null, lastFullRefreshAtMs: null },
        nowMs,
        cooldowns,
      ),
    ).toEqual({ allowed: true, reason: "ok", retryAfterSeconds: 0 });
  });

  it("reports the re-list cooldown with ceil seconds remaining", () => {
    const result = canSync(
      {
        inProgress: false,
        lastRelistAtMs: nowMs - 500_000,
        lastFullRefreshAtMs: null,
      },
      nowMs,
      cooldowns,
    );

    expect(result).toEqual({
      allowed: false,
      reason: "cooldown-relist",
      retryAfterSeconds: 400,
    });
  });

  it("prefers the stricter full-refresh cooldown when both apply", () => {
    const result = canSync(
      {
        inProgress: false,
        lastRelistAtMs: nowMs - 60_000,
        lastFullRefreshAtMs: nowMs - 3_600_000,
      },
      nowMs,
      cooldowns,
    );

    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("cooldown-full");
    expect(result.retryAfterSeconds).toBe(23 * 60 * 60);
  });

  it("force bypasses cooldowns", () => {
    const result = canSync(
      {
        inProgress: false,
        lastRelistAtMs: nowMs - 1_000,
        lastFullRefreshAtMs: nowMs - 1_000,
      },
      nowMs,
      cooldowns,
      { force: true },
    );

    expect(result).toEqual({
      allowed: true,
      reason: "ok",
      retryAfterSeconds: 0,
    });
  });

  it("allows a re-list once the relist window has passed", () => {
    const result = canSync(
      {
        inProgress: false,
        lastRelistAtMs: nowMs - 901_000,
        lastFullRefreshAtMs: nowMs - 25 * 60 * 60 * 1000,
      },
      nowMs,
      cooldowns,
    );

    expect(result.allowed).toBe(true);
  });
});

describe("publishedReadmeHash", () => {
  it("hashes the text of a published row", () => {
    expect(publishedReadmeHash("ok", "hello")).toBe(hashReadme("hello"));
    // A repo with no README is embedded from metadata alone, so its published
    // hash is the hash of the empty document.
    expect(publishedReadmeHash("missing", undefined)).toBe(hashReadme(""));
  });

  it("marks an unpublished row dirty, whatever text it carries", () => {
    // `pending` = text stored, vector still in an unmerged part.
    expect(publishedReadmeHash("pending", "hello")).toBe("");
    expect(publishedReadmeHash("error", "hello")).toBe("");
    expect(publishedReadmeHash("unavailable", "hello")).toBe("");
    expect(publishedReadmeHash(undefined, "hello")).toBe("");
  });

  it("never returns a value that could be mistaken for a real hash", () => {
    expect(hashReadme("")).not.toBe("");
  });
});
