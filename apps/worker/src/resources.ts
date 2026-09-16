import * as Cloudflare from "alchemy/Cloudflare";

/**
 * Logical resources, declared once at module scope so both the Stack
 * (alchemy.run.ts) and the Worker (src/worker.ts) reference the same values.
 *
 * Free-tier launcher (docs/15 §1): there is deliberately NO Vectorize index.
 * Semantic search runs over per-user R2 blobs + in-Worker kNN, so the only
 * durable resources are one D1 database and one R2 bucket.
 */

export const Database = Cloudflare.D1.Database("StarwatchDatabase", {
  // Canonical schema lives in ./migrations (0001_init.sql); Alchemy applies
  // pending files on deploy under its own `__alchemy_migrations` table.
  migrations: "./migrations",
});

export const Bucket = Cloudflare.R2.Bucket("StarwatchBucket", {
  // Allow `alchemy destroy` to empty the bucket first (R2 refuses to delete
  // non-empty buckets).
  forceDestroy: true,
});
