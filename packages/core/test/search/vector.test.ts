import { describe, expect, it } from "@effect/vitest";
import {
  BLOB_HEADER_BYTES,
  VectorCodecError,
  cosineSimilarity,
  decodeVectors,
  encodeVectors,
  topK,
} from "../../src/search/vector.ts";

describe("vector codec", () => {
  it("round-trips vectors through the blob layout", () => {
    const vectors = [new Float32Array([1, 2, 3]), new Float32Array([-4, 0.5, 6.25])];
    const blob = encodeVectors(vectors);
    expect(blob.length).toBe(BLOB_HEADER_BYTES + 2 * 3 * 4);

    const decoded = decodeVectors(blob);
    expect(decoded).toHaveLength(2);
    expect(Array.from(decoded[0]!)).toEqual([1, 2, 3]);
    expect(Array.from(decoded[1]!)).toEqual([-4, 0.5, 6.25]);
  });

  it("round-trips an empty index", () => {
    const decoded = decodeVectors(encodeVectors([]));
    expect(decoded).toEqual([]);
  });

  it("rejects vectors with mismatched dims", () => {
    expect(() => encodeVectors([new Float32Array([1, 2]), new Float32Array([1])])).toThrow(
      VectorCodecError,
    );
  });

  it("rejects malformed blobs", () => {
    expect(() => decodeVectors(new Uint8Array(4))).toThrow(VectorCodecError);
    const blob = encodeVectors([new Float32Array([1, 2, 3])]);
    const badMagic = new Uint8Array(blob);
    badMagic[0] = 0;
    expect(() => decodeVectors(badMagic)).toThrow(VectorCodecError);
    expect(() => decodeVectors(blob.subarray(0, blob.length - 4))).toThrow(VectorCodecError);
  });
});

describe("cosineSimilarity", () => {
  it("is 1 for identical directions and 0 for orthogonal vectors", () => {
    const a = new Float32Array([1, 0]);
    const b = new Float32Array([1, 0]);
    const c = new Float32Array([0, 1]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(1, 12);
    expect(cosineSimilarity(a, c)).toBeCloseTo(0, 12);
  });

  it("returns 0 when either vector is all zeros", () => {
    expect(cosineSimilarity(new Float32Array([0, 0]), new Float32Array([1, 1]))).toBe(0);
  });

  it("throws on dims mismatch", () => {
    expect(() => cosineSimilarity(new Float32Array([1]), new Float32Array([1, 2]))).toThrow(
      VectorCodecError,
    );
  });
});

describe("topK", () => {
  it("orders by cosine and respects k", () => {
    const query = new Float32Array([1, 0]);

    const entries = [
      { id: 1, vector: new Float32Array([0, 1]) },
      { id: 2, vector: new Float32Array([1, 0]) },
      { id: 3, vector: new Float32Array([0.5, 0.5]) },
    ];

    const result = topK(query, entries, 2);
    expect(result.map((entry) => entry.id)).toEqual([2, 3]);
    expect(result[0]?.score).toBeCloseTo(1, 12);
  });

  it("breaks score ties by id ascending", () => {
    const query = new Float32Array([1, 0]);

    const entries = [
      { id: 9, vector: new Float32Array([1, 0]) },
      { id: 4, vector: new Float32Array([1, 0]) },
    ];

    expect(topK(query, entries, 2).map((entry) => entry.id)).toEqual([4, 9]);
  });

  it("returns an empty array for k <= 0 or no entries", () => {
    expect(topK(new Float32Array([1]), [], 5)).toEqual([]);
    expect(topK(new Float32Array([1]), [{ id: 1, vector: new Float32Array([1]) }], 0)).toEqual([]);
  });
});
