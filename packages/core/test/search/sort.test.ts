import { describe, expect, it } from "@effect/vitest";
import type { Repo, SearchSort } from "@starwatch/domain";
import { compareHits, sortHits } from "../../src/search/sort.ts";

type RepoInit = Partial<Repo> & Pick<Repo, "id" | "name">;

const makeRepo = ({ id, name, ...rest }: RepoInit): Repo => ({
  id,
  name,
  owner: "octo",
  fullName: `octo/${name}`,
  description: null,
  language: "TypeScript",
  topics: [],
  stars: 0,
  forks: 0,
  archived: false,
  license: null,
  homepage: null,
  pushedAt: null,
  starredAt: null,
  htmlUrl: `https://github.com/octo/${name}`,
  ...rest,
});

/** Fused order is meaningful: ids are handed out in relevance order. */
const hits = (repos: ReadonlyArray<Repo>): Array<{ repo: Repo }> => repos.map((repo) => ({ repo }));

const orderOf = (sorted: ReadonlyArray<{ repo: Repo }>): ReadonlyArray<number> =>
  sorted.map((hit) => hit.repo.id);

describe("sortHits", () => {
  it("keeps the fused order for relevance, without mutating the input", () => {
    const input = hits([
      makeRepo({ id: 3, name: "c" }),
      makeRepo({ id: 1, name: "a" }),
      makeRepo({ id: 2, name: "b" }),
    ]);

    const sorted = sortHits(input, "relevance");

    expect(orderOf(sorted)).toEqual([3, 1, 2]);
    expect(orderOf(input)).toEqual([3, 1, 2]);
  });

  it("orders by last push, newest first", () => {
    const sorted = sortHits(
      hits([
        makeRepo({ id: 1, name: "old", pushedAt: "2024-01-01T00:00:00Z" }),
        makeRepo({ id: 2, name: "new", pushedAt: "2026-05-01T00:00:00Z" }),
        makeRepo({ id: 3, name: "mid", pushedAt: "2025-03-01T00:00:00Z" }),
      ]),
      "pushed",
    );

    expect(orderOf(sorted)).toEqual([2, 3, 1]);
  });

  it("orders by stars, then starred_at, then repo id", () => {
    const sorted = sortHits(
      hits([
        makeRepo({ id: 5, name: "few", stars: 10, starredAt: "2026-01-01T00:00:00Z" }),
        makeRepo({ id: 9, name: "many-lo", stars: 90, starredAt: "2024-01-01T00:00:00Z" }),
        makeRepo({ id: 4, name: "many-hi", stars: 90, starredAt: "2025-01-01T00:00:00Z" }),
        makeRepo({ id: 2, name: "many-tie", stars: 90, starredAt: "2025-01-01T00:00:00Z" }),
      ]),
      "stars",
    );

    // 90 stars first; equal stars fall back to starred_at desc, then id asc.
    expect(orderOf(sorted)).toEqual([2, 4, 9, 5]);
  });

  it("orders by the user's own starred date, newest first", () => {
    const sorted = sortHits(
      hits([
        makeRepo({ id: 1, name: "a", starredAt: "2023-06-01T00:00:00Z" }),
        makeRepo({ id: 2, name: "b", starredAt: "2026-02-01T00:00:00Z" }),
        makeRepo({ id: 3, name: "c", starredAt: "2024-01-01T00:00:00Z" }),
      ]),
      "starred",
    );

    expect(orderOf(sorted)).toEqual([2, 3, 1]);
  });

  it("sorts missing dates last instead of treating them as newest", () => {
    const sorted = sortHits(
      hits([
        makeRepo({ id: 1, name: "never-pushed", pushedAt: null }),
        makeRepo({ id: 2, name: "pushed", pushedAt: "2020-01-01T00:00:00Z" }),
      ]),
      "pushed",
    );

    expect(orderOf(sorted)).toEqual([2, 1]);
  });

  it("ignores unparseable dates rather than ordering them first", () => {
    const sorted = sortHits(
      hits([
        makeRepo({ id: 1, name: "bad", pushedAt: "not-a-date" }),
        makeRepo({ id: 2, name: "good", pushedAt: "2020-01-01T00:00:00Z" }),
      ]),
      "pushed",
    );

    expect(orderOf(sorted)).toEqual([2, 1]);
  });

  it("is deterministic for equal keys, whatever the input order", () => {
    const repos = [
      makeRepo({ id: 7, name: "g", stars: 5, starredAt: "2024-01-01T00:00:00Z" }),
      makeRepo({ id: 8, name: "h", stars: 5, starredAt: "2024-01-01T00:00:00Z" }),
      makeRepo({ id: 3, name: "c", stars: 5, starredAt: "2024-01-01T00:00:00Z" }),
    ];

    const forward = orderOf(sortHits(hits(repos), "stars"));
    const backward = orderOf(sortHits(hits([...repos].reverse()), "stars"));

    expect(forward).toEqual([3, 7, 8]);
    expect(backward).toEqual(forward);
  });

  it("exposes a comparator that matches sortHits for every key", () => {
    const sorts: ReadonlyArray<SearchSort> = ["stars", "starred", "pushed"];

    const left = {
      repo: makeRepo({
        id: 1,
        name: "a",
        stars: 4,
        pushedAt: "2024-01-01T00:00:00Z",
        starredAt: "2023-01-01T00:00:00Z",
      }),
    };

    const right = {
      repo: makeRepo({
        id: 2,
        name: "b",
        stars: 9,
        pushedAt: "2025-01-01T00:00:00Z",
        starredAt: "2024-01-01T00:00:00Z",
      }),
    };

    for (const sort of sorts) {
      expect(compareHits(right, left, sort)).toBeLessThan(0);
      expect(compareHits(left, right, sort)).toBeGreaterThan(0);
      expect(compareHits(left, left, sort)).toBe(0);
    }
  });
});
