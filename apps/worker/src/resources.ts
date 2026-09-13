import * as Cloudflare from "alchemy/Cloudflare";

/**
 * Logical resources, declared once at module scope so both the Stack
 * (alchemy.run.ts) and the Worker (src/worker.ts) reference the same values.
 */

export const Database = Cloudflare.D1.Database("StarwatchDatabase", {});

export const Bucket = Cloudflare.R2.Bucket("StarwatchBucket", {
  // Allow `alchemy destroy` to empty the bucket first (R2 refuses to delete
  // non-empty buckets).
  forceDestroy: true
});

/** bge-m3 = 1024 dimensions, cosine similarity (see docs/01-search-and-index.md). */
export const Embeddings = Cloudflare.Vectorize.Index("StarwatchEmbeddings", {
  dimensions: 1024,
  metric: "cosine"
});
