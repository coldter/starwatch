import { describe, expect, it } from "@effect/vitest";
import type { Repo } from "@starwatch/domain";
import { expandQuery } from "../../src/search/expand.ts";
import {
  ARCHIVED_PENALTY,
  DEFAULT_LEG_WEIGHTS,
  DESCRIPTION_OVERLAP_PER_TERM,
  NAME_DUPLICATE_PENALTY,
  NAME_EXACT_FACTOR,
  OWNER_DUPLICATE_PENALTY,
  RRF_K,
  STAR_PRIOR_CAP,
  STAR_PRIOR_REFERENCE,
  TOPIC_OVERLAP_PER_TERM,
  computeNameStats,
  fuse,
  nameBoost,
  normalizeName,
  overlapBonus,
  rankByScore,
  starPrior,
  termSpecificity,
  toRanked
} from "../../src/search/fusion.ts";

type RepoInit = Partial<Repo> & Pick<Repo, "id" | "name" | "owner">;

const makeRepo = ({ id, name, owner, ...rest }: RepoInit): Repo => ({
  id,
  name,
  owner,
  fullName: `${owner}/${name}`,
  description: null,
  language: "TypeScript",
  topics: [],
  stars: 0,
  forks: 0,
  archived: false,
  license: "MIT",
  homepage: null,
  pushedAt: null,
  starredAt: null,
  htmlUrl: `https://github.com/${owner}/${name}`,
  ...rest
});

const repoMap = (...repos: Repo[]): Map<number, Repo> =>
  new Map(repos.map((repo) => [repo.id, repo] as const));

describe("rank primitives", () => {
  it("copies leg rows with toRanked", () => {
    expect(toRanked([{ repoId: 3, rank: 1 }])).toEqual([{ repoId: 3, rank: 1 }]);
  });

  it("converts cosine scores to rank order, breaking ties by repoId", () => {
    expect(
      rankByScore([
        { repoId: 7, score: 0.4 },
        { repoId: 3, score: 0.9 },
        { repoId: 5, score: 0.4 }
      ])
    ).toEqual([
      { repoId: 3, rank: 1 },
      { repoId: 5, rank: 2 },
      { repoId: 7, rank: 3 }
    ]);
  });
});

describe("name statistics and specificity gating", () => {
  it("computes document frequency per name token, once per repo", () => {
    const stats = computeNameStats([
      makeRepo({ id: 1, name: "better-auth", owner: "a" }),
      makeRepo({ id: 2, name: "auth-tools", owner: "b" }),
      makeRepo({ id: 3, name: "auth-auth", owner: "c" }),
      makeRepo({ id: 4, name: "lazygit", owner: "d" })
    ]);
    expect(stats.get("auth")).toBe(3);
    expect(stats.get("better")).toBe(1);
    expect(stats.get("lazygit")).toBe(1);
    expect(stats.get("missing")).toBeUndefined();
  });

  it("decreases specificity as document frequency grows", () => {
    const stats = new Map([
      ["auth", 117],
      ["lazygit", 1]
    ]);
    expect(termSpecificity("lazygit", stats)).toBeGreaterThan(termSpecificity("auth", stats));
    expect(termSpecificity("unseen", stats)).toBe(1);
  });

  it("damps generic name matches (high-df `vector`) below distinctive ones", () => {
    const vectors = Array.from({ length: 12 }, (_, i) =>
      makeRepo({ id: i + 1, name: `vector-${i + 1}`, owner: "vector-owner" })
    );
    const exactVector = makeRepo({ id: 13, name: "vector", owner: "vector-io" });
    const lazygit = makeRepo({ id: 100, name: "lazygit", owner: "jesseduffield" });
    const stats = computeNameStats([...vectors, exactVector, lazygit]);

    const vectorBoost = nameBoost(exactVector, ["vector"], stats);
    const lazygitBoost = nameBoost(lazygit, ["lazygit"], stats);

    expect(vectorBoost).toBeGreaterThan(1);
    expect(vectorBoost).toBeLessThan(1.15);
    expect(lazygitBoost).toBeGreaterThan(vectorBoost);
    expect(vectorBoost).toBeCloseTo(
      1 + (NAME_EXACT_FACTOR - 1) * termSpecificity("vector", stats),
      12
    );
  });

  it("tiers exact > prefix > token and gates all of them by specificity", () => {
    const better = makeRepo({ id: 1, name: "better-auth", owner: "better-auth" });
    const exact = makeRepo({ id: 2, name: "auth", owner: "nuxflare" });
    const drizzle = makeRepo({ id: 3, name: "drizzle-orm", owner: "drizzle-team" });
    const repos = [better, exact, drizzle];
    const stats = computeNameStats(repos);

    const exactBoost = nameBoost(exact, ["auth"], stats);
    const tokenBoost = nameBoost(better, ["auth"], stats);
    const prefixBoost = nameBoost(drizzle, ["drizzle"], stats);
    const tokenOnlyBoost = nameBoost(drizzle, ["orm"], stats);

    expect(exactBoost).toBeGreaterThan(tokenBoost);
    expect(prefixBoost).toBeGreaterThan(tokenOnlyBoost);
    // df=2 for `auth`: even an exact match never reaches the undamped tier
    expect(exactBoost).toBeLessThan(NAME_EXACT_FACTOR);
  });

  it("returns 1 when nothing matches", () => {
    const repo = makeRepo({ id: 1, name: "lazygit", owner: "jesseduffield" });
    expect(nameBoost(repo, ["quantum"], new Map())).toBe(1);
    expect(nameBoost(repo, [], new Map())).toBe(1);
  });

  it("normalizes names for duplicate detection", () => {
    expect(normalizeName("Better-Auth_UI")).toBe("betterauthui");
  });
});

