import { describe, expect, it } from "@effect/vitest";
import {
  GITHUB_API_BASE,
  README_PROBE_PATHS,
  parseLinkNext,
  readmeProbeUrls,
  starPageUrl
} from "../../src/github/github-urls.ts";

describe("starPageUrl", () => {
  it("builds a newest-first star listing URL", () => {
    expect(starPageUrl("coldter", 2, 100)).toBe(
      `${GITHUB_API_BASE}/users/coldter/starred?per_page=100&page=2&sort=created&direction=asc`
    );
  });

  it("encodes odd logins and keeps pagination params", () => {
    const url = new URL(starPageUrl("a b", 1, 50));
    expect(url.pathname).toBe("/users/a%20b/starred");
    expect(url.searchParams.get("per_page")).toBe("50");
    expect(url.searchParams.get("page")).toBe("1");
  });
});

describe("readmeProbeUrls", () => {
  it("probes the documented candidates in order, on the default branch", () => {
    const urls = readmeProbeUrls("Effect-TS/effect", "main");
    expect(urls).toEqual([
      "https://raw.githubusercontent.com/Effect-TS/effect/main/README.md",
      "https://raw.githubusercontent.com/Effect-TS/effect/main/readme.md",
      "https://raw.githubusercontent.com/Effect-TS/effect/main/README.rst",
      "https://raw.githubusercontent.com/Effect-TS/effect/main/README.txt",
      "https://raw.githubusercontent.com/Effect-TS/effect/main/.github/README.md"
    ]);
    expect(urls).toHaveLength(README_PROBE_PATHS.length);
  });

  it("uses the given branch (not HEAD) and encodes the ref", () => {
    const urls = readmeProbeUrls("owner/repo", "release/2.x");
    expect(urls[0]).toBe(
      "https://raw.githubusercontent.com/owner/repo/release%2F2.x/README.md"
    );
  });

  it("encodes each segment of full_name", () => {
    expect(readmeProbeUrls("weird owner/repo", "main")[0]).toContain("/weird%20owner/repo/");
  });
});

describe("parseLinkNext", () => {
  it("extracts the page number of rel=next", () => {
    const header =
      '<https://api.github.com/user/77358146/starred?per_page=100&page=2>; rel="next", ' +
      '<https://api.github.com/user/77358146/starred?per_page=100&page=35>; rel="last"';

    expect(parseLinkNext(header)).toBe(2);
  });

  it("finds rel=next even when it is not first", () => {
    const header =
      '<https://api.github.com/user/1/starred?page=1>; rel="prev", ' +
      '<https://api.github.com/user/1/starred?page=7>; rel="next"';

    expect(parseLinkNext(header)).toBe(7);
  });

  it("returns undefined when there is no next page", () => {
    expect(
      parseLinkNext('<https://api.github.com/user/1/starred?page=1>; rel="first"')
    ).toBeUndefined();
    expect(parseLinkNext(undefined)).toBeUndefined();
    expect(parseLinkNext(null)).toBeUndefined();
    expect(parseLinkNext("")).toBeUndefined();
  });

  it("returns undefined for malformed headers", () => {
    expect(parseLinkNext('rel="next"')).toBeUndefined();
    expect(parseLinkNext('<https://api.github.com/user/1/starred?page=nope>; rel="next"')).toBeUndefined();
    expect(parseLinkNext('<not a url>; rel="next"')).toBeUndefined();
  });
});
