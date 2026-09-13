import { Context, Effect, Layer, Schema } from "effect";
import type { SqlError } from "effect/unstable/sql/SqlError";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { chunk, FtsHitRow, README_MAX_CHARS, USER_FTS_MAX_CHARS } from "./sql.ts";

/**
 * Per-user FTS5 indexes (free-tier pilot, docs/13 §4.1). Two virtual tables
 * are created lazily for each login:
 *
 *   * `fts_u_<sanitized>`      — `porter unicode61` over
 *     `(full_name, description, topics, readme)`; the recall leg.
 *   * `fts_u_<sanitized>_tri`  — `trigram` over
 *     `(full_name, description, topics)`; the identifier/typo leg. README
 *     trigrams explode in size, so README text is deliberately absent.
 *
 * Rowid is the GitHub `repo_id`, so a hit maps straight back to `repos`.
 * Tables are dropped (`deleteUserFts`) instead of updated when a user is
 * evicted; the shared corpus remains the source of truth.
 */

/** One document to index for a user. `topics` are joined with spaces. */
export interface FtsDoc {
  readonly repoId: number;
  readonly fullName: string;
  readonly description: string | null;
  readonly topics: ReadonlyArray<string>;
  readonly readme: string | null;
}

export interface FtsSearchOptions {
  /**
   * Restrict the MATCH to a pre-filtered candidate set (language/stars
   * filters, semantic window, …). An explicitly empty array yields no hits.
   */
  readonly candidateIds?: ReadonlyArray<number>;
  readonly limit?: number;
  /**
   * BM25 column weights, in table column order (docs/17 §2.3 uses
   * `[10, 5, 4, 1]` for the porter table). Must match the column count of the
   * target table or SQLite raises "wrong number of arguments".
   */
  readonly weights?: ReadonlyArray<number>;
}

export interface FtsHit {
  readonly repoId: number;
  /** 1-based position in the relevance order — the rank RRF consumes. */
  readonly rank: number;
  /**
   * Relevance, higher = better: `abs(bm25)`, because FTS5's `bm25()` returns
   * negative values (more negative = better). Raw bm25 is only meaningful
   * within one table, so callers should fuse via `rank`.
   */
  readonly score: number;
}

/** Per-leg top-N used by the search engine (docs/07 §4.2, docs/17 §2.3). */
export const DEFAULT_FTS_LIMIT = 50;

/** D1 allows 100 bound params/statement; leave headroom for match + limit. */
export const FTS_CANDIDATE_CHUNK = 90;

/**
 * Physical table name for a login. GitHub logins are `[A-Za-z0-9-]`, and
 * `-` cannot collide with `_` because GitHub never allows underscores in
 * logins, so this mapping is injective over valid logins.
 */
export const ftsTableName = (login: string): string =>
  `fts_u_${login.toLowerCase().replace(/-/g, "_").replace(/[^a-z0-9_]/g, "")}`;

/** Trigram companion table (`full_name, description, topics` only). */
export const ftsTrigramTableName = (login: string): string => `${ftsTableName(login)}_tri`;

/** Per-repo README cap shared by both replace and incremental upserts. */
const capReadme = (readme: string | null): string => {
  const raw = readme ?? "";
  return raw.length > README_MAX_CHARS ? raw.slice(0, README_MAX_CHARS) : raw;
};

