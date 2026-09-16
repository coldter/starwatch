/**
 * Vector storage + similarity primitives (frozen API — see docs/15, docs/17).
 *
 * Blob layout, little-endian:
 *   magic   2 bytes  0x53 0x57 ("SW")
 *   version 1 byte   = 1
 *   pad     1 byte   = 0
 *   count   uint32
 *   dims    uint32
 *   data    float32[count * dims]
 *
 * Header = {@link BLOB_HEADER_BYTES} bytes. Storing `count`/`dims` in the
 * header lets readers validate without side metadata.
 */

export const BLOB_HEADER_BYTES = 12;

const MAGIC_0 = 0x53;

const MAGIC_1 = 0x57;

const VERSION = 1;

export class VectorCodecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VectorCodecError";
  }
}

/** Serialize vectors into a single immutable blob. */
export const encodeVectors = (vectors: ReadonlyArray<Float32Array>): Uint8Array => {
  const count = vectors.length;
  const dims = count === 0 ? 0 : (vectors[0]?.length ?? 0);

  for (const v of vectors) {
    if (v.length !== dims) {
      throw new VectorCodecError(`all vectors must share dims=${dims}, got ${v.length}`);
    }
  }

  const bytes = new Uint8Array(BLOB_HEADER_BYTES + count * dims * 4);
  const view = new DataView(bytes.buffer);
  bytes[0] = MAGIC_0;
  bytes[1] = MAGIC_1;
  bytes[2] = VERSION;
  bytes[3] = 0;
  view.setUint32(4, count, true);
  view.setUint32(8, dims, true);

  const data = new Float32Array(bytes.buffer, BLOB_HEADER_BYTES, count * dims);
  let offset = 0;

  for (const v of vectors) {
    data.set(v, offset);
    offset += v.length;
  }

  return bytes;
};

/** Parse a blob produced by {@link encodeVectors}. */
export const decodeVectors = (bytes: Uint8Array): ReadonlyArray<Float32Array> => {
  if (bytes.length < BLOB_HEADER_BYTES) {
    throw new VectorCodecError(`blob too small: ${bytes.length} bytes`);
  }

  if (bytes[0] !== MAGIC_0 || bytes[1] !== MAGIC_1) {
    throw new VectorCodecError("bad magic bytes");
  }

  if (bytes[2] !== VERSION) {
    throw new VectorCodecError(`unsupported version: ${bytes[2]}`);
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint32(4, true);
  const dims = view.getUint32(8, true);
  const expected = BLOB_HEADER_BYTES + count * dims * 4;

  if (bytes.length !== expected) {
    throw new VectorCodecError(`length mismatch: expected ${expected}, got ${bytes.length}`);
  }

  const out: Float32Array[] = [];

  for (let i = 0; i < count; i++) {
    const vec = new Float32Array(dims);

    for (let j = 0; j < dims; j++) {
      vec[j] = view.getFloat32(BLOB_HEADER_BYTES + (i * dims + j) * 4, true);
    }

    out[i] = vec;
  }

  return out;
};

/** Cosine similarity; returns 0 when either vector is all zeros. */
export const cosineSimilarity = (a: Float32Array, b: Float32Array): number => {
  if (a.length !== b.length) {
    throw new VectorCodecError(`dims mismatch: ${a.length} vs ${b.length}`);
  }

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }

  if (normA === 0 || normB === 0) return 0;

  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
};

export interface VectorEntry {
  readonly id: number;
  readonly vector: Float32Array;
}

export interface Similar {
  readonly id: number;
  readonly score: number;
}

/**
 * Top-k nearest neighbors by cosine similarity.
 * Brute force is intentional: corpora are bounded to
 * SEMANTIC_WINDOW (1,500) repos per user (docs/15).
 */
export const topK = (
  query: Float32Array,
  entries: ReadonlyArray<VectorEntry>,
  k: number
): ReadonlyArray<Similar> => {
  if (k <= 0 || entries.length === 0) return [];

  const scored: Similar[] = entries.map((entry) => ({
    id: entry.id,
    score: cosineSimilarity(query, entry.vector)
  }));

  scored.sort((x, y) => y.score - x.score || x.id - y.id);

  return scored.slice(0, k);
};
