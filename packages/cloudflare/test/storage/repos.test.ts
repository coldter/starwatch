import { describe, expect, it } from "@effect/vitest";
import type { Group, SearchFilters } from "@starwatch/domain";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { RepoStore } from "../../src/storage/repos.ts";
import { applyMigration, makeIndexState, makeRepo, makeUser, makeSqliteLayer } from "./support.ts";

const LOGIN = "coldter";

const testLive = () => RepoStore.layer.pipe(Layer.provideMerge(makeSqliteLayer()));

const ids = (repos: ReadonlyArray<{ readonly id: number }>): ReadonlyArray<number> =>
  repos.map((repo) => repo.id);

const seedSearchRepos = Effect.gen(function* () {
  const store = yield* RepoStore;
  yield* store.upsertRepos(LOGIN, [
    makeRepo(1, "owner/one", {
      language: "TypeScript",
      stars: 100,
      license: "MIT",
      topics: ["http", "client"],
      starredAt: "2026-01-01T00:00:00Z",
    }),
    makeRepo(2, "owner/two", {
      language: "TypeScript",
      stars: 5,
      license: "MIT",
      topics: ["http"],
      starredAt: "2025-01-01T00:00:00Z",
    }),
    makeRepo(3, "owner/three", {
      language: "Go",
      stars: 1000,
      archived: true,
      license: "Apache-2.0",
      starredAt: "2024-01-01T00:00:00Z",
    }),
    makeRepo(4, "owner/four", {
      language: "TypeScript",
      stars: 50,
      topics: ["http", "client", "retry"],
      starredAt: "2026-06-01T00:00:00Z",
    }),
  ]);
});

