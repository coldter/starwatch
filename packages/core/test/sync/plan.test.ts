import { describe, expect, it } from "@effect/vitest";
import type { Repo, SyncCooldowns } from "@starwatch/domain";
import {
  canSync,
  diffStars,
  hashReadme,
  planEmbedWork,
  planReadmeWork,
  type ReadmeFetchState
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
  ...overrides
});

const at = (day: number): string => `2026-01-${String(day).padStart(2, "0")}T00:00:00Z`;

const state = (
  repoId: number,
  pushedAt: string | null,
  status: ReadmeFetchState["status"]
): ReadmeFetchState => ({ repoId, pushedAt, status });

describe("diffStars", () => {
  it("returns added and removed ids in input order", () => {
    expect(diffStars([1, 2, 3], [3, 4, 5])).toEqual({ added: [4, 5], removed: [1, 2] });
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
    repo(1, { pushedAt: "a", starredAt: at(1) }),
    repo(2, { pushedAt: "b", starredAt: at(2) }),
    repo(3, { pushedAt: "new", starredAt: at(3) }),
    repo(4, { pushedAt: "d", starredAt: at(4) })
  ];

  it("selects new, errored and pushed_at-changed repos, newest first", () => {
    const stateMap = new Map<number, ReadmeFetchState>([
      [2, state(2, "b", "ok")],
      [3, state(3, "old", "ok")],
      [4, state(4, "d", "error")]
    ]);
    const batches = planReadmeWork(repos, stateMap, { batchSize: 2, semanticWindow: 100 });
    expect(batches).toEqual([
      [4, 3],
      [1]
    ]);
  });

  it("skips untouched ok/missing/unavailable repos", () => {
    const stateMap = new Map<number, ReadmeFetchState>([
      [1, state(1, "a", "ok")],
      [2, state(2, "b", "missing")],
      [3, state(3, "new", "unavailable")],
      [4, state(4, "d", "ok")]
    ]);
    expect(planReadmeWork(repos, stateMap, { batchSize: 25, semanticWindow: 100 })).toEqual([]);
  });

  it("rechecks missing/unavailable repos when pushed_at moves", () => {
    const twoRepos = [
      repo(1, { pushedAt: "a", starredAt: at(1) }),
      repo(2, { pushedAt: "b", starredAt: at(2) })
    ];
    const stateMap = new Map<number, ReadmeFetchState>([
      [1, state(1, "old", "missing")],
      [2, state(2, "old", "unavailable")]
    ]);
    expect(planReadmeWork(twoRepos, stateMap, { batchSize: 25, semanticWindow: 100 })).toEqual([
      [2, 1]
    ]);
  });

  it("limits work to the newest semanticWindow repos", () => {
    const batches = planReadmeWork(repos, new Map(), { batchSize: 10, semanticWindow: 2 });
    expect(batches).toEqual([[4, 3]]);
  });

  it("sorts null starredAt last and keeps input order for ties", () => {
    const unordered = [
      repo(10, { starredAt: null }),
      repo(11, { starredAt: at(5) }),
      repo(12, { starredAt: at(5) })
    ];
    expect(planReadmeWork(unordered, new Map(), { batchSize: 10, semanticWindow: 10 })).toEqual([
      [11, 12, 10]
    ]);
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
    repo(4, { starredAt: at(4) })
  ];

  it("returns repos whose README hash changed or is missing", () => {
    const readmes = new Map<number, string>([
      [1, "unchanged"],
      [2, "changed"],
      [3, ""],
      [4, "fresh"]
    ]);
    const existing = new Map<number, string>([
      [1, hashReadme("unchanged")],
      [2, hashReadme("old content")],
      [3, hashReadme("")]
    ]);
    expect(planEmbedWork(repos, readmes, existing)).toEqual([4, 2]);
  });

  it("treats an absent README as an empty document", () => {
    const readmes = new Map<number, string>([[1, ""]]);
    const existing = new Map<number, string>([[1, hashReadme("")]]);
    expect(planEmbedWork([repo(1, { starredAt: at(1) }), repo(2, { starredAt: at(2) })], readmes, existing)).toEqual([
      2
    ]);
  });

  it("only embeds the newest 1,500 repos", () => {
    const many = Array.from({ length: 1_501 }, (_, index) =>
      repo(index + 1, { starredAt: at(1 + (index % 28)) })
    );
    const dirty = planEmbedWork(many, new Map(), new Map());
    expect(dirty).toHaveLength(1_500);
    expect(dirty[0]).toBe(28);
  });
});

describe("canSync", () => {
  const cooldowns: SyncCooldowns = { relistSeconds: 900, fullRefreshSeconds: 24 * 60 * 60 };
  const nowMs = 1_800_000_000_000;

  it("blocks while a job is in progress, even with force", () => {
    const result = canSync(
      { inProgress: true, lastRelistAtMs: null, lastFullRefreshAtMs: null },
      nowMs,
      cooldowns,
      { force: true }
    );
    expect(result).toEqual({ allowed: false, reason: "in-progress", retryAfterSeconds: 0 });
  });

  it("allows a first sync", () => {
    expect(canSync({ inProgress: false, lastRelistAtMs: null, lastFullRefreshAtMs: null }, nowMs, cooldowns)).toEqual(
      { allowed: true, reason: "ok", retryAfterSeconds: 0 }
    );
  });

  it("reports the re-list cooldown with ceil seconds remaining", () => {
    const result = canSync(
      { inProgress: false, lastRelistAtMs: nowMs - 500_000, lastFullRefreshAtMs: null },
      nowMs,
      cooldowns
    );
    expect(result).toEqual({
      allowed: false,
      reason: "cooldown-relist",
      retryAfterSeconds: 400
    });
  });

  it("prefers the stricter full-refresh cooldown when both apply", () => {
    const result = canSync(
      {
        inProgress: false,
        lastRelistAtMs: nowMs - 60_000,
        lastFullRefreshAtMs: nowMs - 3_600_000
      },
      nowMs,
      cooldowns
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
        lastFullRefreshAtMs: nowMs - 1_000
      },
      nowMs,
      cooldowns,
      { force: true }
    );
    expect(result).toEqual({ allowed: true, reason: "ok", retryAfterSeconds: 0 });
  });

  it("allows a re-list once the relist window has passed", () => {
    const result = canSync(
      {
        inProgress: false,
        lastRelistAtMs: nowMs - 901_000,
        lastFullRefreshAtMs: nowMs - 25 * 60 * 60 * 1000
      },
      nowMs,
      cooldowns
    );
    expect(result.allowed).toBe(true);
  });
});
