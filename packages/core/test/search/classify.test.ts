import { describe, expect, it } from "@effect/vitest";
import { MIN_AND_HITS, chooseMatchStrategy, classifyQuery } from "../../src/search/classify.ts";

describe("classifyQuery", () => {
  it("classifies plain short tokens as keyword", () => {
    expect(classifyQuery("auth")).toBe("keyword");
    expect(classifyQuery("effect")).toBe("keyword");
  });

  it("classifies two-token queries as keyword", () => {
    expect(classifyQuery("rate limit")).toBe("keyword");
    expect(classifyQuery("tui git")).toBe("keyword");
  });

  it("classifies three or more tokens as descriptive", () => {
    expect(classifyQuery("library to schedule durable background jobs with retries")).toBe(
      "descriptive"
    );
    expect(classifyQuery("http client retries")).toBe("descriptive");
  });

  it("detects hyphen/dot/underscore identifiers", () => {
    expect(classifyQuery("drizzle-orm")).toBe("identifier");
    expect(classifyQuery("gql.tada")).toBe("identifier");
    expect(classifyQuery("wttr.in")).toBe("identifier");
    expect(classifyQuery("better_auth")).toBe("identifier");
  });

  it("detects digit and version identifiers", () => {
    expect(classifyQuery("oauth2")).toBe("identifier");
    expect(classifyQuery("bge-m3")).toBe("identifier");
  });

  it("detects camelCase identifiers", () => {
    expect(classifyQuery("useEffect")).toBe("identifier");
    expect(classifyQuery("useDeferredValue")).toBe("identifier");
  });

  it("detects owner/name queries", () => {
    expect(classifyQuery("Effect-TS/effect")).toBe("identifier");
  });

  it("is lenient for empty input", () => {
    expect(classifyQuery("")).toBe("keyword");
    expect(classifyQuery("   ")).toBe("keyword");
  });
});

describe("chooseMatchStrategy", () => {
  it("requires AND to yield at least MIN_AND_HITS repos", () => {
    expect(MIN_AND_HITS).toBe(3);
    expect(chooseMatchStrategy(0)).toBe("or");
    expect(chooseMatchStrategy(1)).toBe("or");
    expect(chooseMatchStrategy(2)).toBe("or");
    expect(chooseMatchStrategy(3)).toBe("and");
    expect(chooseMatchStrategy(50)).toBe("and");
  });

  it("treats non-finite hit counts as a reason to fall back", () => {
    expect(chooseMatchStrategy(Number.NaN)).toBe("or");
    expect(chooseMatchStrategy(Number.POSITIVE_INFINITY)).toBe("and");
  });
});
