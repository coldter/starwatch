import { describe, expect, it } from "@effect/vitest";
import type {
  Group,
  Repo,
  SearchHit,
  SearchResponse,
  UserIndexState,
  UserProfile,
} from "@starwatch/domain";
import {
  bold,
  dim,
  formatCount,
  formatCoverage,
  formatExplain,
  formatStars,
  oneLine,
  renderEmptyHint,
  renderError,
  renderGroups,
  renderHealth,
  renderJson,
  renderRepoPage,
  renderSearch,
  renderSearchHit,
  renderSearchPlain,
  renderSearchSummary,
  renderStatusPage,
  renderSyncProgress,
  renderSyncStart,
  renderSyncState,
  resolveWidth,
  shouldUseColor,
  truncate,
} from "../src/render.ts";

const repo: Repo = {
  id: 123,
  fullName: "effect-ts/effect",
  owner: "effect-ts",
  name: "effect",
  description: "A toolkit to build production-grade TypeScript applications.",
  language: "TypeScript",
  topics: ["effect", "typescript"],
  stars: 8200,
  forks: 300,
  archived: false,
  license: "MIT",
  homepage: null,
  pushedAt: "2026-09-12T00:00:00Z",
  starredAt: "2024-03-18T00:00:00Z",
  htmlUrl: "https://github.com/effect-ts/effect",
};

const inbox: Group = {
  id: "g1",
  name: "inbox",
  slug: "inbox",
  position: 0,
  repoIds: [1, 2],
};

const rustTools: Group = {
  id: "g2",
  name: "rust-tools",
  slug: "rust-tools",
  position: 1,
  repoIds: [3],
};

const hit: SearchHit = {
  repo,
  score: 0.0325,
  snippet: "…retries, timers and durable background jobs with deterministic replay…",
  matchedBy: ["keyword", "semantic"],
  groups: ["inbox", "work"],
};

const response: SearchResponse = {
  query: "durable jobs",
  mode: "hybrid",
  hits: [hit],
  total: 1,
  tookMs: 128,
  semanticCoverage: 42,
};

const profile: UserProfile = {
  login: "alice",
  id: 1,
  name: "Alice Example",
  avatarUrl: "https://avatars.example/alice.png",
  bio: null,
  company: null,
  location: null,
  followers: 10,
  publicRepos: 5,
  createdAt: "2011-01-01T00:00:00Z",
};

const state: UserIndexState = {
  login: "alice",
  phase: "ready",
  starsTotal: 3448,
  reposMetadata: 3448,
  readmesFetched: 3201,
  semanticDocs: 1500,
  lastSyncedAt: "2026-09-13T03:00:00Z",
  lastError: null,
  updatedAt: "2026-09-13T03:00:00Z",
};

describe("color and width", () => {
  it("colors only on a TTY with NO_COLOR unset", () => {
    expect(shouldUseColor({ isTTY: true }, {})).toBe(true);
    expect(shouldUseColor({ isTTY: false }, {})).toBe(false);
    expect(shouldUseColor({ isTTY: undefined }, {})).toBe(false);
    expect(shouldUseColor({ isTTY: true }, { NO_COLOR: "" })).toBe(false);
    expect(shouldUseColor({ isTTY: true }, { NO_COLOR: "1" })).toBe(false);
  });

  it("wraps ANSI only when color is enabled", () => {
    expect(bold("x", false)).toBe("x");
    expect(dim("x", false)).toBe("x");
    expect(bold("x", true)).toBe("\u001b[1mx\u001b[22m");
    expect(dim("x", true)).toBe("\u001b[2mx\u001b[22m");
  });

  it("resolves width: stream, then $COLUMNS, capped at 120 and floor 40", () => {
    expect(resolveWidth(100, undefined)).toBe(100);
    expect(resolveWidth(undefined, "90")).toBe(90);
    expect(resolveWidth(undefined, "not-a-number")).toBe(80);
    expect(resolveWidth(undefined, undefined)).toBe(80);
    expect(resolveWidth(200, undefined)).toBe(120);
    expect(resolveWidth(10, undefined)).toBe(40);
  });
});

describe("scalar formatting", () => {
  it("formats stars", () => {
    expect(formatStars(0)).toBe("0");
    expect(formatStars(950)).toBe("950");
    expect(formatStars(1000)).toBe("1k");
    expect(formatStars(12345)).toBe("12.3k");
    expect(formatStars(92400)).toBe("92.4k");
    expect(formatStars(1_000_000)).toBe("1M");
  });

  it("formats counts with manual grouping", () => {
    expect(formatCount(3277)).toBe("3,277");
    expect(formatCount(1000000)).toBe("1,000,000");
    expect(formatCount(-1234)).toBe("-1,234");
  });

  it("collapses whitespace and truncates with an ellipsis", () => {
    expect(oneLine("a\n\t b   c ")).toBe("a b c");
    expect(truncate("abcdef", 4)).toBe("abc…");
    expect(truncate("abc", 3)).toBe("abc");
    expect(truncate("abc", 0)).toBe("");
    expect(truncate("abc", 1)).toBe("…");
  });

  it("normalizes coverage fractions and percentages", () => {
    expect(formatCoverage(0)).toBe(0);
    expect(formatCoverage(0.42)).toBe(42);
    expect(formatCoverage(42)).toBe(42);
    expect(formatCoverage(100)).toBe(100);
    expect(formatCoverage(120)).toBe(100);
    expect(formatCoverage(-1)).toBe(0);
  });
});