describe("star prior", () => {
  it("follows the documented curve and caps at x1.25", () => {
    expect(starPrior(0)).toBe(1);
    expect(starPrior(-10)).toBe(1);
    expect(starPrior(100)).toBeGreaterThan(1);
    expect(starPrior(1000)).toBeGreaterThan(starPrior(100));
    expect(starPrior(STAR_PRIOR_REFERENCE)).toBeCloseTo(STAR_PRIOR_CAP, 12);
    expect(starPrior(10_000_000)).toBe(STAR_PRIOR_CAP);
  });
});

describe("fuse", () => {
  it("computes the hand-checked RRF value for a single keyword rank 1", () => {
    const solo = makeRepo({ id: 1, name: "solo", owner: "someone" });
    const hits = fuse({ keyword: toRanked([{ repoId: 1, rank: 1 }]), repos: repoMap(solo) });
    expect(hits).toHaveLength(1);
    expect(hits[0]?.score).toBeCloseTo(1 / (RRF_K + 1), 12);
  });

  it("keeps the best rank when the same repo appears twice in one leg", () => {
    const repo = makeRepo({ id: 1, name: "solo", owner: "someone" });
    const hits = fuse({
      keyword: toRanked([
        { repoId: 1, rank: 5 },
        { repoId: 1, rank: 2 }
      ]),
      repos: repoMap(repo)
    });
    expect(hits[0]?.score).toBeCloseTo(1 / (RRF_K + 2), 12);
  });

  it("weights keyword 1.0 over expanded 0.6 at equal rank", () => {
    const keywordHit = makeRepo({ id: 1, name: "alpha", owner: "oa" });
    const expandedHit = makeRepo({ id: 2, name: "beta", owner: "ob" });
    const hits = fuse({
      keyword: toRanked([{ repoId: 1, rank: 1 }]),
      expanded: toRanked([{ repoId: 2, rank: 1 }]),
      repos: repoMap(keywordHit, expandedHit)
    });
    expect(hits).toHaveLength(2);
    expect(hits[0]?.repo.id).toBe(1);
    expect(hits[0]!.score / hits[1]!.score).toBeCloseTo(1 / DEFAULT_LEG_WEIGHTS.expanded, 6);
  });

  it("honors eval weight overrides", () => {
    const keywordHit = makeRepo({ id: 1, name: "alpha", owner: "oa" });
    const expandedHit = makeRepo({ id: 2, name: "beta", owner: "ob" });
    const hits = fuse(
      {
        keyword: toRanked([{ repoId: 1, rank: 1 }]),
        expanded: toRanked([{ repoId: 2, rank: 1 }]),
        repos: repoMap(keywordHit, expandedHit)
      },
      { weights: { expanded: 2 } }
    );
    expect(hits[0]?.repo.id).toBe(2);
  });

  it("ranks better-auth above nuxflare/auth under the auth--lang=ts scenario", () => {
    const betterAuth = makeRepo({
      id: 1,
      owner: "better-auth",
      name: "better-auth",
      stars: 30_000,
      description: "The most comprehensive authentication framework for TypeScript",
      topics: ["authentication", "oauth"]
    });
    const logto = makeRepo({
      id: 2,
      owner: "logto-io",
      name: "logto",
      stars: 14_000,
      description: "Identity infrastructure for modern apps",
      topics: ["authentication"]
    });
    const nuxflareAuth = makeRepo({
      id: 3,
      owner: "nuxflare",
      name: "auth",
      stars: 24,
      description: "Auth server in a box",
      topics: ["authentication"]
    });
    const openauth = makeRepo({
      id: 4,
      owner: "anomalyco",
      name: "openauth",
      stars: 5_000,
      description: "Open source auth infrastructure",
      topics: ["oauth"]
    });
    // Present in the corpus but excluded by the hard `language=TypeScript` filter.
    const casbin = makeRepo({
      id: 5,
      owner: "casbin",
      name: "casbin",
      stars: 18_000,
      language: "Go",
      description: "An authorization library that supports access control models",
      topics: ["authorization"]
    });

    const corpus = [betterAuth, logto, nuxflareAuth, openauth, casbin];
    const eligible = corpus.filter((repo) => repo.language === "TypeScript");
    const expansion = expandQuery("auth");
    const nameStats = computeNameStats(corpus);

    const hits = fuse(
      {
        keyword: toRanked([
          { repoId: 1, rank: 1 },
          { repoId: 3, rank: 2 },
          { repoId: 4, rank: 3 }
        ]),
        expanded: toRanked([
          { repoId: 1, rank: 1 },
          { repoId: 4, rank: 2 },
          { repoId: 2, rank: 3 }
        ]),
        semantic: toRanked([
          { repoId: 2, rank: 1 },
          { repoId: 1, rank: 2 },
          { repoId: 4, rank: 3 },
          { repoId: 3, rank: 40 }
        ]),
        repos: repoMap(...eligible)
      },
      {
        queryTokens: ["auth"],
        conceptTerms: expansion.terms,
        nameStats
      }
    );

    const names = hits.map((hit) => hit.repo.fullName);
    expect(names[0]).toBe("better-auth/better-auth");
    expect(names.indexOf("better-auth/better-auth")).toBeLessThan(
      names.indexOf("nuxflare/auth")
    );
    expect(names).not.toContain("casbin/casbin");
    expect(hits.every((hit) => hit.repo.language === "TypeScript")).toBe(true);
    // Specificity gating: even the exact name match `auth` is damped, never ×1.45.
    expect(nameBoost(nuxflareAuth, ["auth"], nameStats)).toBeLessThan(NAME_EXACT_FACTOR);
  });

  it("applies the archived penalty without excluding the repo", () => {
    const active = makeRepo({ id: 1, name: "active", owner: "oa", stars: 100 });
    const archived = makeRepo({
      id: 2,
      name: "archived",
      owner: "ob",
      stars: 100,
      archived: true
    });
    const hits = fuse({
      keyword: toRanked([
        { repoId: 1, rank: 1 },
        { repoId: 2, rank: 2 }
      ]),
      repos: repoMap(active, archived)
    });
    const prior = starPrior(100);
    expect(hits[0]?.score).toBeCloseTo(prior / (RRF_K + 1), 10);
    expect(hits[1]?.score).toBeCloseTo((prior / (RRF_K + 2)) * ARCHIVED_PENALTY, 10);
  });

  it("penalizes additional hits from the same owner by x0.85 each", () => {
    const first = makeRepo({ id: 1, name: "alpha", owner: "acme" });
    const second = makeRepo({ id: 2, name: "beta", owner: "acme" });
    const hits = fuse({
      keyword: toRanked([
        { repoId: 1, rank: 1 },
        { repoId: 2, rank: 2 }
      ]),
      repos: repoMap(first, second)
    });
    expect(hits[0]?.score).toBeCloseTo(1 / (RRF_K + 1), 10);
    expect(hits[1]?.score).toBeCloseTo((1 / (RRF_K + 2)) * OWNER_DUPLICATE_PENALTY, 10);
  });

  it("penalizes same normalized names by x0.70", () => {
    const first = makeRepo({ id: 1, name: "foo-bar", owner: "one" });
    const second = makeRepo({ id: 2, name: "foo_bar", owner: "two" });
    const hits = fuse({
      keyword: toRanked([
        { repoId: 1, rank: 1 },
        { repoId: 2, rank: 2 }
      ]),
      repos: repoMap(first, second)
    });
    expect(hits[1]?.score).toBeCloseTo((1 / (RRF_K + 2)) * NAME_DUPLICATE_PENALTY, 10);
  });

  it("can disable duplicate penalties for eval ablation", () => {
    const first = makeRepo({ id: 1, name: "alpha", owner: "acme" });
    const second = makeRepo({ id: 2, name: "beta", owner: "acme" });
    const hits = fuse(
      {
        keyword: toRanked([
          { repoId: 1, rank: 1 },
          { repoId: 2, rank: 2 }
        ]),
        repos: repoMap(first, second)
      },
      { duplicatePenalties: false }
    );
    expect(hits[1]?.score).toBeCloseTo(1 / (RRF_K + 2), 10);
  });

  it("breaks equal scores by stars desc, then repo id asc", () => {
    const highId = makeRepo({ id: 20, name: "alpha", owner: "oa", stars: 100 });
    const lowId = makeRepo({ id: 10, name: "beta", owner: "ob", stars: 100 });
    const hits = fuse({
      keyword: toRanked([{ repoId: 20, rank: 1 }]),
      semantic: toRanked([{ repoId: 10, rank: 1 }]),
      repos: repoMap(highId, lowId)
    });
    expect(hits.map((hit) => hit.repo.id)).toEqual([10, 20]);
  });

  it("emits name in matchedBy only when a name boost fired, with groups passthrough", () => {
    const repo = makeRepo({
      id: 1,
      name: "lazygit",
      owner: "jesseduffield",
      topics: ["tui", "git"],
      description: "A simple terminal UI for git commands",
      stars: 60_000
    });
    const hits = fuse(
      {
        keyword: toRanked([{ repoId: 1, rank: 1 }]),
        semantic: toRanked([{ repoId: 1, rank: 2 }]),
        repos: repoMap(repo),
        groups: new Map([[1, ["tui", "v2"]]])
      },
      { queryTokens: ["lazygit"] }
    );
    expect(hits[0]?.matchedBy).toEqual(["keyword", "semantic", "name"]);
    expect(hits[0]?.legRanks).toEqual({ keyword: 1, semantic: 2 });
    expect(hits[0]?.groups).toEqual(["tui", "v2"]);
  });

  it("does not emit name when the boost is damped to a no-op", () => {
    const repo = makeRepo({ id: 1, name: "unrelated", owner: "oa" });
    const hits = fuse(
      {
        keyword: toRanked([{ repoId: 1, rank: 1 }]),
        repos: repoMap(repo)
      },
      { queryTokens: ["auth"] }
    );
    expect(hits[0]?.matchedBy).toEqual(["keyword"]);
  });

  it("drops ranked repos that are excluded by filters", () => {
    const repo = makeRepo({ id: 1, name: "alpha", owner: "oa" });
    const hits = fuse({
      keyword: toRanked([
        { repoId: 1, rank: 1 },
        { repoId: 99, rank: 2 }
      ]),
      repos: repoMap(repo)
    });
    expect(hits.map((hit) => hit.repo.id)).toEqual([1]);
  });
});