describe("RepoStore", () => {
  it.effect("upserts and reads users", () =>
    Effect.gen(function* () {
      yield* applyMigration;
      const store = yield* RepoStore;

      const profile = makeUser(LOGIN, { name: "Coldter", followers: 42 });
      yield* store.upsertUser(profile);
      expect(yield* store.getUser(LOGIN)).toEqual(profile);

      // Upsert keeps the PK stable and refreshes the mutable profile fields.
      yield* store.upsertUser(makeUser(LOGIN, { name: "Coldter!", followers: 43 }));
      const updated = yield* store.getUser(LOGIN);
      expect(updated?.name).toBe("Coldter!");
      expect(updated?.followers).toBe(43);

      expect(yield* store.getUser("nobody")).toBeNull();
    }).pipe(Effect.provide(testLive())),
  );

  it.effect("upserts and reads index state", () =>
    Effect.gen(function* () {
      yield* applyMigration;
      const store = yield* RepoStore;

      const state = makeIndexState(LOGIN, {
        phase: "listing",
        starsTotal: 3448,
      });
      yield* store.upsertIndexState(state);
      expect(yield* store.getIndexState(LOGIN)).toEqual(state);

      yield* store.upsertIndexState({
        ...state,
        phase: "failed",
        lastError: "boom",
      });
      expect((yield* store.getIndexState(LOGIN))?.phase).toBe("failed");
      expect((yield* store.getIndexState(LOGIN))?.lastError).toBe("boom");

      expect(yield* store.getIndexState("nobody")).toBeNull();
    }).pipe(Effect.provide(testLive())),
  );

  it.effect("upserts repos idempotently and preserves the original starred_at", () =>
    Effect.gen(function* () {
      yield* applyMigration;
      const store = yield* RepoStore;

      yield* store.upsertRepos(LOGIN, [
        makeRepo(1, "owner/one", {
          stars: 1,
          starredAt: "2026-01-01T00:00:00Z",
        }),
      ]);
      // A later re-list may omit starredAt; the stored value must win.
      yield* store.upsertRepos(LOGIN, [
        makeRepo(1, "owner/one", { stars: 2, description: "updated" }),
      ]);

      const [repo] = yield* store.getRepos(LOGIN, [1]);
      expect(repo?.stars).toBe(2);
      expect(repo?.description).toBe("updated");
      expect(repo?.starredAt).toBe("2026-01-01T00:00:00Z");
      expect(yield* store.listRepoIds(LOGIN)).toEqual([1]);
    }).pipe(Effect.provide(testLive())),
  );

  it.effect("chunks reads beyond the 100 bound-parameter limit", () =>
    Effect.gen(function* () {
      yield* applyMigration;
      const store = yield* RepoStore;

      const repos = Array.from({ length: 120 }, (_, index) =>
        makeRepo(index + 1, `owner/repo-${index + 1}`, {
          starredAt: "2026-01-01T00:00:00Z",
        }),
      );

      yield* store.upsertRepos(LOGIN, repos);

      expect((yield* store.listRepoIds(LOGIN)).length).toBe(120);
      expect(
        (yield* store.getRepos(
          LOGIN,
          repos.map((repo) => repo.id),
        )).length,
      ).toBe(120);
    }).pipe(Effect.provide(testLive())),
  );

  it.effect("filters topics with AND semantics and stars by range", () =>
    Effect.gen(function* () {
      yield* applyMigration;
      yield* seedSearchRepos;
      const store = yield* RepoStore;

      // topics are AND: every provided topic must be present.
      expect(
        ids(
          yield* store.listReposForSearch(LOGIN, {
            topics: ["http", "client"],
          }),
        ),
      ).toEqual([4, 1]);
      expect(
        ids(
          yield* store.listReposForSearch(LOGIN, {
            topics: ["http", "client", "retry"],
          }),
        ),
      ).toEqual([4]);
      expect(ids(yield* store.listReposForSearch(LOGIN, { topics: ["retry"] }))).toEqual([4]);
      expect(ids(yield* store.listReposForSearch(LOGIN, { topics: ["missing"] }))).toEqual([]);

      expect(
        ids(
          yield* store.listReposForSearch(LOGIN, {
            minStars: 50,
            maxStars: 1000,
          }),
        ),
      ).toEqual([4, 1, 3]);
      expect(ids(yield* store.listReposForSearch(LOGIN, {}))).toEqual([4, 1, 2, 3]);
    }).pipe(Effect.provide(testLive())),
  );

  it.effect("filters language, archived, license and starred dates", () =>
    Effect.gen(function* () {
      yield* applyMigration;
      yield* seedSearchRepos;
      const store = yield* RepoStore;

      expect(ids(yield* store.listReposForSearch(LOGIN, { language: "TypeScript" }))).toEqual([
        4, 1, 2,
      ]);
      // Case-insensitive: CLI/WebUI send lowercase language and license values.
      expect(ids(yield* store.listReposForSearch(LOGIN, { language: "typescript" }))).toEqual([
        4, 1, 2,
      ]);
      expect(ids(yield* store.listReposForSearch(LOGIN, { archived: true }))).toEqual([3]);
      expect(ids(yield* store.listReposForSearch(LOGIN, { archived: false }))).toEqual([4, 1, 2]);
      expect(ids(yield* store.listReposForSearch(LOGIN, { license: "MIT" }))).toEqual([1, 2]);
      expect(ids(yield* store.listReposForSearch(LOGIN, { license: "mit" }))).toEqual([1, 2]);
      expect(
        ids(
          yield* store.listReposForSearch(LOGIN, {
            starredAfter: "2026-01-01T00:00:00Z",
            starredBefore: "2026-06-01T00:00:00Z",
          }),
        ),
      ).toEqual([4, 1]);
      expect(
        ids(
          yield* store.listReposForSearch(LOGIN, {
            language: "TypeScript",
            topics: ["http"],
            minStars: 50,
          }),
        ),
      ).toEqual([4, 1]);
    }).pipe(Effect.provide(testLive())),
  );

  it.effect("filters by group slugs with OR semantics", () =>
    Effect.gen(function* () {
      yield* applyMigration;
      yield* seedSearchRepos;
      const store = yield* RepoStore;

      yield* store.replaceGroups(LOGIN, [
        {
          id: "UL_1",
          name: "Inbox",
          slug: "inbox",
          position: 0,
          repoIds: [1, 2],
        },
        { id: "UL_2", name: "Tools", slug: "tools", position: 1, repoIds: [3] },
      ]);

      expect(ids(yield* store.listReposForSearch(LOGIN, { groups: ["inbox"] }))).toEqual([1, 2]);
      expect(
        ids(
          yield* store.listReposForSearch(LOGIN, {
            groups: ["inbox", "tools"],
          }),
        ),
      ).toEqual([1, 2, 3]);
      expect(ids(yield* store.listReposForSearch(LOGIN, { groups: ["missing"] }))).toEqual([]);
    }).pipe(Effect.provide(testLive())),
  );

  it.effect("unstars without deleting the shared repo row", () =>
    Effect.gen(function* () {
      yield* applyMigration;
      const store = yield* RepoStore;

      yield* store.upsertRepos(LOGIN, [
        makeRepo(1, "owner/one"),
        makeRepo(2, "owner/two", { starredAt: "2026-01-01T00:00:00Z" }),
      ]);
      expect(yield* store.listRepoIds(LOGIN)).toEqual([1, 2]);

      yield* store.markUnstarred(LOGIN, [1, 999]);
      expect(yield* store.listRepoIds(LOGIN)).toEqual([2]);
      expect(yield* store.getRepos(LOGIN, [1])).toEqual([]);

      // The corpus row survives for other users (and for the "who starred X" fan-out).
      const shared = yield* store.getRepoByFullName("owner/one");
      expect(shared?.id).toBe(1);
      expect(shared?.starredAt).toBeNull();
    }).pipe(Effect.provide(testLive())),
  );

  it.effect("roundtrips listing ETags per page", () =>
    Effect.gen(function* () {
      yield* applyMigration;
      const store = yield* RepoStore;

      expect(yield* store.starEtag(LOGIN, 1)).toBeNull();
      yield* store.putStarEtag(LOGIN, 1, 'W/"etag-1"');
      expect(yield* store.starEtag(LOGIN, 1)).toBe('W/"etag-1"');
      expect(yield* store.starEtag(LOGIN, 2)).toBeNull();

      yield* store.putStarEtag(LOGIN, 1, 'W/"etag-2"');
      expect(yield* store.starEtag(LOGIN, 1)).toBe('W/"etag-2"');
    }).pipe(Effect.provide(testLive())),
  );

  it.effect("counts stats and caps readme text at 64 KB", () =>
    Effect.gen(function* () {
      yield* applyMigration;
      const store = yield* RepoStore;
      const sql = yield* SqlClient.SqlClient;

      yield* store.upsertRepos(LOGIN, [makeRepo(1, "owner/one"), makeRepo(2, "owner/two")]);
      yield* store.putReadme(1, {
        text: "hello",
        hash: "hash-1",
        state: "present",
        checkedAt: "2026-09-13T00:00:00Z",
      });
      expect(yield* store.countStats(LOGIN)).toEqual({
        starsTotal: 2,
        reposMetadata: 2,
        readmesFetched: 1,
      });

      yield* store.putReadme(2, {
        text: "x".repeat(70 * 1024),
        hash: "hash-2",
        state: "present",
        checkedAt: null,
      });
      const rows = yield* sql<{
        len: number;
      }>`SELECT length(readme_text) AS len FROM repos WHERE id = 2`;
      expect(rows[0]?.len).toBe(64 * 1024);
      expect((yield* store.countStats(LOGIN)).readmesFetched).toBe(2);
    }).pipe(Effect.provide(testLive())),
  );

  it.effect("replaces and lists groups, and maps repos to group slugs", () =>
    Effect.gen(function* () {
      yield* applyMigration;
      const store = yield* RepoStore;

      const inbox: Group = {
        id: "UL_1",
        name: "Inbox",
        slug: "inbox",
        position: 0,
        repoIds: [1, 2],
      };
      const tools: Group = {
        id: "UL_2",
        name: "Tools",
        slug: "tools",
        position: 1,
        repoIds: [2, 3],
      };
      yield* store.replaceGroups(LOGIN, [inbox, tools]);
      expect(yield* store.listGroups(LOGIN)).toEqual([inbox, tools]);

      const byRepo = yield* store.groupsForRepos(LOGIN, [1, 2, 3, 4]);
      expect(byRepo.get(1)).toEqual(["inbox"]);
      expect(byRepo.get(2)).toEqual(["inbox", "tools"]);
      expect(byRepo.get(3)).toEqual(["tools"]);
      expect(byRepo.get(4)).toBeUndefined();

      // Replacement drops the previous memberships, including empty groups.
      const cli: Group = {
        id: "UL_3",
        name: "CLI",
        slug: "cli",
        position: 5,
        repoIds: [3],
      };
      yield* store.replaceGroups(LOGIN, [cli]);
      expect(yield* store.listGroups(LOGIN)).toEqual([cli]);
      expect((yield* store.groupsForRepos(LOGIN, [1])).size).toBe(0);

      // Other logins are untouched.
      const other: Group = {
        id: "UL_9",
        name: "Other",
        slug: "other",
        position: 0,
        repoIds: [1],
      };
      yield* store.replaceGroups("someone-else", [other]);
      expect(yield* store.listGroups("someone-else")).toEqual([other]);
      expect(yield* store.listGroups(LOGIN)).toEqual([cli]);
    }).pipe(Effect.provide(testLive())),
  );

  it.effect("roundtrips vector blob pointers", () =>
    Effect.gen(function* () {
      yield* applyMigration;
      const store = yield* RepoStore;

      expect(yield* store.getVectorBlob(LOGIN)).toBeNull();
      yield* store.putVectorBlob(LOGIN, 512, 12345);
      const pointer = yield* store.getVectorBlob(LOGIN);
      expect(pointer?.dims).toBe(512);
      expect(pointer?.bytesLen).toBe(12345);

      yield* store.putVectorBlob(LOGIN, 256, 999);
      expect((yield* store.getVectorBlob(LOGIN))?.dims).toBe(256);

      yield* store.deleteVectorBlob(LOGIN);
      expect(yield* store.getVectorBlob(LOGIN)).toBeNull();
    }).pipe(Effect.provide(testLive())),
  );

  it.effect("bulk-upserts repo pages, attributing each row to its listing page", () =>
    Effect.gen(function* () {
      yield* applyMigration;
      const store = yield* RepoStore;

      const repos = Array.from({ length: 120 }, (_, index) =>
        makeRepo(index + 1, `owner/bulk-${index + 1}`, {
          stars: index,
          starredAt: "2026-01-01T00:00:00Z",
        }),
      );

      yield* store.upsertRepoBatch(LOGIN, repos.slice(0, 100), 1);
      yield* store.upsertRepoBatch(LOGIN, repos.slice(100), 2);

      expect((yield* store.listRepoIds(LOGIN)).length).toBe(120);
      const pageRows = yield* store.getStarPageRows(LOGIN);
      expect(pageRows.filter((row) => row.starPage === 1).length).toBe(100);
      expect(pageRows.filter((row) => row.starPage === 2).length).toBe(20);

      // Re-list without a page keeps the stored attribution; with a page it moves.
      yield* store.upsertRepoBatch(LOGIN, [repos[0]!]);
      expect((yield* store.getStarPageRows(LOGIN)).find((row) => row.repoId === 1)?.starPage).toBe(
        1,
      );
      yield* store.upsertRepoBatch(LOGIN, [repos[0]!], 2);
      expect((yield* store.getStarPageRows(LOGIN)).find((row) => row.repoId === 1)?.starPage).toBe(
        2,
      );

      // Full columns round-trip, and a re-list without starredAt preserves it.
      yield* store.upsertRepoBatch(LOGIN, [
        makeRepo(1, "owner/bulk-1", { stars: 42, language: "Rust" }),
      ]);
      const [repo] = yield* store.getRepos(LOGIN, [1]);
      expect(repo?.stars).toBe(42);
      expect(repo?.language).toBe("Rust");
      expect(repo?.starredAt).toBe("2026-01-01T00:00:00Z");

      // Unpaged writers stay unattributed (the listing diff must keep them).
      yield* store.upsertRepos(LOGIN, [makeRepo(999, "owner/unpaged")]);
      expect(
        (yield* store.getStarPageRows(LOGIN)).find((row) => row.repoId === 999)?.starPage,
      ).toBeNull();
    }).pipe(Effect.provide(testLive())),
  );

  it.effect("reads README texts and planner states for the sync workflow", () =>
    Effect.gen(function* () {
      yield* applyMigration;
      const store = yield* RepoStore;

      yield* store.upsertRepos(LOGIN, [
        makeRepo(1, "owner/one"),
        makeRepo(2, "owner/two"),
        makeRepo(3, "owner/three"),
      ]);
      yield* store.putReadme(1, {
        text: "hello readme",
        hash: "h1",
        state: "present",
        checkedAt: "2026-09-13T00:00:00Z",
      });
      yield* store.putReadme(2, {
        text: null,
        hash: null,
        state: "missing",
        checkedAt: null,
      });

      const texts = yield* store.getReadmeTexts(LOGIN, [1, 2, 3, 999]);
      expect(texts.get(1)).toBe("hello readme");
      expect(texts.has(2)).toBe(false);
      expect(texts.size).toBe(1);

      const states = yield* store.getReadmeStates(LOGIN);
      expect(states.get(1)?.status).toBe("ok");
      expect(states.get(2)?.status).toBe("missing");
      expect(states.get(3)?.status).toBe("error"); // default 'unknown'
      expect(states.get(1)?.pushedAt).toBeNull();
    }).pipe(Effect.provide(testLive())),
  );

  it.effect("applies every filter of a SearchFilters object", () =>
    Effect.gen(function* () {
      yield* applyMigration;
      yield* seedSearchRepos;
      const store = yield* RepoStore;

      const filters: SearchFilters = {
        language: "TypeScript",
        minStars: 10,
        maxStars: 500,
        topics: ["client"],
        archived: false,
        license: "MIT",
        starredAfter: "2025-06-01T00:00:00Z",
        starredBefore: "2026-12-31T00:00:00Z",
      };

      expect(ids(yield* store.listReposForSearch(LOGIN, filters))).toEqual([1]);
    }).pipe(Effect.provide(testLive())),
  );
});
