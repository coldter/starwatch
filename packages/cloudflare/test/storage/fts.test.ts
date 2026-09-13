import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { ftsTableName, ftsTrigramTableName, UserFts } from "../../src/storage/fts.ts";
import { makeFtsDoc, makeSqliteLayer, applyMigration } from "./support.ts";

const LOGIN = "coldter";

const testLive = () => UserFts.layer.pipe(Layer.provideMerge(makeSqliteLayer()));

const seedDocs = Effect.gen(function* () {
  const fts = yield* UserFts;
  yield* fts.replaceUserDocs(LOGIN, [
    makeFtsDoc(1, "better-auth/better-auth", {
      description: "The most comprehensive authentication framework",
      topics: ["auth", "oauth"],
      readme: "Authentication, OAuth and session management."
    }),
    makeFtsDoc(2, "nuxflare/auth", {
      description: "Tiny auth server",
      topics: ["auth"],
      readme: "auth for everyone"
    }),
    makeFtsDoc(3, "vector-db/vectordb", {
      description: "vector database",
      topics: ["vector"],
      readme: "semantic search over embeddings"
    })
  ]);
});

const hitIds = (hits: ReadonlyArray<{ readonly repoId: number }>): ReadonlyArray<number> =>
  hits.map((hit) => hit.repoId);

