/**
 * Workers AI embedder (`@cf/baai/bge-small-en-v1.5`, 384 dims).
 *
 * The binding is injected as a plain object so this module never imports
 * `@cloudflare/workers-types` and stays trivially testable with a fake. Calls
 * are chunked into `batchSize` requests and executed with bounded parallelism;
 * results preserve input order so callers can zip ids to vectors.
 *
 * @see docs/15-free-semantic-search.md §2.1/§5 (repo document profile, batching)
 */

import type { Repo } from "@starwatch/domain";
import { EmbedFailed, type EmbedderService } from "@starwatch/core/sync";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export const EMBEDDING_MODEL = "@cf/baai/bge-small-en-v1.5";

export const EMBEDDING_DIMS = 384;

/**
 * Raw envelope returned by the Workers AI text-embedding model (`Ai.run`).
 * apps/worker decodes the raw binding result with this schema so the binding
 * adapter never has to assert the payload shape.
 */
export const WorkersAiTextEmbedding = Schema.Struct({
  data: Schema.Array(Schema.Array(Schema.Number)),
});

export type WorkersAiTextEmbedding = typeof WorkersAiTextEmbedding.Type;

/** Minimal Workers AI surface we depend on (structurally `Ai.run`). */
export interface WorkersAiBinding {
  readonly run: (
    model: string,
    input: { readonly text: ReadonlyArray<string> },
  ) => Promise<{ readonly data: ReadonlyArray<ReadonlyArray<number>> }>;
}

export interface WorkersAiEmbedderOptions {
  /** Texts per Workers AI request (model max is 32 on the free path). */
  readonly batchSize?: number | undefined;
  /** In-flight requests; Workers AI allows 3,000 req/min, so keep this small. */
  readonly concurrency?: number | undefined;
}

const DEFAULT_BATCH_SIZE = 32;

const DEFAULT_CONCURRENCY = 2;

const MAX_README_CHARS = 1_500;

const WHITESPACE = /\s+/g;

/** Split `texts` into consecutive fixed-size chunks (last chunk may be short). */
export const batchTexts = (
  texts: ReadonlyArray<string>,
  size: number,
): ReadonlyArray<ReadonlyArray<string>> => {
  if (!Number.isInteger(size) || size < 1) {
    throw new RangeError(`batch size must be a positive integer, got ${size}`);
  }

  const batches: string[][] = [];

  for (let i = 0; i < texts.length; i += size) {
    batches.push(texts.slice(i, i + size));
  }

  return batches;
};

export interface RepoEmbeddingTextOptions {
  /** Hard cap for the distilled README excerpt (docs/15 §2.1: 1,400–1,500). */
  readonly maxChars?: number | undefined;
}

/**
 * The repo document that gets embedded (docs/15 §2.1):
 *
 * ```
 * {fullName} — {description}
 * Topics: a, b
 * Language: X
 * {readmeExcerpt}
 * ```
 *
 * Empty optional lines are dropped; all whitespace is collapsed so the token
 * budget is spent on content, not markdown layout.
 */
export const repoEmbeddingText = (
  repo: Repo,
  readme: string | null | undefined,
  options: RepoEmbeddingTextOptions = {},
): string => {
  const maxChars = options.maxChars ?? MAX_README_CHARS;
  const description = repo.description?.replace(WHITESPACE, " ").trim() ?? "";

  const lines: string[] =
    description.length > 0
      ? [`${repo.fullName} — ${description}`]
      : [repo.fullName];

  if (repo.topics.length > 0) {
    lines.push(`Topics: ${repo.topics.join(", ")}`);
  }

  if (repo.language !== null && repo.language.length > 0) {
    lines.push(`Language: ${repo.language}`);
  }

  const excerpt = readme?.replace(WHITESPACE, " ").trim() ?? "";

  if (excerpt.length > 0) {
    lines.push(excerpt.slice(0, Math.max(0, maxChars)));
  }

  return lines.filter((line) => line.length > 0).join("\n");
};

const validateDimension = (value: number, where: string): number => {
  if (value < 1) {
    throw new RangeError(`${where} must be >= 1, got ${value}`);
  }

  return value;
};

/**
 * Build an {@link EmbedderService} over a Workers AI binding.
 *
 * Batching + bounded concurrency keep one user's embedding pass inside the
 * Workers free CPU/subrequest envelope (docs/15 §2.5); failures are wrapped in
 * {@link EmbedFailed} so the workflow can mark a batch errored and continue.
 */
export const makeWorkersAiEmbedder = (
  binding: WorkersAiBinding,
  options: WorkersAiEmbedderOptions = {},
): EmbedderService => {
  const batchSize = validateDimension(
    options.batchSize ?? DEFAULT_BATCH_SIZE,
    "batchSize",
  );
  const concurrency = validateDimension(
    options.concurrency ?? DEFAULT_CONCURRENCY,
    "concurrency",
  );

  const runBatch = (
    batch: ReadonlyArray<string>,
    index: number,
  ): Effect.Effect<ReadonlyArray<Float32Array>, EmbedFailed> =>
    Effect.tryPromise({
      try: () => binding.run(EMBEDDING_MODEL, { text: [...batch] }),
      catch: (cause) =>
        new EmbedFailed({
          message: `Workers AI embedding batch ${index} failed: ${String(cause)}`,
        }),
    }).pipe(
      Effect.flatMap((result) => {
        const rows = result.data;

        if (!Array.isArray(rows) || rows.length !== batch.length) {
          return Effect.fail(
            new EmbedFailed({
              message: `Workers AI returned ${
                Array.isArray(rows) ? rows.length : "no"
              } embeddings for ${batch.length} texts`,
            }),
          );
        }

        return Effect.succeed(rows.map((row) => Float32Array.from(row)));
      }),
    );

  return {
    embed: (texts) =>
      Effect.forEach(batchTexts(texts, batchSize), runBatch, {
        concurrency,
      }).pipe(Effect.map((results) => results.flat())),
  };
};
