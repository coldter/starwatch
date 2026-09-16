import { describe, expect, it } from "@effect/vitest";
import {
  DEFAULT_API_URL,
  EXIT_CODES,
  buildSearchQueryString,
  buildUrl,
  encodeQuery,
  exitCodeForSearch,
  normalizeLogin,
  originOf,
  parseRepoShorthand,
  repoPath,
  resolveApiUrl,
  resolveUser,
  searchPath,
  splitCommaValues,
  syncPath,
  userPath,
  validateLimit
} from "../src/config.ts";

describe("resolveApiUrl", () => {
  it("prefers the flag over the env var over the default", () => {
    expect(resolveApiUrl("http://flag", "http://env")).toBe("http://flag");
    expect(resolveApiUrl("", "http://env")).toBe("http://env");
    expect(resolveApiUrl("", "")).toBe(DEFAULT_API_URL);
    expect(resolveApiUrl(undefined, undefined)).toBe(DEFAULT_API_URL);
  });

  it("trims whitespace and trailing slashes", () => {
    expect(resolveApiUrl("  http://localhost:8787///  ", undefined)).toBe("http://localhost:8787");
    expect(resolveApiUrl("", " https://starwatch.example/ ")).toBe("https://starwatch.example");
  });
});

describe("normalizeLogin / resolveUser", () => {
  it("accepts bare, @-prefixed, github.com and profile URLs", () => {
    expect(normalizeLogin("alice")).toBe("alice");
    expect(normalizeLogin("  @alice ")).toBe("alice");
    expect(normalizeLogin("github.com/alice")).toBe("alice");
    expect(normalizeLogin("https://github.com/Alice/")).toBe("Alice");
    expect(normalizeLogin("https://www.github.com/alice?tab=stars")).toBe("alice");
    expect(normalizeLogin("")).toBe("");
    expect(normalizeLogin(undefined)).toBe("");
  });

  it("resolves flag first, then env, and reports missing context", () => {
    expect(resolveUser("alice", "bob")).toBe("alice");
    expect(resolveUser("", "bob")).toBe("bob");
    expect(resolveUser("  ", "@bob")).toBe("bob");
    expect(resolveUser("", "")).toBeUndefined();
    expect(resolveUser(undefined, undefined)).toBeUndefined();
  });
});

describe("parseRepoShorthand", () => {
  it("accepts the common spellings", () => {
    expect(parseRepoShorthand("BurntSushi/ripgrep")).toEqual({
      owner: "BurntSushi",
      name: "ripgrep"
    });
    expect(parseRepoShorthand("github.com/o/r")).toEqual({ owner: "o", name: "r" });
    expect(parseRepoShorthand("https://github.com/o/r/")).toEqual({ owner: "o", name: "r" });
    expect(parseRepoShorthand("https://github.com/o/r.git")).toEqual({ owner: "o", name: "r" });
  });

  it("rejects anything that is not owner/name", () => {
    expect(parseRepoShorthand("ripgrep")).toBeUndefined();
    expect(parseRepoShorthand("a/b/c")).toBeUndefined();
    expect(parseRepoShorthand("")).toBeUndefined();
    expect(parseRepoShorthand("/")).toBeUndefined();
  });
});

describe("splitCommaValues", () => {
  it("splits, trims and drops empty entries", () => {
    expect(splitCommaValues(["a,b", "c"])).toEqual(["a", "b", "c"]);
    expect(splitCommaValues([" a , b ", ""])).toEqual(["a", "b"]);
    expect(splitCommaValues([])).toEqual([]);
  });
});

describe("validateLimit", () => {
  it("accepts 1..50 integers only", () => {
    expect(validateLimit(1)).toBeUndefined();
    expect(validateLimit(50)).toBeUndefined();
    expect(validateLimit(0)).toContain("between 1 and 50");
    expect(validateLimit(51)).toContain("between 1 and 50");
    expect(validateLimit(1.5)).toContain("between 1 and 50");
  });
});

describe("exit codes", () => {
  it("maps search outcomes: 0 results found, 2 none", () => {
    expect(exitCodeForSearch(1)).toBe(0);
    expect(exitCodeForSearch(50)).toBe(0);
    expect(exitCodeForSearch(0)).toBe(2);
  });

  it("pins the public table", () => {
    expect(EXIT_CODES).toEqual({ success: 0, error: 1, noResults: 2, interrupted: 130 });
  });
});

describe("encodeQuery", () => {
  it("repeats array params and skips undefined/empty values", () => {
    expect(
      encodeQuery({ q: "tui for git", topic: ["tui", "git"], group: [], lang: "", mode: undefined })
    ).toBe("q=tui%20for%20git&topic=tui&topic=git");
  });

  it("encodes reserved characters and booleans/numbers", () => {
    expect(encodeQuery({ q: "a&b=c", archived: false, minStars: 500 })).toBe(
      "q=a%26b%3Dc&archived=false&minStars=500"
    );
  });
});

describe("buildSearchQueryString", () => {
  it("assembles the full filter set with repeated params", () => {
    const query = buildSearchQueryString({
      q: "durable jobs",
      mode: "hybrid",
      lang: "Go",
      topics: ["workflow", "durability"],
      groups: ["inbox", "work"],
      minStars: 500,
      maxStars: 20000,
      archived: false,
      license: "MIT",
      starredAfter: "2024-01-01",
      starredBefore: "2026-01-01",
      limit: 10
    });

    expect(query).toBe(
      [
        "q=durable%20jobs",
        "mode=hybrid",
        "lang=Go",
        "topic=workflow",
        "topic=durability",
        "group=inbox",
        "group=work",
        "minStars=500",
        "maxStars=20000",
        "archived=false",
        "license=MIT",
        "starredAfter=2024-01-01",
        "starredBefore=2026-01-01",
        "limit=10"
      ].join("&")
    );
  });

  it("omits every absent filter", () => {
    expect(buildSearchQueryString({ q: "effect" })).toBe("q=effect");
  });
});

describe("paths and urls", () => {
  it("escapes path segments", () => {
    expect(userPath("a/b")).toBe("/api/users/a%2Fb");
    expect(searchPath("alice")).toBe("/api/users/alice/search");
    expect(syncPath("alice")).toBe("/api/users/alice/sync");
    expect(repoPath("Effect-TS", "effect")).toBe("/api/repos/Effect-TS/effect");
  });

  it("joins base, path and query", () => {
    expect(buildUrl("http://api", "/api/health")).toBe("http://api/api/health");
    expect(buildUrl("http://api", "/api/health", "")).toBe("http://api/api/health");
    expect(buildUrl("http://api", "/x", "a=1")).toBe("http://api/x?a=1");
  });

  it("extracts an origin for error hints", () => {
    expect(originOf("http://127.0.0.1:8787/api/health")).toBe("http://127.0.0.1:8787");
    expect(originOf("not a url")).toBe("not a url");
  });
});
