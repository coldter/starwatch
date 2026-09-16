import { describe, expect, it } from "@effect/vitest";
import { decodeVectors, encodeVectors, topK } from "@starwatch/core/search";
import { Effect } from "effect";
import {
  InMemoryVectorBlobBucket,
  InMemoryVectorBlobStore,
  R2VectorBlobStore,
  VectorBlobStore,
  vectorBlobKey,
} from "../../src/storage/vector-store.ts";

const LOGIN = "coldter";

const makeVectors = (): ReadonlyArray<Float32Array> => [
  new Float32Array([1, 0, 0, 0]),
  new Float32Array([0, 1, 0, 0]),
  new Float32Array([0.5, 0.5, 0, 0]),
];

describe("VectorBlobStore", () => {
  it.effect("roundtrips vectors through the in-memory store using the core codec", () =>
    Effect.gen(function* () {
      const store = yield* VectorBlobStore;
      const vectors = makeVectors();

      const write = yield* store.putVectors(LOGIN, vectors);
      expect(write.key).toBe("vectors/coldter.bin");
      expect(write.count).toBe(3);
      expect(write.dims).toBe(4);
      expect(write.bytesLen).toBe(encodeVectors(vectors).byteLength);

      const loaded = yield* store.getVectors(LOGIN);
      expect(loaded).not.toBeNull();
      expect(loaded?.length).toBe(3);
      expect(Array.from(loaded?.[0] ?? [])).toEqual([1, 0, 0, 0]);
      expect(Array.from(loaded?.[2] ?? [])).toEqual([0.5, 0.5, 0, 0]);

      // The frozen core kNN consumes the decoded vectors directly.
      const entries = (loaded ?? []).map((vector, index) => ({ id: index + 1, vector }));
      expect(topK(new Float32Array([0, 1, 0, 0]), entries, 1)[0]?.id).toBe(2);
    }).pipe(Effect.provide(InMemoryVectorBlobStore.layer)),
  );

  it.effect("returns null for missing blobs and deletes idempotently", () =>
    Effect.gen(function* () {
      const store = yield* VectorBlobStore;

      expect(yield* store.getVectors("nobody")).toBeNull();
      yield* store.deleteVectors("nobody");

      yield* store.putVectors(LOGIN, makeVectors());
      expect(yield* store.getVectors(LOGIN)).not.toBeNull();
      yield* store.deleteVectors(LOGIN);
      expect(yield* store.getVectors(LOGIN)).toBeNull();
      yield* store.deleteVectors(LOGIN);
    }).pipe(Effect.provide(InMemoryVectorBlobStore.layer)),
  );

  it.effect("persists exactly the bytes produced by encodeVectors", () =>
    Effect.gen(function* () {
      const bucket = new InMemoryVectorBlobBucket();
      const store = new R2VectorBlobStore(bucket);
      const vectors = makeVectors();

      yield* store.putVectors(LOGIN, vectors);

      const object = yield* Effect.promise(() => bucket.get(vectorBlobKey(LOGIN)));

      if (object === null) {
        return yield* Effect.die("expected the vector blob to exist");
      }

      const bytes = new Uint8Array(yield* Effect.promise(() => object.arrayBuffer()));
      expect(bytes).toEqual(encodeVectors(vectors));
      expect(decodeVectors(bytes).length).toBe(vectors.length);
    }),
  );

  it.effect("decodes blobs written by the core codec", () =>
    Effect.gen(function* () {
      const bucket = new InMemoryVectorBlobBucket();
      const vectors = makeVectors();
      yield* Effect.promise(() => bucket.put(vectorBlobKey(LOGIN), encodeVectors(vectors)));

      const store = new R2VectorBlobStore(bucket);
      const loaded = yield* store.getVectors(LOGIN);
      expect(loaded?.map((vector) => Array.from(vector))).toEqual(
        vectors.map((vector) => Array.from(vector)),
      );

      yield* store.deleteVectors(LOGIN);
      expect(bucket.size).toBe(0);
    }),
  );

  it.effect("reports bucket failures as VectorStoreError", () =>
    Effect.gen(function* () {
      const failing = {
        get: () => Promise.reject(new Error("nope")),
        put: () => Promise.reject(new Error("nope")),
        delete: () => Promise.reject(new Error("nope")),
      };

      const store = new R2VectorBlobStore(failing);

      const error = yield* store.getVectors(LOGIN).pipe(Effect.flip);
      expect(error._tag).toBe("VectorStoreError");
      expect(error.operation).toBe("get");
      expect(error.key).toBe("vectors/coldter.bin");
    }),
  );
});
