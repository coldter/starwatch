import { describe, expect, it } from "@effect/vitest";
import { RepoStore, UserFts, VectorBlobStore } from "@starwatch/cloudflare/storage";
import { Embedder } from "@starwatch/core/sync";
import type { SearchSort } from "@starwatch/domain";
import { Effect, Layer } from "effect";
import {
  applyMigration,
  makeFtsDoc,
  makeRepo,
  makeSqliteLayer,
} from "../../../packages/cloudflare/test/storage/support.ts";
import { VectorBlobFiles } from "../src/adapters/vector-bucket.ts";
import { runSearch, type SearchInput } from "../src/search/search-service.ts";

/**
 * End-to-end coverage for `runSearch` ordering (docs/07 §4, §5.5) against the
 * real storage layers: in-memory SQLite with the production migrations and live
 * FTS5, so the leg window, fusion and the post-fusion sort are all exercised.
 *
 * The cloudflare package's test harness is reused (it owns the migration
 * fixture); everything the semantic leg needs is stubbed to `Effect.die`, so a
 * test that suddenly wants embeddings or R2 fails loudly instead of silently
 * degrading.
 */

const LOGIN = "coldter";

const unused = (what: string): Effect.Effect<never> => Effect.die(`unexpected ${what} call`);

const stubs = Layer.mergeAll(
  Layer.succeed(Embedder, { embed: () => unused("Embedder.embed") }),
  Layer.succeed(VectorBlobStore, {
    putVectors: () => unused("VectorBlobStore.putVectors"),
    getVectors: () => unused("VectorBlobStore.getVectors"),
    deleteVectors: () => unused("VectorBlobStore.deleteVectors"),
  }),
  Layer.succeed(VectorBlobFiles, {
    getBytes: () => unused("VectorBlobFiles.getBytes"),
    putBytes: () => unused("VectorBlobFiles.putBytes"),
    getIds: () => unused("VectorBlobFiles.getIds"),
    putIds: () => unused("VectorBlobFiles.putIds"),
    putPart: () => unused("VectorBlobFiles.putPart"),
    deleteMany: () => unused("VectorBlobFiles.deleteMany"),
  }),
);

const testLive = () =>
  Layer.mergeAll(RepoStore.layer, UserFts.layer).pipe(
    Layer.provideMerge(makeSqliteLayer()),
    Layer.provideMerge(stubs),
  );

interface SeedRepo {
  readonly id: number;
  readonly name: string;
  readonly stars: number;
  readonly pushedAt: string | null;
  readonly starredAt: string;
}

const seedRepo = (repo: SeedRepo) =>
  makeRepo(repo.id, `owner/${repo.name}`, {
    description: "http client toolkit",
    stars: repo.stars,
    pushedAt: repo.pushedAt,
    starredAt: repo.starredAt,
  });

/** Three matches with deliberately opposed relevance / recency / star orders. */
const SEED: ReadonlyArray<SeedRepo> = [
  {
    id: 1,
    name: "best-match",
    stars: 10,
    pushedAt: "2020-01-01T00:00:00Z",
    starredAt: "2026-01-01T00:00:00Z",
  },
  {
    id: 2,
    name: "newest",
    stars: 5,
    pushedAt: "2026-06-01T00:00:00Z",
    starredAt: "2024-01-01T00:00:00Z",
  },
  {
    id: 3,
    name: "starred-long-ago",
    stars: 900,
    pushedAt: null,
    starredAt: "2021-01-01T00:00:00Z",
  },
];

const seed = Effect.gen(function* () {
  yield* applyMigration;
  const store = yield* RepoStore;
  const fts = yield* UserFts;

  yield* store.upsertRepos(LOGIN, SEED.map(seedRepo));
  yield* fts.replaceUserDocs(
    LOGIN,
    SEED.map((repo) =>
      makeFtsDoc(repo.id, `owner/${repo.name}`, {
        description: "http client toolkit",
        readme: `http client toolkit for ${repo.name}`,
      }),
    ),
  );
});

