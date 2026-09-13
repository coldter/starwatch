import { EmbedFailed, type EmbedderShape } from "@starwatch/core/sync";
import * as Effect from "effect/Effect";

/**
 * Deterministic local stand-in for Workers AI `bge-small-en-v1.5` (384d).
 *
 * No network: an FNV-1a hash of the text seeds a mulberry32 PRNG, the raw
 * samples span `[-1, 1)`, and the result is L2-normalized into a unit vector.
 * The same text always maps to the same vector, so the semantic search path is
 * fully exercisable offline. Vector *geometry* is meaningless though — local
 * ranking quality comes from the keyword/expansion legs, never from the fake
 * embeddings.
 */

/** bge-small-en-v1.5 dimension, kept in sync with the production embedder. */
export const FAKE_EMBEDDING_DIMS = 384;

/** FNV-1a/32 over UTF-16 code units; stable across runs and platforms. */
const fnv1a = (text: string): number => {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
};

/** mulberry32: tiny deterministic PRNG returning floats in `[0, 1)`. */
const makePrng = (seed: number): (() => number) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 0x1_0000_0000;
  };
};

/** Deterministic L2-normalized {@link FAKE_EMBEDDING_DIMS}-dim vector. */
export const fakeEmbedding = (text: string, dims: number = FAKE_EMBEDDING_DIMS): Float32Array => {
  if (!Number.isInteger(dims) || dims < 1) {
    throw new RangeError(`fake embedding dims must be a positive integer, got ${dims}`);
  }
  const next = makePrng(fnv1a(text));
  const vector = new Float32Array(dims);
  let norm = 0;
  for (let i = 0; i < dims; i++) {
    const value = next() * 2 - 1;
    vector[i] = value;
    norm += value * value;
  }
  if (norm > 0) {
    const inverse = 1 / Math.sqrt(norm);
    for (let i = 0; i < dims; i++) {
      vector[i] = (vector[i] ?? 0) * inverse;
    }
  }
  return vector;
};

/** {@link EmbedderShape} implementation used by the local server. */
export const makeFakeEmbedder = (dims: number = FAKE_EMBEDDING_DIMS): EmbedderShape => ({
  embed: (texts) =>
    Effect.try({
      try: () => texts.map((text) => fakeEmbedding(text, dims)),
      catch: (cause) => new EmbedFailed({ message: `fake embedder failed: ${String(cause)}` })
    })
});