describe("search output", () => {
  it("renders the hit block contract", () => {
    const output = renderSearchHit(hit, { color: false, width: 120 });
    expect(output).toBe(
      [
        "effect-ts/effect  ★8.2k  TypeScript  [inbox, work]",
        "  …retries, timers and durable background jobs with deterministic replay…",
      ].join("\n"),
    );
  });

  it("adds leg presence and score under --explain", () => {
    expect(formatExplain(["keyword", "semantic"], 0.0325)).toBe(
      "kw:+ exp:- sem:+ name:- · score 0.0325",
    );

    const output = renderSearchHit(hit, {
      color: false,
      width: 120,
      explain: true,
    });

    expect(output.split("\n")[2]).toBe("  kw:+ exp:- sem:+ name:- · score 0.0325");
  });

  it("keeps every rendered line within the width cap", () => {
    const longHit: SearchHit = { ...hit, snippet: "x".repeat(500) };
    const longResponse: SearchResponse = { ...response, hits: [longHit] };
    const output = renderSearch(longResponse, { color: false, width: 120 });

    for (const line of output.split("\n")) {
      expect(line.length).toBeLessThanOrEqual(120);
    }
  });

  it("renders --plain as one owner/name per line", () => {
    expect(renderSearchPlain(response)).toBe("effect-ts/effect");
    expect(renderSearchPlain({ ...response, hits: [] })).toBe("");
  });

  it("renders the summary and the empty-result hint", () => {
    expect(renderSearchSummary(response)).toBe("1 result · 128 ms · mode hybrid · semantic 42%");
    expect(renderSearchSummary({ ...response, hits: [], semanticCoverage: 1 })).toBe(
      "0 results · 128 ms · mode hybrid",
    );
    const hint = renderEmptyHint("quantum toaster", "hybrid");
    expect(hint).toContain('No results for "quantum toaster" in hybrid mode.');
    expect(hint).toContain("another --mode");
  });

  it("pretty-prints JSON and round-trips it", () => {
    expect(JSON.parse(renderJson(response))).toEqual(response);
    expect(renderJson({ a: 1 })).toBe('{\n  "a": 1\n}');
  });
});

describe("repo, status and groups output", () => {
  it("renders a repo page", () => {
    const output = renderRepoPage({ repo, groups: [inbox, rustTools] }, { color: false });

    expect(output).toBe(
      [
        "effect-ts/effect  ★8.2k  TypeScript  MIT  not archived",
        "A toolkit to build production-grade TypeScript applications.",
        "Starred 2024-03-18 · Pushed 2026-09-12 · Groups: inbox, rust-tools",
        "Topics: effect, typescript · https://github.com/effect-ts/effect",
      ].join("\n"),
    );
  });

  it("renders status with coverage counters", () => {
    const output = renderStatusPage({ profile, state, groups: [] }, { color: false });

    expect(output).toBe(
      [
        "@alice  Alice Example",
        "● ready · 3,448 stars · metadata 3,448 · readmes 3,201 · semantic 1,500",
        "Last synced 2026-09-13 UTC",
      ].join("\n"),
    );

    const failed = renderStatusPage(
      {
        profile,
        state: {
          ...state,
          phase: "failed",
          lastSyncedAt: null,
          lastError: "github 502",
        },
        groups: [],
      },
      { color: false },
    );

    expect(failed).toContain("⚠ failed");
    expect(failed).toContain("Never synced");
    expect(failed).toContain("Last error: github 502");
  });

  it("renders groups aligned with correct pluralization", () => {
    expect(renderGroups([inbox, rustTools])).toBe(
      ["inbox       2 repos", "rust-tools  1 repo"].join("\n"),
    );
    expect(renderGroups([])).toBe("(no groups)");
  });
});

describe("sync and health output", () => {
  it("renders sync start, progress and final state", () => {
    expect(renderSyncStart({ started: true, phase: "listing" })).toBe(
      "Sync started · phase listing",
    );
    expect(renderSyncStart({ started: false, phase: "embedding" })).toBe(
      "Sync already running · phase embedding",
    );
    expect(renderSyncProgress(state)).toBe("● ready · 3,448/3,448 metadata · semantic 1,500");
    expect(renderSyncState(state).split("\n")[0]).toBe("@alice");
  });

  it("renders health with the target URL", () => {
    expect(
      renderHealth(
        { ok: true, service: "starwatch", version: "1.2.3", semanticSearch: false },
        "http://127.0.0.1:8787",
      ),
    ).toBe("starwatch 1.2.3 · ok · semantic search off · http://127.0.0.1:8787");
  });

  it("renders errors as one line plus a named fix", () => {
    expect(renderError({ message: "Could not reach the API." })).toBe("✗ Could not reach the API.");
    expect(renderError({ message: "Missing --user.", hint: "Pass --user alice." })).toBe(
      "✗ Missing --user.\n  Pass --user alice.",
    );
  });
});