const search = (input: Partial<SearchInput> & { readonly sort: SearchSort }) =>
  Effect.gen(function* () {
    const response = yield* runSearch({
      login: LOGIN,
      query: "http client",
      mode: "keyword",
      filters: {},
      offset: 0,
      limit: 50,
      semanticSearch: true,
      ...input,
    });

    return response.hits.map((hit) => hit.repo.id);
  });

const seeded = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    yield* seed;

    return yield* effect;
  });

describe("runSearch sort", () => {
  it.effect("keeps the fused order for relevance", () =>
    seeded(search({ sort: "relevance" })).pipe(
      Effect.tap((ids) =>
        Effect.sync(() => {
          // All three match identically, so the fused order is decided by the
          // boosts: 900 stars first (star prior), then BM25 length effects.
          // It is deliberately neither star- nor date-ordered — that is the
          // whole point of the default key.
          expect(ids).toEqual([3, 2, 1]);
        }),
      ),
      Effect.provide(testLive()),
    ),
  );

  it.effect("orders matches by last push, newest first, nulls last", () =>
    seeded(search({ sort: "pushed" })).pipe(
      Effect.tap((ids) => Effect.sync(() => expect(ids).toEqual([2, 1, 3]))),
      Effect.provide(testLive()),
    ),
  );

  it.effect("orders matches by stars", () =>
    seeded(search({ sort: "stars" })).pipe(
      Effect.tap((ids) => Effect.sync(() => expect(ids).toEqual([3, 1, 2]))),
      Effect.provide(testLive()),
    ),
  );

  it.effect("orders matches by the user's own starred date", () =>
    seeded(search({ sort: "starred" })).pipe(
      Effect.tap((ids) => Effect.sync(() => expect(ids).toEqual([1, 2, 3]))),
      Effect.provide(testLive()),
    ),
  );

  it.effect("reaches repos outside the relevance window", () =>
    Effect.gen(function* () {
      yield* applyMigration;
      const store = yield* RepoStore;
      const fts = yield* UserFts;

      // 60 identical matches: BM25 ties, so only the first 50 by rowid fit the
      // relevance leg. Repo 60 is pushed newest but sorts last by rowid —
      // invisible without the widened leg, first with `sort=pushed`.
      const repos = Array.from({ length: 60 }, (_, index) => {
        const id = index + 1;

        return makeRepo(id, `owner/toolkit-${String(id).padStart(2, "0")}`, {
          description: "search toolkit",
          pushedAt: id === 60 ? "2026-01-01T00:00:00Z" : "2020-01-01T00:00:00Z",
          starredAt: "2026-01-01T00:00:00Z",
        });
      });

      yield* store.upsertRepos(LOGIN, repos);
      yield* fts.replaceUserDocs(
        LOGIN,
        repos.map((repo) => makeFtsDoc(repo.id, repo.fullName, { description: "search toolkit" })),
      );

      const relevance = yield* search({ query: "search toolkit", sort: "relevance" });
      const pushed = yield* search({ query: "search toolkit", sort: "pushed" });

      expect(relevance).toHaveLength(50);
      expect(relevance).not.toContain(60);
      expect(pushed).toHaveLength(50);
      expect(pushed[0]).toBe(60);
    }).pipe(Effect.provide(testLive())),
  );
});

