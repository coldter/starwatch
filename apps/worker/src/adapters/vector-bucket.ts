import { decodeVectors, encodeVectors } from "@starwatch/core/search";
import {
  VectorStoreError,
  type VectorBlobBucket,
  type VectorBlobObject,
  type VectorBlobStoreError
} from "@starwatch/cloudflare/storage";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

/**
 * R2 adapter for the free-tier vector store (docs/15 §2.3).
 *
 * `VectorBlobStore` (in `@starwatch/cloudflare/storage`) is deliberately typed
 * against a minimal **promise** bucket (`get`/`put`/`delete`) so production
 * passes the raw R2 binding and tests pass an in-memory map. This module is
 * that adapter plus the key layout around it:
 *
 *   vectors/{login}.bin            canonical packed blob (core codec)
 *   vectors/{login}.ids.json       repo ids in vector order (sidecar)
 *   vectors/{login}/part-N.bin     per-batch vectors during a refresh run
 *   vectors/{login}/part-N.ids.json
 *   vectors/{login}/merge-R-I.*    fan-in merge intermediates
 *
 * The sidecar exists because the blob layout carries only `count`/`dims`; the
 * search path needs ids to map vectors back to repos.
 */

/** Structural view of the runtime `env.BUCKET` binding we depend on. */
export interface RawR2Bucket {
  get(key: string): Promise<RawR2Object | null>;
  put(key: string, value: Uint8Array): Promise<void>;
  delete(keys: string | string[]): Promise<void>;
}

export interface RawR2Object {
  arrayBuffer(): Promise<ArrayBuffer>;
}

/** Promise-flavored bucket for `R2VectorBlobStore` / `InMemoryVectorBlobStore`. */
export const toVectorBlobBucket = (bucket: RawR2Bucket): VectorBlobBucket => ({
  get: (key: string): Promise<VectorBlobObject | null> => bucket.get(key),
  put: (key: string, value: Uint8Array): Promise<void> => bucket.put(key, value),
  delete: (key: string): Promise<void> => bucket.delete(key)
});

/** Canonical packed blob written by the refresh workflow. */
export const vectorBlobBinKey = (login: string): string => `vectors/${login}.bin`;

/** Repo ids in vector order, parallel to {@link vectorBlobBinKey}. */
export const vectorIdsKey = (login: string): string => `vectors/${login}.ids.json`;

/** Base key of one refresh batch part (`…bin` / `…ids.json` suffixes). */
export const vectorPartBaseKey = (login: string, index: number): string => `vectors/${login}/part-${index}`;

/** Base key of one fan-in merge intermediate. */
export const vectorMergeBaseKey = (login: string, round: number, index: number): string =>
  `vectors/${login}/merge-${round}-${index}`;

const BIN_SUFFIX = ".bin";

const IDS_SUFFIX = ".ids.json";

const decoder = new TextDecoder();

const encoder = new TextEncoder();

const tryBucket = <A>(
  operation: VectorBlobStoreError,
  key: string,
  run: () => Promise<A>
): Effect.Effect<A, VectorStoreError> =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new VectorStoreError({ operation, key, cause })
  });

const trySync = <A>(
  operation: VectorBlobStoreError,
  key: string,
  run: () => A
): Effect.Effect<A, VectorStoreError> =>
  Effect.try({
    try: run,
    catch: (cause) => new VectorStoreError({ operation, key, cause })
  });

export interface VectorBlobFilesService {
  readonly getBytes: (key: string) => Effect.Effect<Uint8Array | null, VectorStoreError>;
  readonly putBytes: (key: string, bytes: Uint8Array) => Effect.Effect<void, VectorStoreError>;
  readonly getIds: (key: string) => Effect.Effect<ReadonlyArray<number> | null, VectorStoreError>;
  readonly putIds: (key: string, ids: ReadonlyArray<number>) => Effect.Effect<void, VectorStoreError>;
  /** Writes `{base}.bin` + `{base}.ids.json` in two R2 puts. */
  readonly putPart: (
    base: string,
    vectors: ReadonlyArray<Float32Array>,
    ids: ReadonlyArray<number>
  ) => Effect.Effect<void, VectorStoreError>;
  /** Best-effort cleanup (`delete` accepts an array: one R2 call). */
  readonly deleteMany: (keys: ReadonlyArray<string>) => Effect.Effect<void, VectorStoreError>;
}

/**
 * Contextual service for the sidecar/part files, so workflow and search
 * bodies `yield* VectorBlobFiles` instead of threading a bucket adapter
 * through their parameters. Provided by {@link layerVectorBlobFiles}.
 */
export class VectorBlobFiles extends Context.Service<VectorBlobFiles, VectorBlobFilesService>()(
  "@starwatch/VectorBlobFiles"
) {}

/** Sidecar encoding written by `putIds` (`vectors/{login}.ids.json`). */
const VectorIdsJson = Schema.fromJsonString(Schema.Array(Schema.Number));

/** Effect-native file operations over the same promise bucket. */
const makeVectorBlobFiles = (bucket: RawR2Bucket): VectorBlobFilesService => {
  const getBytes = (key: string) =>
    Effect.gen(function* () {
      const object = yield* tryBucket("get", key, () => bucket.get(key));

      if (object === null) return null;
      const buffer = yield* tryBucket("get", key, () => object.arrayBuffer());

      return new Uint8Array(buffer);
    });

  const putBytes = (key: string, bytes: Uint8Array) =>
    tryBucket("put", key, () => bucket.put(key, bytes)).pipe(Effect.asVoid);

  const getIds = (key: string) =>
    Effect.gen(function* () {
      const bytes = yield* getBytes(key);

      if (bytes === null) return null;

      return yield* trySync("decode", key, () =>
        Schema.decodeUnknownSync(VectorIdsJson)(decoder.decode(bytes))
      );
    });

  const putIds = (key: string, ids: ReadonlyArray<number>) =>
    putBytes(key, encoder.encode(JSON.stringify(ids)));

  const putPart = (base: string, vectors: ReadonlyArray<Float32Array>, ids: ReadonlyArray<number>) =>
    Effect.gen(function* () {
      const bytes = yield* trySync("encode", `${base}${BIN_SUFFIX}`, () => encodeVectors(vectors));
      yield* putBytes(`${base}${BIN_SUFFIX}`, bytes);
      yield* putIds(`${base}${IDS_SUFFIX}`, ids);
    });

  const deleteMany = (keys: ReadonlyArray<string>) => {
    if (keys.length === 0) return Effect.void;

    return tryBucket("delete", keys[0] ?? "vectors", () => bucket.delete([...keys])).pipe(Effect.asVoid);
  };

  return { getBytes, putBytes, getIds, putIds, putPart, deleteMany };
};

/** Provides {@link VectorBlobFiles} over the promise-shaped R2 bucket. */
export const layerVectorBlobFiles = (bucket: RawR2Bucket): Layer.Layer<VectorBlobFiles> =>
  Layer.succeed(VectorBlobFiles, makeVectorBlobFiles(bucket));

export { decodeVectors, encodeVectors };
