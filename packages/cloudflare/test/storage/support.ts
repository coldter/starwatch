/// <reference types="node" />
import { readdirSync, readFileSync } from "node:fs";
import { SqliteClient } from "@effect/sql-sqlite-node";
import type { Repo, UserIndexState, UserProfile } from "@starwatch/domain";
import { Effect, Layer } from "effect";
import type { SqlError } from "effect/unstable/sql/SqlError";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { camelize } from "../../src/storage/sql.ts";
import type { FtsDoc } from "../../src/storage/fts.ts";

/**
 * Test harness: a fresh in-memory SQLite database per test, migrated with the
 * real `apps/worker/migrations/0001_init.sql`. `node:sqlite` (SQLite 3.53.4)
 * has live FTS5, so the per-user runtime DDL is exercised for real.
 */

export const MIGRATIONS_DIR_URL = new URL("../../../../apps/worker/migrations/", import.meta.url);

/** Migration files in lexical (apply) order: 0001_init.sql, 0002_*.sql, … */
export const migrationFiles = (): ReadonlyArray<string> =>
  readdirSync(MIGRATIONS_DIR_URL.pathname)
    .filter((name) => name.endsWith(".sql"))
    .sort();

/** Statements of every canonical migration, in file order (comments stripped). */
export const migrationStatements = (): ReadonlyArray<string> =>
  migrationFiles().flatMap((name) => {
    const text: string = readFileSync(new URL(name, MIGRATIONS_DIR_URL).pathname, "utf8");

    return text
      .replace(/^\s*--.*$/gm, "")
      .split(";")
      .map((statement) => statement.trim())
      .filter((statement) => statement.length > 0);
  });

/** `transformResultNames: camelize` mirrors the production D1 client config. */
export const makeSqliteLayer = (): Layer.Layer<SqlClient.SqlClient> =>
  SqliteClient.layer({ filename: ":memory:", transformResultNames: camelize });

/** Apply `0001_init.sql` to the provided client. */
export const applyMigration: Effect.Effect<void, SqlError, SqlClient.SqlClient> = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  for (const statement of migrationStatements()) {
    yield* sql.unsafe(statement);
  }
});

export const makeRepo = (id: number, fullName: string, overrides: Partial<Repo> = {}): Repo => {
  const [owner = "owner", name = `repo-${id}`] = fullName.split("/");

  return {
    id,
    fullName,
    owner,
    name,
    description: null,
    language: null,
    topics: [],
    stars: 0,
    forks: 0,
    archived: false,
    license: null,
    homepage: null,
    pushedAt: null,
    starredAt: null,
    htmlUrl: `https://github.com/${fullName}`,
    ...overrides
  };
};

export const makeUser = (login: string, overrides: Partial<UserProfile> = {}): UserProfile => ({
  login,
  id: 1,
  name: null,
  avatarUrl: `https://avatars.githubusercontent.com/${login}`,
  bio: null,
  company: null,
  location: null,
  followers: 0,
  publicRepos: 0,
  createdAt: "2020-01-01T00:00:00Z",
  ...overrides
});

export const makeIndexState = (login: string, overrides: Partial<UserIndexState> = {}): UserIndexState => ({
  login,
  phase: "ready",
  starsTotal: 0,
  reposMetadata: 0,
  readmesFetched: 0,
  semanticDocs: 0,
  lastSyncedAt: null,
  lastError: null,
  updatedAt: "2026-09-13T00:00:00.000Z",
  ...overrides
});

export const makeFtsDoc = (repoId: number, fullName: string, overrides: Partial<FtsDoc> = {}): FtsDoc => ({
  repoId,
  fullName,
  description: null,
  topics: [],
  readme: null,
  ...overrides
});
