import { decodeVectors, encodeVectors } from "@starwatch/core/search";
import { Context, Effect, Layer, Schema } from "effect";

/**
 * Vector blob storage (docs/15 §2.3). One immutable blob per user at
 * `vectors/{login}.bin`; D1 only ever holds the pointer row
 * (`RepoStore.putVectorBlob`). The layout is owned by `@starwatch/core/search`
 * (`encodeVectors` / `decodeVectors`), so this module stays a thin transport.
 *
 * The bucket is typed with the minimal promise shape R2 already satisfies, so
 * production passes `env.BUCKET` and tests pass `InMemoryVectorBlobBucket`.
 */

export const VectorBlobStoreError = Schema.Literals(["get", "put", "delete", "encode", "decode"]);
export type VectorBlobStoreError = typeof VectorBlobStoreError.Type;

export class VectorStoreError extends Schema.TaggedError<VectorStoreError>()("VectorStoreError", {
  operation: VectorBlobStoreError,
  key: Schema.String,
  cause: Schema.Defect()
}) {}

/** Minimal structural view of an R2 object body. */
export interface VectorBlobObject {
  arrayBuffer(): Promise<ArrayBuffer>;
}

/** Minimal structural view of an R2 bucket binding. */
export interface VectorBlobBucket {
  get(key: string): Promise<VectorBlobObject | null>;
  put(key: string, value: Uint8Array): Promise<unknown>;
  delete(key: string): Promise<unknown>;
}

/** R2 key for a user's packed vector blob. */
export const vectorBlobKey = (login: string): string => `vectors/${login}.bin`;

/** What `putVectors` wrote; feed `dims`/`bytesLen` to `RepoStore.putVectorBlob`. */
export interface VectorBlobWrite {
  readonly key: string;
  readonly count: number;
  readonly dims: number;
  readonly bytesLen: number;
}

export interface VectorBlobStoreShape {
  readonly putVectors: (
    login: string,
    vectors: ReadonlyArray<Float32Array>
  ) => Effect.Effect<VectorBlobWrite, VectorStoreError>;
  /** `null` when no blob exists; vectors are returned in stored order. */
  readonly getVectors: (login: string) => Effect.Effect<ReadonlyArray<Float32Array> | null, VectorStoreError>;
  readonly deleteVectors: (login: string) => Effect.Effect<void, VectorStoreError>;
}

export class VectorBlobStore extends Context.Service<VectorBlobStore, VectorBlobStoreShape>()("VectorBlobStore") {}

const tryPromise = <A>(
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

/** Effect wrapper over a promise-based bucket (`env.BUCKET` in production). */
export class R2VectorBlobStore implements VectorBlobStoreShape {
  // Plain field + assignment instead of a parameter property: Node's
  // strip-only TypeScript loader (used by `apps/worker` local dev) cannot
  // parse parameter properties.
  readonly bucket: VectorBlobBucket;

  constructor(bucket: VectorBlobBucket) {
    this.bucket = bucket;
  }

  readonly putVectors = (login: string, vectors: ReadonlyArray<Float32Array>) => {
    const key = vectorBlobKey(login);
    const bucket = this.bucket;
    return Effect.gen(function* () {
      const bytes = yield* trySync("encode", key, () => encodeVectors(vectors));
      yield* tryPromise("put", key, () => bucket.put(key, bytes));
      return {
        key,
        count: vectors.length,
        dims: vectors[0]?.length ?? 0,
        bytesLen: bytes.byteLength
      } satisfies VectorBlobWrite;
    });
  };

  readonly getVectors = (login: string) => {
    const key = vectorBlobKey(login);
    const bucket = this.bucket;
    return Effect.gen(function* () {
      const object = yield* tryPromise("get", key, () => bucket.get(key));
      if (object === null) {
        return null;
      }
      const buffer = yield* tryPromise("get", key, () => object.arrayBuffer());
      return yield* trySync("decode", key, () => decodeVectors(new Uint8Array(buffer)));
    });
  };

  readonly deleteVectors = (login: string) => {
    const key = vectorBlobKey(login);
    const bucket = this.bucket;
    return Effect.gen(function* () {
      yield* tryPromise("delete", key, () => bucket.delete(key));
    });
  };
}

/** Layer over a promise-based bucket (production passes the R2 binding). */
export const r2VectorBlobStoreLayer = (bucket: VectorBlobBucket): Layer.Layer<VectorBlobStore> =>
  Layer.succeed(VectorBlobStore, new R2VectorBlobStore(bucket));

/** Map-backed bucket; tests only. */
export class InMemoryVectorBlobBucket implements VectorBlobBucket {
  private readonly objects = new Map<string, Uint8Array>();

  get size(): number {
    return this.objects.size;
  }

  async get(key: string): Promise<VectorBlobObject | null> {
    const value = this.objects.get(key);
    if (value === undefined) {
      return null;
    }
    const copy = value.slice();
    return { arrayBuffer: async () => copy.buffer };
  }

  async put(key: string, value: Uint8Array): Promise<unknown> {
    return this.objects.set(key, value.slice());
  }

  async delete(key: string): Promise<unknown> {
    return this.objects.delete(key);
  }
}

/** In-memory store; tests use this instead of R2. */
export class InMemoryVectorBlobStore extends R2VectorBlobStore {
  constructor() {
    super(new InMemoryVectorBlobBucket());
  }

  static readonly layer: Layer.Layer<VectorBlobStore> = Layer.sync(
    VectorBlobStore,
    () => new InMemoryVectorBlobStore()
  );
}