describe("runSearch with semantic search off", () => {
  it.effect("serves a requested semantic mode as plain keyword results", () =>
    seeded(
      Effect.gen(function* () {
        const response = yield* runSearch({
          login: LOGIN,
          query: "http client",
          mode: "semantic",
          sort: "relevance",
          filters: {},
          offset: 0,
          limit: 50,
          semanticSearch: false,
        });

        return response;
      }),
    ).pipe(
      Effect.tap((response) =>
        Effect.sync(() => {
          // Off is configuration, not degradation: the answer is honestly
          // keyword, no mode is claimed that this deployment cannot run, and
          // the stubbed embedder / vector blob / R2 sidecar (each `Effect.die`)
          // prove the semantic leg never started.
          expect(response.mode).toBe("keyword");
          expect(response.semanticCoverage).toBe(0);
          expect(response.degraded).toBeUndefined();
          expect(response.hits.map((hit) => hit.repo.id)).toEqual([3, 2, 1]);
        }),
      ),
      Effect.provide(testLive()),
    ),
  );

  it.effect("never reaches for a vector blob even when one would exist", () =>
    seeded(
      Effect.gen(function* () {
        // Seed a published pointer for this account. If the off path consulted
        // the vector side at all, the pointer would send it into the stubbed
        // `getVectors`/`getIds`, whose `Effect.die` fails this test — the
        // regression this case exists to catch.
        const store = yield* RepoStore;

        yield* store.putVectorBlob(LOGIN, 384, 384 * 4);

        const response = yield* runSearch({
          login: LOGIN,
          query: "http client",
          mode: "auto",
          sort: "relevance",
          filters: {},
          offset: 0,
          limit: 50,
          semanticSearch: false,
        });

        return response;
      }),
    ).pipe(
      Effect.tap((response) =>
        Effect.sync(() => {
          expect(response.mode).toBe("keyword");
          expect(response.degraded).toBeUndefined();
          expect(response.hits.length).toBeGreaterThan(0);
        }),
      ),
      Effect.provide(testLive()),
    ),
  );
});

describe("runSearch browse", () => {
  it.effect("defaults a bare empty query to most recently starred", () =>
    seeded(search({ query: "", sort: "relevance" })).pipe(
      Effect.tap((ids) => Effect.sync(() => expect(ids).toEqual([1, 2, 3]))),
      Effect.provide(testLive()),
    ),
  );

  it.effect("lists every candidate for an empty query with a sort", () =>
    seeded(search({ query: "", sort: "pushed" })).pipe(
      Effect.tap((ids) =>
        Effect.sync(() => {
          expect(ids).toEqual([2, 1, 3]);
        }),
      ),
      Effect.provide(testLive()),
    ),
  );

  it.effect("reports the browsable total and windows it with offset", () =>
    seeded(
      Effect.gen(function* () {
        const first = yield* runSearch({
          login: LOGIN,
          query: "",
          mode: "auto",
          sort: "relevance",
          filters: {},
          offset: 0,
          limit: 2,
          semanticSearch: true,
        });

        const second = yield* runSearch({
          login: LOGIN,
          query: "",
          mode: "auto",
          sort: "starred",
          filters: {},
          offset: 2,
          limit: 2,
          semanticSearch: true,
        });

        const past = yield* runSearch({
          login: LOGIN,
          query: "",
          mode: "auto",
          sort: "starred",
          filters: {},
          offset: 3,
          limit: 2,
          semanticSearch: true,
        });

        return {
          first: first.hits.map((hit) => hit.repo.id),
          firstTotal: first.total,
          second: second.hits.map((hit) => hit.repo.id),
          secondTotal: second.total,
          past: past.hits.length,
        };
      }),
    ).pipe(
      Effect.tap((page) =>
        Effect.sync(() => {
          expect(page.first).toEqual([1, 2]);
          expect(page.firstTotal).toBe(3);
          expect(page.second).toEqual([3]);
          expect(page.secondTotal).toBe(3);
          expect(page.past).toBe(0);
        }),
      ),
      Effect.provide(testLive()),
    ),
  );

  it.effect("browse hits carry no match evidence and no score", () =>
    seeded(
      Effect.gen(function* () {
        const response = yield* runSearch({
          login: LOGIN,
          query: "   ",
          mode: "auto",
          sort: "stars",
          filters: {},
          offset: 0,
          limit: 50,
          semanticSearch: true,
        });

        return response.hits.map((hit) => ({
          id: hit.repo.id,
          matchedBy: [...hit.matchedBy],
          score: hit.score,
        }));
      }),
    ).pipe(
      Effect.tap((hits) =>
        Effect.sync(() => {
          expect(hits.map((hit) => hit.id)).toEqual([3, 1, 2]);

          for (const hit of hits) {
            expect(hit.matchedBy).toEqual([]);
            expect(hit.score).toBe(0);
          }
        }),
      ),
      Effect.provide(testLive()),
    ),
  );
});