describe("overlap bonus", () => {
  it("adds capped topic and description evidence", () => {
    const repo = makeRepo({
      id: 1,
      name: "tiny-http",
      owner: "oa",
      topics: ["http-client", "retry"],
      description: "A tiny http client with retry support"
    });
    const terms = ["http", "client", "retry"];
    expect(overlapBonus(repo, terms)).toBeCloseTo(
      3 * TOPIC_OVERLAP_PER_TERM + 3 * DESCRIPTION_OVERLAP_PER_TERM,
      12
    );
  });

  it("caps overlap counts per field", () => {
    const repo = makeRepo({
      id: 1,
      name: "many",
      owner: "oa",
      topics: ["a", "b", "c", "d", "e"],
      description: "a b c d e"
    });
    expect(overlapBonus(repo, ["a", "b", "c", "d", "e"])).toBeCloseTo(
      3 * TOPIC_OVERLAP_PER_TERM + 3 * DESCRIPTION_OVERLAP_PER_TERM,
      12
    );
  });

  it("flows into fused scores", () => {
    const repo = makeRepo({
      id: 1,
      name: "widget",
      owner: "oa",
      topics: ["http-client"],
      description: "An http client"
    });
    const hits = fuse(
      { keyword: toRanked([{ repoId: 1, rank: 1 }]), repos: repoMap(repo) },
      { queryTokens: ["http", "client"] }
    );
    const expectedBonus =
      2 * TOPIC_OVERLAP_PER_TERM + 2 * DESCRIPTION_OVERLAP_PER_TERM;
    expect(hits[0]?.score).toBeCloseTo(1 / (RRF_K + 1) + expectedBonus, 10);
  });
});
