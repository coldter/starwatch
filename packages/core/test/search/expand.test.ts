import { describe, expect, it } from "@effect/vitest";
import type { Concept } from "@starwatch/domain";
import { MAX_EXPANSION_TERMS, expandQuery } from "../../src/search/expand.ts";

describe("expandQuery — activation", () => {
  it("activates the auth cluster for `auth`", () => {
    const result = expandQuery("auth");
    expect(result.activated).toBe(true);
    expect(result.conceptIds).toEqual(["auth"]);
    expect(result.terms).toContain("authentication");
    expect(result.terms).toContain("oauth");
    expect(result.expression).toBe(
      '"authentication" OR "authorization" OR "oauth" OR "oidc" OR "jwt" OR "sso" OR "session" OR "permissions"'
    );
  });

  it("activates http-client via the 2-token phrase `http client`", () => {
    const result = expandQuery("http client");
    expect(result.activated).toBe(true);
    expect(result.conceptIds).toEqual(["http-client"]);
    expect(result.expression).toContain('"http client"');
    expect(result.expression).toContain('"fetch"');
  });

  it("activates rate-limit from the hyphenated `rate-limit` trigger", () => {
    const result = expandQuery("rate limit");
    expect(result.activated).toBe(true);
    expect(result.conceptIds).toEqual(["rate-limit"]);
    expect(result.expression).toContain('"rate limiting"');
  });

  it("activates the tui cluster for `tui git` (git has no cluster)", () => {
    const result = expandQuery("tui git");
    expect(result.activated).toBe(true);
    expect(result.conceptIds).toEqual(["tui"]);
    expect(result.terms).toContain("terminal user interface");
  });

  it("matches whole tokens only — `author` never triggers auth", () => {
    expect(expandQuery("author").activated).toBe(false);
    expect(expandQuery("authority").activated).toBe(false);
    expect(expandQuery("authenticator").activated).toBe(false);
    expect(expandQuery("authorization").conceptIds).toEqual(["auth"]);
  });

  it("returns the canonical empty expansion for unmatched queries", () => {
    const result = expandQuery("quantum banana");
    expect(result).toEqual({
      activated: false,
      conceptIds: [],
      terms: [],
      expression: undefined
    });
    expect(expandQuery("").activated).toBe(false);
  });
});

describe("expandQuery — terms", () => {
  it("caps terms at MAX_EXPANSION_TERMS", () => {
    const result = expandQuery("auth");
    expect(MAX_EXPANSION_TERMS).toBe(8);
    expect(result.terms).toHaveLength(MAX_EXPANSION_TERMS);
    expect(result.terms).not.toContain("access control");
  });

  it("dedupes terms across activated concepts deterministically", () => {
    const lexicon: ReadonlyArray<Concept> = [
      { id: "alpha", label: "Alpha", triggers: ["alpha"], expand: ["shared", "one"] },
      { id: "beta", label: "Beta", triggers: ["beta"], expand: ["shared", "two"] }
    ];

    const result = expandQuery("alpha beta", lexicon);
    expect(result.conceptIds).toEqual(["alpha", "beta"]);
    expect(result.terms).toEqual(["shared", "one", "two"]);
    expect(result.expression).toBe('"shared" OR "one" OR "two"');
  });

  it("supports custom multi-word triggers and caps their terms", () => {
    const lexicon: ReadonlyArray<Concept> = [
      {
        id: "custom",
        label: "Custom",
        triggers: ["foo bar"],
        expand: ["t1", "t2", "t3", "t4", "t5", "t6", "t7", "t8", "t9"]
      }
    ];

    const result = expandQuery("foo bar extra words here", lexicon);
    expect(result.activated).toBe(true);
    expect(result.terms).toHaveLength(MAX_EXPANSION_TERMS);
    expect(result.terms).toEqual(["t1", "t2", "t3", "t4", "t5", "t6", "t7", "t8"]);
  });

  it("activates a concept with an empty expand list but emits no expression", () => {
    const lexicon: ReadonlyArray<Concept> = [
      { id: "zap", label: "Zap", triggers: ["zap"], expand: [] }
    ];

    const result = expandQuery("zap", lexicon);
    expect(result.activated).toBe(true);
    expect(result.conceptIds).toEqual(["zap"]);
    expect(result.terms).toEqual([]);
    expect(result.expression).toBeUndefined();
  });

  it("is never a replacement: the caller keeps the original query leg", () => {
    const result = expandQuery("auth");
    expect(result.expression).not.toContain('"auth"');
  });
});
