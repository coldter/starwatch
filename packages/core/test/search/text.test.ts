import { describe, expect, it } from "@effect/vitest";
import {
  MAX_QUERY_CHARS,
  buildMatchExpression,
  escapeFtsTerm,
  normalizeQuery,
  phrasesFromQuery,
  tokenize
} from "../../src/search/text.ts";

describe("normalizeQuery", () => {
  it("trims and collapses whitespace", () => {
    expect(normalizeQuery("  hello   world \n\t ")).toBe("hello world");
  });

  it("replaces control characters with spaces instead of gluing words", () => {
    expect(normalizeQuery("foo\u0000bar\u001fbaz")).toBe("foo bar baz");
  });

  it("clamps to MAX_QUERY_CHARS", () => {
    const long = "x".repeat(MAX_QUERY_CHARS + 200);
    const normalized = normalizeQuery(long);
    expect(normalized.length).toBe(MAX_QUERY_CHARS);
  });
});

describe("tokenize", () => {
  it("lowercases and splits on punctuation", () => {
    expect(tokenize("Better-Auth gql.tada @scope/pkg")).toEqual([
      "better",
      "auth",
      "gql",
      "tada",
      "scope",
      "pkg"
    ]);
  });

  it("keeps digits attached to their token", () => {
    expect(tokenize("oauth2 bge-m3 429")).toEqual(["oauth2", "bge", "m3", "429"]);
  });

  it("splits camelCase and acronym boundaries", () => {
    expect(tokenize("useEffect XMLHttpRequest")).toEqual(["use", "effect", "xml", "http", "request"]);
  });

  it("returns an empty array for punctuation-only input", () => {
    expect(tokenize("--- ...")).toEqual([]);
  });
});

describe("escapeFtsTerm", () => {
  it("wraps terms in double quotes and doubles internal quotes", () => {
    expect(escapeFtsTerm('he said "hi"')).toBe('"he said ""hi"""');
  });

  it("never emits bare FTS operators", () => {
    expect(escapeFtsTerm("NEAR(")).toBe('"NEAR("');
    expect(escapeFtsTerm("foo*")).toBe('"foo*"');
    expect(escapeFtsTerm("-term")).toBe('"-term"');
  });
});

describe("buildMatchExpression", () => {
  it("joins quoted terms with AND", () => {
    expect(buildMatchExpression(["better", "auth"], "and")).toBe('"better" AND "auth"');
  });

  it("joins quoted terms with OR", () => {
    expect(buildMatchExpression(["access control", "jwt"], "or")).toBe('"access control" OR "jwt"');
  });

  it("dedupes repeated terms case-insensitively", () => {
    expect(buildMatchExpression(["Auth", "auth", "AUTH"], "and")).toBe('"Auth"');
  });

  it("returns an empty string when there is nothing to match", () => {
    expect(buildMatchExpression([], "and")).toBe("");
    expect(buildMatchExpression(["", "   "], "or")).toBe("");
  });
});

describe("MATCH-expression injection attempts", () => {
  it("neutralizes quotes, wildcards, NEAR(, negation and newlines", () => {
    expect(buildMatchExpression(['foo" OR "bar'], "and")).toBe('"foo"" OR ""bar"');
    expect(buildMatchExpression(["*"], "and")).toBe('"*"');
    expect(buildMatchExpression(["NEAR("], "and")).toBe('"NEAR("');
    expect(buildMatchExpression(["-term"], "and")).toBe('"-term"');
    expect(buildMatchExpression(["a\nb"], "and")).toBe('"a b"');
    expect(buildMatchExpression(["x\" NEAR( y"], "or")).toBe('"x"" NEAR( y"');
  });

  it("treats operator keywords as literals", () => {
    expect(buildMatchExpression(["AND", "OR", "NOT"], "and")).toBe(
      '"AND" AND "OR" AND "NOT"'
    );
  });
});

describe("phrasesFromQuery", () => {
  it("emits adjacent token pairs", () => {
    expect(phrasesFromQuery("http client with retries")).toEqual([
      "http client",
      "client with",
      "with retries"
    ]);
  });

  it("normalizes hyphenated triggers", () => {
    expect(phrasesFromQuery("rate-limit")).toEqual(["rate limit"]);
  });

  it("emits nothing for a single token", () => {
    expect(phrasesFromQuery("auth")).toEqual([]);
  });
});