export interface UserFtsShape {
  readonly ensureUserFts: (login: string) => Effect.Effect<void, SqlError>;
  /**
   * Replace the user's whole index. Enforces the D1 budgets: 64 KB of README
   * per repo, then 20 MB across the user's rows; docs past the user budget
   * are indexed metadata-only (docs/14 §3.6).
   *
   * Not atomic — D1 has no transactions — but idempotent: re-run it after any
   * failure and the index converges to the supplied docs.
   */
  readonly replaceUserDocs: (login: string, docs: ReadonlyArray<FtsDoc>) => Effect.Effect<void, SqlError>;
  /**
   * Incremental variant of {@link replaceUserDocs} for the sync workflows:
   * replaces only the listed repo ids (delete-by-rowid + multi-row inserts),
   * leaving every other document in place. One statement per ~19 docs instead
   * of two per doc, so a 100-repo listing page costs ~11 of D1's 50 free
   * queries/invocation (docs/13 §1).
   *
   * Each README is capped at 64 KB; the per-user 20 MB budget stays enforced
   * by {@link replaceUserDocs} (whole-index rebuilds).
   */
  readonly upsertUserDocs: (login: string, docs: ReadonlyArray<FtsDoc>) => Effect.Effect<void, SqlError>;
  readonly deleteUserFts: (login: string) => Effect.Effect<void, SqlError>;
  readonly searchKeyword: (
    login: string,
    matchExpr: string,
    options?: FtsSearchOptions
  ) => Effect.Effect<ReadonlyArray<FtsHit>, SqlError>;
  readonly searchTrigram: (
    login: string,
    matchExpr: string,
    options?: FtsSearchOptions
  ) => Effect.Effect<ReadonlyArray<FtsHit>, SqlError>;
}

