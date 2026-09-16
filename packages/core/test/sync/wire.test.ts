import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  GraphqlEnvelopeWire,
  RepoWire,
  UserWire,
  decodeGraphqlEnvelope,
  decodeRepo,
  decodeStarItems,
  decodeUserLists,
  decodeUserProfile,
  groupFromUserList,
  slugifyGroupName
} from "../../src/sync/wire.ts";

const repoJson = {
  id: 123456,
  full_name: "Effect-TS/effect",
  owner: { login: "Effect-TS" },
  name: "effect",
  description: "An ecosystem of tools to build robust applications.",
  language: "TypeScript",
  topics: ["typescript", "functional-programming"],
  stargazers_count: 8_100,
  forks_count: 912,
  archived: false,
  license: { spdx_id: "MIT" },
  homepage: "https://effect.website",
  pushed_at: "2026-09-01T12:34:56Z",
  html_url: "https://github.com/Effect-TS/effect"
};

describe("RepoWire", () => {
  it("decodes a full GitHub repo payload into a Repo", () => {
    const repo = Effect.runSync(decodeRepo(repoJson));
    expect(repo).toEqual({
      id: 123456,
      fullName: "Effect-TS/effect",
      owner: "Effect-TS",
      name: "effect",
      description: "An ecosystem of tools to build robust applications.",
      language: "TypeScript",
      topics: ["typescript", "functional-programming"],
      stars: 8_100,
      forks: 912,
      archived: false,
      license: "MIT",
      homepage: "https://effect.website",
      pushedAt: "2026-09-01T12:34:56Z",
      htmlUrl: "https://github.com/Effect-TS/effect",
      starredAt: null
    });
  });

  it("keeps null fields null (description/license/homepage/pushed_at)", () => {
    const repo = Effect.runSync(
      decodeRepo({
        ...repoJson,
        description: null,
        license: null,
        homepage: null,
        pushed_at: null,
        language: null,
        topics: []
      })
    );

    expect(repo.description).toBeNull();
    expect(repo.license).toBeNull();
    expect(repo.homepage).toBeNull();
    expect(repo.pushedAt).toBeNull();
    expect(repo.language).toBeNull();
    expect(repo.topics).toEqual([]);
  });

  it("encodes back to GitHub snake_case keys", () => {
    const repo = Effect.runSync(decodeRepo(repoJson));
    const encoded = Schema.encodeSync(RepoWire)(repo);
    expect(encoded.full_name).toBe("Effect-TS/effect");
    expect(encoded.stargazers_count).toBe(8_100);
    expect(encoded.forks_count).toBe(912);
    expect(encoded.pushed_at).toBe("2026-09-01T12:34:56Z");
    expect(encoded.html_url).toBe("https://github.com/Effect-TS/effect");
    expect(encoded.owner).toEqual({ login: "Effect-TS" });
    expect(encoded.license).toEqual({ spdx_id: "MIT" });
    expect(encoded.description).toBe("An ecosystem of tools to build robust applications.");
  });

  it("rejects payloads missing required keys", () => {
    expect(() => Effect.runSync(decodeRepo({ ...repoJson, id: undefined }))).toThrow();
    expect(() => Effect.runSync(decodeRepo({ full_name: "a/b" }))).toThrow();
  });
});

describe("StarItemWire", () => {
  it("decodes the star+json envelope and derives starredAt", () => {
    const items = Effect.runSync(
      decodeStarItems([
        { starred_at: "2026-07-09T00:00:00Z", repo: repoJson },
        { starred_at: "2026-07-10T00:00:00Z", repo: { ...repoJson, id: 7, license: null } }
      ])
    );

    expect(items).toHaveLength(2);
    expect(items[0]?.starredAt).toBe("2026-07-09T00:00:00Z");
    expect(items[0]?.repo.fullName).toBe("Effect-TS/effect");
    expect(items[1]?.repo.license).toBeNull();
  });

  it("rejects a bare repo array (wrong Accept media type)", () => {
    expect(() => Effect.runSync(decodeStarItems([repoJson]))).toThrow();
  });
});

