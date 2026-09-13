import type { RawR2Bucket, RawR2Object } from "../adapters/vector-bucket.ts";

/**
 * Map-backed stand-in for the R2 binding, for local dev.
 *
 * Keys map to copies of the written bytes, so callers can never mutate stored
 * state through a returned buffer. The shape satisfies both {@link RawR2Bucket}
 * (used by `makeVectorBlobFiles`) and the structurally identical
 * `VectorBlobBucket` (used by `R2VectorBlobStore`), which is what lets the
 * local server share one bucket between the write and search paths.
 */
export class InMemoryRawR2Bucket implements RawR2Bucket {
  private readonly objects = new Map<string, Uint8Array>();

  /** Number of stored objects; handy for tests and debugging. */
  get size(): number {
    return this.objects.size;
  }

  async get(key: string): Promise<RawR2Object | null> {
    const value = this.objects.get(key);
    if (value === undefined) {
      return null;
    }
    const copy = value.slice();
    return { arrayBuffer: async () => copy.buffer as ArrayBuffer };
  }

  async put(key: string, value: Uint8Array): Promise<unknown> {
    return this.objects.set(key, value.slice());
  }

  async delete(keys: string | string[]): Promise<unknown> {
    if (typeof keys === "string") {
      return this.objects.delete(keys);
    }
    for (const key of keys) {
      this.objects.delete(key);
    }
    return undefined;
  }
}

export const makeInMemoryRawBucket = (): RawR2Bucket => new InMemoryRawR2Bucket();
