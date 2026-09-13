/// <reference types="node" />
import { createServer } from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { makeGithubClient } from "@starwatch/cloudflare/github";
import {
  camelize,
  R2VectorBlobStore,
  RepoStore,
  UserFts,
  VectorBlobStore
} from "@starwatch/cloudflare/storage";
import { Embedder } from "@starwatch/core/sync";
import { NodeHttpServer, NodeRuntime } from "@effect/platform-node";
import { SqliteClient } from "@effect/sql-sqlite-node";
import { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import { makeVectorBlobFiles } from "../adapters/vector-bucket.ts";
import { StarwatchApi } from "../api.ts";
import type { SyncDepsShape } from "../deps.ts";
import { reposGroup } from "../handlers/repos.ts";
import { searchGroup } from "../handlers/search.ts";
import { systemGroup } from "../handlers/system.ts";
import type { WorkerDeps } from "../handlers/types.ts";
import { usersGroup } from "../handlers/users.ts";
import { makeFakeEmbedder } from "./fake-embedder.ts";
import { makeInMemoryRawBucket } from "./in-memory-bucket.ts";
import { startLocalSync } from "./local-sync.ts";

/**
 * Local dev entrypoint: the production `StarwatchApi` on Node with
 *
 *   * SQLite (`node:sqlite` via `@effect/sql-sqlite-node`) instead of D1,
 *   * an in-memory bucket instead of R2,
 *   * a deterministic fake embedder instead of Workers AI,
 *   * `startLocalSync` instead of the Cloudflare Workflows runtime.
 *
 * Run with `pnpm --filter @starwatch/worker run dev:local`; configure with
 * `STARWATCH_PORT` (default 8787), `STARWATCH_DB` (default `.dev/starwatch.db`)
 * and `GITHUB_TOKEN` (optional; anonymous access works but is rate limited).
 */

const MIGRATIONS_DIR = fileURLToPath(new URL("../../migrations/", import.meta.url));

/**
 * Apply `migrations/*.sql` in filename order. Local-only bookkeeping: an
 * applied-migrations table keeps 0002's `ALTER TABLE` from re-running (the
 * production D1 migrator tracks this remotely; SQLite does not).
 */
const applyMigrations = (filename: string): void => {
  const db = new DatabaseSync(filename);
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS local_migrations (
        name       TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL
      )
    `);
    const applied = new Set(
      db
        .prepare("SELECT name FROM local_migrations")
        .all()
        .map((row) => String(row["name"]))
    );
    const files = fs
      .readdirSync(MIGRATIONS_DIR)
      .filter((file) => file.endsWith(".sql"))
      .sort();
    for (const file of files) {
      if (applied.has(file)) continue;
      const script = fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
      db.exec("BEGIN");
      try {
        db.exec(script);
        db.prepare("INSERT INTO local_migrations (name, applied_at) VALUES (?, ?)").run(
          file,
          new Date().toISOString()
        );
        db.exec("COMMIT");
      } catch (cause) {
        db.exec("ROLLBACK");
        throw new Error(`migration ${file} failed`, { cause });
      }
      console.log(`[starwatch] applied migration ${file}`);
    }
  } finally {
    db.close();
  }
};

const token = process.env.GITHUB_TOKEN ?? "";
const port = Number(process.env.STARWATCH_PORT ?? "8787");
const dbPath = path.resolve(process.cwd(), process.env.STARWATCH_DB ?? ".dev/starwatch.db");

fs.mkdirSync(path.dirname(dbPath), { recursive: true });
applyMigrations(dbPath);

// ---- service graph --------------------------------------------------------

const sql = SqliteClient.layer({ filename: dbPath, transformResultNames: camelize });
const storage = Layer.mergeAll(RepoStore.layer, UserFts.layer).pipe(Layer.provide(sql));
const github = makeGithubClient({
  token,
  userAgent: "starwatch-local"
}).pipe(Layer.provide(FetchHttpClient.layer));
const embedder = makeFakeEmbedder();

// One bucket backs both the write path (`vectorFiles`) and the search path
// (`R2VectorBlobStore`), otherwise semantic search would read an empty store.
const rawBucket = makeInMemoryRawBucket();
const vectorFiles = makeVectorBlobFiles(rawBucket);
const vectorStore = new R2VectorBlobStore(rawBucket);

const rateLimitStub: Cloudflare.RateLimitClient = {
  raw: Effect.die("rate limits are disabled in local mode"),
  limit: () => Effect.succeed({ success: true })
} as unknown as Cloudflare.RateLimitClient;

const sync: SyncDepsShape = {
  storage,
  github,
  embedder,
  vectorFiles,
  runLayers: Layer.mergeAll(storage, github, Layer.succeed(Embedder, embedder))
};

const deps: WorkerDeps = {
  sync,
  searchLayer: Layer.mergeAll(
    storage,
    Layer.succeed(Embedder, embedder),
    Layer.succeed(VectorBlobStore, vectorStore)
  ),
  vectorFiles,
  searchRate: rateLimitStub,
  syncRate: rateLimitStub,
  listing: startLocalSync({
    storageLayer: storage,
    githubLayer: github,
    embedder,
    vectorFiles
  })
};

const app = HttpApiBuilder.layer(StarwatchApi).pipe(
  Layer.provide(Layer.mergeAll(systemGroup(deps), usersGroup(deps), searchGroup(deps), reposGroup(deps)))
);

const server = HttpRouter.serve(app).pipe(
  Layer.provide(NodeHttpServer.layer(createServer, { port })),
  // The `RateLimitClient` type carries Alchemy's `RuntimeContext` requirement;
  // the local stub never touches it, so an empty provider satisfies the types.
  Layer.provide(RuntimeContext.phantom)
);

console.log(
  `starwatch local → http://127.0.0.1:${port} (db ${dbPath}, GitHub: ${
    token.length > 0 ? "authenticated" : "anonymous"
  })`
);

NodeRuntime.runMain(Layer.launch(server));