describe("UserWire", () => {
  it("decodes a public profile", () => {
    const profile = Effect.runSync(
      decodeUserProfile({
        login: "coldter",
        id: 77_358_146,
        name: null,
        avatar_url: "https://avatars.githubusercontent.com/u/77358146",
        bio: "building starwatch",
        company: null,
        location: "Berlin",
        followers: 12,
        public_repos: 42,
        created_at: "2015-01-02T03:04:05Z"
      })
    );

    expect(profile).toEqual({
      login: "coldter",
      id: 77_358_146,
      name: null,
      avatarUrl: "https://avatars.githubusercontent.com/u/77358146",
      bio: "building starwatch",
      company: null,
      location: "Berlin",
      followers: 12,
      publicRepos: 42,
      createdAt: "2015-01-02T03:04:05Z"
    });
  });
});

describe("lists wire", () => {
  it("decodes a lists page (public + private) preserving null item nodes", () => {
    const data = Effect.runSync(
      decodeUserLists({
        user: {
          lists: {
            pageInfo: { hasNextPage: true, endCursor: "LIST_CURSOR_1" },
            nodes: [
              {
                id: "UL_public",
                name: "Rust / Tools & More",
                isPrivate: false,
                items: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [{ databaseId: 42 }, null, { databaseId: 43 }]
                }
              },
              {
                id: "UL_private",
                name: "Secret",
                isPrivate: true,
                items: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: []
                }
              }
            ]
          }
        }
      })
    );

    const publicList = data.user?.lists.nodes[0];
    expect(publicList?.id).toBe("UL_public");
    expect(publicList?.isPrivate).toBe(false);
    expect(publicList?.items.nodes).toEqual([{ databaseId: 42 }, null, { databaseId: 43 }]);
    expect(data.user?.lists.nodes[1]?.isPrivate).toBe(true);
    expect(data.user?.lists.pageInfo).toEqual({
      hasNextPage: true,
      endCursor: "LIST_CURSOR_1"
    });
  });

  it("decodes a missing user as null", () => {
    const data = Effect.runSync(decodeUserLists({ user: null }));
    expect(data.user).toBeNull();
  });

  it("rejects malformed pageInfo", () => {
    expect(() =>
      Effect.runSync(
        decodeUserLists({
          user: { lists: { pageInfo: { hasNextPage: "yes", endCursor: null }, nodes: [] } }
        })
      )
    ).toThrow();
  });

  it("maps a decoded list node to a Group with slug and continuation ids", () => {
    const data = Effect.runSync(
      decodeUserLists({
        user: {
          lists: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [
              {
                id: "UL_1",
                name: "Rust / Tools & More",
                isPrivate: false,
                items: {
                  pageInfo: { hasNextPage: true, endCursor: "c1" },
                  nodes: [{ databaseId: 1 }, null]
                }
              }
            ]
          }
        }
      })
    );

    const node = data.user?.lists.nodes[0];
    expect(node).toBeDefined();
    expect(groupFromUserList(node!, 3, [7, 8])).toEqual({
      id: "UL_1",
      name: "Rust / Tools & More",
      slug: "rust-tools-more",
      position: 3,
      repoIds: [1, 7, 8]
    });
  });
});

describe("GraphqlEnvelopeWire", () => {
  it("decodes data and error entries", () => {
    const envelope = Effect.runSync(
      decodeGraphqlEnvelope({ data: { user: null }, errors: [{ message: "boom" }] })
    );

    expect(envelope.errors).toEqual([{ message: "boom" }]);
    expect(envelope.data).toEqual({ user: null });
  });

  it("accepts an envelope without errors", () => {
    const envelope = Effect.runSync(decodeGraphqlEnvelope({ data: {} }));
    expect(envelope.errors).toBeUndefined();
    expect(GraphqlEnvelopeWire.ast).toBeDefined();
    expect(UserWire.ast).toBeDefined();
  });
});

describe("slugifyGroupName", () => {
  it("lowercases, hyphenates and collapses separators", () => {
    expect(slugifyGroupName("Rust / Tools & More")).toBe("rust-tools-more");
    expect(slugifyGroupName("My   List")).toBe("my-list");
    expect(slugifyGroupName("already-slug")).toBe("already-slug");
    expect(slugifyGroupName("!!!")).toBe("");
    expect(slugifyGroupName("  Trailing -- dashes -- ")).toBe("trailing-dashes");
  });
});