export class UserFts extends Context.Service<UserFts, UserFtsShape>()("UserFts") {
  static readonly layer = Layer.effect(
    UserFts,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      const ensureUserFts = Effect.fn("UserFts.ensureUserFts")(function* (login: string) {
        const porter = ftsTableName(login);
        const trigram = ftsTrigramTableName(login);
        yield* sql`
          CREATE VIRTUAL TABLE IF NOT EXISTS ${sql(porter)} USING fts5(
            full_name, description, topics, readme,
            tokenize = 'porter unicode61'
          )
        `;
        yield* sql`
          CREATE VIRTUAL TABLE IF NOT EXISTS ${sql(trigram)} USING fts5(
            full_name, description, topics,
            tokenize = 'trigram'
          )
        `;
      });

      const replaceUserDocs = Effect.fn("UserFts.replaceUserDocs")(function* (
        login: string,
        docs: ReadonlyArray<FtsDoc>
      ) {
        yield* ensureUserFts(login);
        const porter = ftsTableName(login);
        const trigram = ftsTrigramTableName(login);
        yield* sql`DELETE FROM ${sql(porter)}`;
        yield* sql`DELETE FROM ${sql(trigram)}`;
        let used = 0;
        for (const doc of docs) {
          const topics = doc.topics.join(" ");
          const description = doc.description ?? "";
          const capped = capReadme(doc.readme);
          const readme = used + capped.length <= USER_FTS_MAX_CHARS ? capped : "";
          used += readme.length;
          yield* sql`
            INSERT INTO ${sql(porter)} (rowid, full_name, description, topics, readme)
            VALUES (${doc.repoId}, ${doc.fullName}, ${description}, ${topics}, ${readme})
          `;
          yield* sql`
            INSERT INTO ${sql(trigram)} (rowid, full_name, description, topics)
            VALUES (${doc.repoId}, ${doc.fullName}, ${description}, ${topics})
          `;
        }
      });

      const upsertUserDocs = Effect.fn("UserFts.upsertUserDocs")(function* (
        login: string,
        docs: ReadonlyArray<FtsDoc>
      ) {
        if (docs.length === 0) return;
        yield* ensureUserFts(login);
        const porter = ftsTableName(login);
        const trigram = ftsTrigramTableName(login);

        for (const ids of chunk(docs.map((doc) => doc.repoId), FTS_CANDIDATE_CHUNK)) {
          yield* sql`DELETE FROM ${sql(porter)} WHERE rowid IN ${sql.in(ids)}`;
          yield* sql`DELETE FROM ${sql(trigram)} WHERE rowid IN ${sql.in(ids)}`;
        }

        // 5 bound params per porter row (19 × 5 = 95) and 4 per trigram row
        // (24 × 4 = 96), both under D1's 100-param ceiling.
        for (const batch of chunk(docs, 19)) {
          const values = batch.map(
            (doc) =>
              sql`(${doc.repoId}, ${doc.fullName}, ${doc.description ?? ""}, ${doc.topics.join(" ")}, ${capReadme(doc.readme)})`
          );
          yield* sql`
            INSERT INTO ${sql(porter)} (rowid, full_name, description, topics, readme)
            VALUES ${sql.csv(values)}
          `;
        }
        for (const batch of chunk(docs, 24)) {
          const values = batch.map(
            (doc) =>
              sql`(${doc.repoId}, ${doc.fullName}, ${doc.description ?? ""}, ${doc.topics.join(" ")})`
          );
          yield* sql`
            INSERT INTO ${sql(trigram)} (rowid, full_name, description, topics)
            VALUES ${sql.csv(values)}
          `;
        }
      });

      const deleteUserFts = Effect.fn("UserFts.deleteUserFts")(function* (login: string) {
        yield* sql`DROP TABLE IF EXISTS ${sql(ftsTableName(login))}`;
        yield* sql`DROP TABLE IF EXISTS ${sql(ftsTrigramTableName(login))}`;
      });

      const searchTable = (
        table: string,
        matchExpr: string,
        options: FtsSearchOptions | undefined
      ): Effect.Effect<ReadonlyArray<FtsHit>, SqlError> =>
        Effect.gen(function* () {
          const limit = options?.limit ?? DEFAULT_FTS_LIMIT;
          const candidates = options?.candidateIds;
          if (candidates !== undefined && candidates.length === 0) {
            return [];
          }
          const parts: ReadonlyArray<ReadonlyArray<number> | undefined> =
            candidates === undefined ? [undefined] : chunk(candidates, FTS_CANDIDATE_CHUNK);
          const weights = options?.weights;
          const bm25 =
            weights === undefined
              ? sql`bm25(${sql(table)})`
              : sql`bm25(${sql(table)}, ${sql.csv(weights.map((weight) => sql`${weight}`))})`;
          // `+rowid` disables FTS5's rowid constraint push-down: with a bound
          // parameter, a bare `rowid IN (?)` makes FTS5 return every match
          // (verified on SQLite 3.53.4). Unary plus forces an ordinary scan
          // filter over the MATCH result instead.
          const hits: Array<FtsHitRow> = [];
          for (const ids of parts) {
            const rows =
              ids === undefined
                ? yield* sql<FtsHitRow>`
                    SELECT rowid AS repo_id, ${bm25} AS score
                    FROM ${sql(table)}
                    WHERE ${sql(table)} MATCH ${matchExpr}
                    ORDER BY score
                    LIMIT ${limit}
                  `
                : yield* sql<FtsHitRow>`
                    SELECT rowid AS repo_id, ${bm25} AS score
                    FROM ${sql(table)}
                    WHERE ${sql(table)} MATCH ${matchExpr} AND +rowid IN ${sql.in(ids)}
                    ORDER BY score
                    LIMIT ${limit}
                  `;
            for (const row of rows) {
              hits.push(Schema.decodeUnknownSync(FtsHitRow)(row));
            }
          }
          hits.sort((a, b) => a.score - b.score || a.repoId - b.repoId);
          return hits.slice(0, limit).map((row, index) => ({
            repoId: row.repoId,
            rank: index + 1,
            score: Math.abs(row.score)
          }));
        });

      const searchKeyword = Effect.fn("UserFts.searchKeyword")(function* (
        login: string,
        matchExpr: string,
        options?: FtsSearchOptions
      ) {
        return yield* searchTable(ftsTableName(login), matchExpr, options);
      });

      const searchTrigram = Effect.fn("UserFts.searchTrigram")(function* (
        login: string,
        matchExpr: string,
        options?: FtsSearchOptions
      ) {
        return yield* searchTable(ftsTrigramTableName(login), matchExpr, options);
      });

      return UserFts.of({
        ensureUserFts,
        replaceUserDocs,
        upsertUserDocs,
        deleteUserFts,
        searchKeyword,
        searchTrigram
      });
    })
  );
}
