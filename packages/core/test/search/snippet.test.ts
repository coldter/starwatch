import { describe, expect, it } from "@effect/vitest";
import type { Repo } from "@starwatch/domain";
import {
  SNIPPET_ELLIPSIS,
  SNIPPET_MAX_CHARS,
  findFirstTermMatch,
  makeSnippet,
} from "../../src/search/snippet.ts";

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
  ...rest,
});

describe("findFirstTermMatch", () => {
  it("is word-boundary aware and case-insensitive", () => {
    expect(findFirstTermMatch("Authorization and auth", ["auth"])?.index).toBe(18);
    expect(findFirstTermMatch("no match here", ["auth"])).toBeUndefined();
  });

  it("matches multi-word terms", () => {
    expect(findFirstTermMatch("an http client library", ["http client"])?.index).toBe(3);
  });
});

describe("makeSnippet", () => {
  it("centers a clipped window on the first term match", () => {
    const readme = `${"padding words ".repeat(30)}the auth library handles sessions and more ${"tail words ".repeat(30)}`;
    const repo = makeRepo({ id: 1, name: "auth-kit", owner: "acme" });
    const snippet = makeSnippet(repo, ["auth"], readme);
    expect(snippet).toContain("auth");
    expect(snippet.startsWith(SNIPPET_ELLIPSIS)).toBe(true);
    expect(snippet.length).toBeLessThanOrEqual(SNIPPET_MAX_CHARS);
  });

  it("stays within SNIPPET_MAX_CHARS with both ellipses", () => {
    const readme = "a".repeat(200) + " auth " + "b".repeat(400);
    const snippet = makeSnippet(makeRepo({ id: 1, name: "x", owner: "o" }), ["auth"], readme);
    expect(snippet.length).toBeLessThanOrEqual(SNIPPET_MAX_CHARS);
    expect(snippet).toContain("auth");
    expect(snippet.startsWith(SNIPPET_ELLIPSIS)).toBe(true);
    expect(snippet.endsWith(SNIPPET_ELLIPSIS)).toBe(true);
  });

  it("does not prepend an ellipsis when the match is at the start", () => {
    const readme = `auth ${"rest ".repeat(80)}`;
    const snippet = makeSnippet(makeRepo({ id: 1, name: "x", owner: "o" }), ["auth"], readme);
    expect(snippet.startsWith("auth")).toBe(true);
    expect(snippet.endsWith(SNIPPET_ELLIPSIS)).toBe(true);
  });

  it("returns the whole short README when a term matches", () => {
    const readme = "A tiny auth library with sane defaults.";
    const snippet = makeSnippet(makeRepo({ id: 1, name: "x", owner: "o" }), ["auth"], readme);
    expect(snippet).toBe(readme);
  });

  it("falls back to the description when the README has no match", () => {
    const repo = makeRepo({
      id: 1,
      name: "x",
      owner: "o",
      description: "An http client with retry support",
    });

    const snippet = makeSnippet(repo, ["http"], "unrelated readme text");
    expect(snippet).toContain("http client");
  });

  it("falls back to the clipped description when nothing matches", () => {
    const repo = makeRepo({
      id: 1,
      name: "x",
      owner: "o",
      description: "d".repeat(400),
    });

    const snippet = makeSnippet(repo, ["auth"], "unrelated readme text");
    expect(snippet.length).toBeLessThanOrEqual(SNIPPET_MAX_CHARS);
    expect(snippet.endsWith(SNIPPET_ELLIPSIS)).toBe(true);
  });

  it("returns an empty string when there is no README or description text", () => {
    const repo = makeRepo({ id: 1, name: "x", owner: "o" });
    expect(makeSnippet(repo, ["auth"], "")).toBe("");
    expect(makeSnippet(repo, ["auth"])).toBe("");
  });

  it("never returns more than SNIPPET_MAX_CHARS", () => {
    const readme = "Auth ".repeat(200);
    const snippet = makeSnippet(makeRepo({ id: 1, name: "x", owner: "o" }), ["auth"], readme);
    expect(snippet.length).toBeLessThanOrEqual(SNIPPET_MAX_CHARS);
  });
});