describe("UserFts", () => {
  it.effect("derives collision-free physical table names", () =>
    Effect.sync(() => {
      expect(ftsTableName("Cold-Ter")).toBe("fts_u_cold_ter");
      expect(ftsTableName("a-b")).not.toBe(ftsTableName("ab"));
      expect(ftsTableName("a--b")).not.toBe(ftsTableName("a-b"));
      expect(ftsTrigramTableName("Cold-Ter")).toBe("fts_u_cold_ter_tri");
    })
  );

  it.effect("ensures both tables idempotently", () =>
    Effect.gen(function* () {
      yield* applyMigration;
      const fts = yield* UserFts;
      yield* fts.ensureUserFts(LOGIN);
      yield* fts.ensureUserFts(LOGIN);
      yield* fts.replaceUserDocs(LOGIN, [makeFtsDoc(1, "owner/one", { readme: "hello" })]);
      expect(hitIds(yield* fts.searchKeyword(LOGIN, '"hello"'))).toEqual([1]);
    }).pipe(Effect.provide(testLive()))
  );

  it.effect("searches the porter index with stemming and ranked bm25 scores", () =>
    Effect.gen(function* () {
      yield* applyMigration;
      yield* seedDocs;
      const fts = yield* UserFts;

      // Exact token: "auth" in names/topics matches repos 1 and 2 only.
      const authHits = yield* fts.searchKeyword(LOGIN, '"auth"');
      expect(new Set(hitIds(authHits))).toEqual(new Set([1, 2]));
      expect(authHits.map((hit) => hit.rank)).toEqual([1, 2]);
      const scores = authHits.map((hit) => hit.score);
      expect(scores[0]).toBeGreaterThanOrEqual(scores[1] ?? 0);

      // Porter stemming: "authenticate" → "authent" matches "Authentication".
      expect(hitIds(yield* fts.searchKeyword(LOGIN, '"authenticate"'))).toEqual([1]);
      expect(hitIds(yield* fts.searchKeyword(LOGIN, '"authentication"'))).toEqual([1]);

      // A readme-only token is found by the porter index.
      expect(hitIds(yield* fts.searchKeyword(LOGIN, '"embeddings"'))).toEqual([3]);
    }).pipe(Effect.provide(testLive()))
  );

  it.effect("searches the trigram index for substrings and ignores readmes", () =>
    Effect.gen(function* () {
      yield* applyMigration;
      yield* seedDocs;
      const fts = yield* UserFts;

      expect(hitIds(yield* fts.searchTrigram(LOGIN, '"flar"'))).toEqual([2]);
      expect(new Set(hitIds(yield* fts.searchTrigram(LOGIN, '"auth"')))).toEqual(new Set([1, 2]));

      // README text is deliberately absent from the trigram table.
      yield* fts.replaceUserDocs(LOGIN, [
        makeFtsDoc(1, "owner/plain", { description: null, topics: [], readme: "zebra" })
      ]);
      expect(hitIds(yield* fts.searchTrigram(LOGIN, '"zeb"'))).toEqual([]);
    }).pipe(Effect.provide(testLive()))
  );

  it.effect("respects the limit option", () =>
    Effect.gen(function* () {
      yield* applyMigration;
      yield* seedDocs;
      const fts = yield* UserFts;
      expect((yield* fts.searchKeyword(LOGIN, '"auth"', { limit: 1 })).length).toBe(1);
    }).pipe(Effect.provide(testLive()))
  );

  it.effect("accepts explicit bm25 column weights", () =>
    Effect.gen(function* () {
      yield* applyMigration;
      yield* seedDocs;
      const fts = yield* UserFts;

      const porter = yield* fts.searchKeyword(LOGIN, '"auth"', { weights: [10, 5, 4, 1] });
      expect(new Set(hitIds(porter))).toEqual(new Set([1, 2]));

      const trigram = yield* fts.searchTrigram(LOGIN, '"flar"', { weights: [3, 2, 1] });
      expect(hitIds(trigram)).toEqual([2]);
    }).pipe(Effect.provide(testLive()))
  );

  it.effect("isolates per-user indexes", () =>
    Effect.gen(function* () {
      yield* applyMigration;
      const fts = yield* UserFts;

      // The same repo_id exists in both users' indexes with different text.
      yield* fts.replaceUserDocs("alice", [makeFtsDoc(1, "alice/alpha", { readme: "alpha content" })]);
      yield* fts.replaceUserDocs("bob", [makeFtsDoc(1, "bob/beta", { readme: "beta content" })]);

      expect(hitIds(yield* fts.searchKeyword("alice", '"alpha"'))).toEqual([1]);
      expect(hitIds(yield* fts.searchKeyword("alice", '"beta"'))).toEqual([]);
      expect(hitIds(yield* fts.searchKeyword("bob", '"beta"'))).toEqual([1]);
      expect(hitIds(yield* fts.searchKeyword("bob", '"alpha"'))).toEqual([]);

      expect(hitIds(yield* fts.searchTrigram("alice", '"alph"'))).toEqual([1]);
      expect(hitIds(yield* fts.searchTrigram("alice", '"beta"'))).toEqual([]);
      expect(hitIds(yield* fts.searchTrigram("bob", '"beta"'))).toEqual([1]);

      // Dropping one user's tables leaves the other intact.
      yield* fts.deleteUserFts("alice");
      expect(hitIds(yield* fts.searchKeyword("bob", '"beta"'))).toEqual([1]);
    }).pipe(Effect.provide(testLive()))
  );

  it.effect("restricts matches to candidate repo ids, chunking past the parameter limit", () =>
    Effect.gen(function* () {
      yield* applyMigration;
      yield* seedDocs;
      const fts = yield* UserFts;

      expect(hitIds(yield* fts.searchKeyword(LOGIN, '"auth"', { candidateIds: [2] }))).toEqual([2]);
      expect(hitIds(yield* fts.searchKeyword(LOGIN, '"auth"', { candidateIds: [3] }))).toEqual([]);
      expect(hitIds(yield* fts.searchKeyword(LOGIN, '"auth"', { candidateIds: [] }))).toEqual([]);

      // 96 candidates span two D1-safe chunks; only docs 1 and 2 can match.
      const candidates = Array.from({ length: 96 }, (_, index) => index + 1);
      const chunked = yield* fts.searchKeyword(LOGIN, '"auth"', { candidateIds: candidates });
      expect(new Set(hitIds(chunked))).toEqual(new Set([1, 2]));
      expect(chunked.map((hit) => hit.rank)).toEqual([1, 2]);
      expect(hitIds(yield* fts.searchTrigram(LOGIN, '"flar"', { candidateIds: candidates }))).toEqual([2]);
    }).pipe(Effect.provide(testLive()))
  );

  it.effect("dropping a user index is idempotent and rebuildable", () =>
    Effect.gen(function* () {
      yield* applyMigration;
      const fts = yield* UserFts;
      yield* fts.replaceUserDocs(LOGIN, [makeFtsDoc(1, "owner/one", { readme: "hello" })]);
      yield* fts.deleteUserFts(LOGIN);
      yield* fts.deleteUserFts(LOGIN);
      yield* fts.replaceUserDocs(LOGIN, [makeFtsDoc(1, "owner/one", { readme: "hello again" })]);
      expect(hitIds(yield* fts.searchKeyword(LOGIN, '"hello"'))).toEqual([1]);
    }).pipe(Effect.provide(testLive()))
  );

  it.effect("upserts docs incrementally, replacing only the listed rows", () =>
    Effect.gen(function* () {
      yield* applyMigration;
      yield* seedDocs;
      const fts = yield* UserFts;

      // Replace doc 2 (README + description change, auth topic dropped) and add
      // doc 4; docs 1 and 3 must be untouched.
      yield* fts.upsertUserDocs(LOGIN, [
        makeFtsDoc(2, "nuxflare/auth", {
          description: "rewritten",
          topics: [],
          readme: "totally different"
        }),
        makeFtsDoc(4, "fresh/one", { readme: "brand new" })
      ]);

      // Doc 2's old readme terms are gone (its name still matches "auth").
      expect(hitIds(yield* fts.searchKeyword(LOGIN, '"everyone"'))).toEqual([]);
      expect(hitIds(yield* fts.searchKeyword(LOGIN, '"different"'))).toEqual([2]);
      expect(hitIds(yield* fts.searchKeyword(LOGIN, '"semantic"'))).toEqual([3]);
      expect(hitIds(yield* fts.searchKeyword(LOGIN, '"brand"'))).toEqual([4]);
      // The trigram row for doc 2 was replaced (name unchanged, description gone).
      expect(hitIds(yield* fts.searchTrigram(LOGIN, '"rewritten"'))).toEqual([2]);
      expect(hitIds(yield* fts.searchTrigram(LOGIN, '"vector"'))).toEqual([3]);
    }).pipe(Effect.provide(testLive()))
  );

  it.effect("upserts multi-row batches beyond the 19-row statement chunk", () =>
    Effect.gen(function* () {
      yield* applyMigration;
      const fts = yield* UserFts;
      const docs = Array.from({ length: 45 }, (_, index) =>
        makeFtsDoc(index + 1, `bulk/repo-${index + 1}`, { readme: `token${index + 1} shared` })
      );
      yield* fts.upsertUserDocs(LOGIN, docs);

      expect(hitIds(yield* fts.searchKeyword(LOGIN, '"token45"'))).toEqual([45]);
      expect(hitIds(yield* fts.searchKeyword(LOGIN, '"token1"'))).toEqual([1]);
      expect((yield* fts.searchKeyword(LOGIN, '"shared"', { limit: 50 })).length).toBe(45);
    }).pipe(Effect.provide(testLive()))
  );

  it.effect("caps README text at 64 KB per repo", () =>
    Effect.gen(function* () {
      yield* applyMigration;
      const fts = yield* UserFts;
      const filler = "z".repeat(64 * 1024);

      yield* fts.replaceUserDocs(LOGIN, [
        makeFtsDoc(1, "owner/big", { readme: `headertoken ${filler} tailtoken` })
      ]);
      expect(hitIds(yield* fts.searchKeyword(LOGIN, '"headertoken"'))).toEqual([1]);
      expect(hitIds(yield* fts.searchKeyword(LOGIN, '"tailtoken"'))).toEqual([]);
    }).pipe(Effect.provide(testLive()))
  );
});
