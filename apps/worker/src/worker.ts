import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Etag from "effect/unstable/http/Etag";
import * as HttpPlatform from "effect/unstable/http/HttpPlatform";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import { StarwatchApi } from "./api.ts";
import { Bucket, Database, Embeddings } from "./resources.ts";

/**
 * `HttpApiBuilder` needs an `HttpPlatform` service at construction time. The
 * real `HttpPlatform.layer` requires a FileSystem, which doesn't exist on
 * Workers. Our API never serves files, so a stub is the Worker-correct wiring.
 */
const HttpPlatformStub = Layer.succeed(HttpPlatform.HttpPlatform, {
  platform: "web",
  compression: {
    algorithms: new Set<HttpPlatform.CompressionAlgorithm>(["gzip"]),
    compressResponse: (response) => Effect.succeed(response)
  },
  fileResponse: () =>
    Effect.die("HttpPlatform.fileResponse is not supported on Workers"),
  fileWebResponse: () =>
    Effect.die("HttpPlatform.fileWebResponse is not supported on Workers")
});

/**
 * `Cloudflare.Worker(id, props, initEffect)`:
 * - the Effect is the **Init phase** (runs at plan time and on every isolate boot);
 * - bindings are yielded there, and the typed clients are closed over by handlers;
 * - `fetch` is an `HttpEffect`, built once per isolate via `HttpRouter.toHttpEffect`.
 */
export default Cloudflare.Worker(
  "StarwatchWorker",
  { main: import.meta.url },
  Effect.gen(function* () {
    const db = yield* Cloudflare.D1.QueryDatabase(Database);
    const bucket = yield* Cloudflare.R2.ReadWriteBucket(Bucket);
    const index = yield* Cloudflare.Vectorize.SearchIndex(Embeddings);

    const systemGroup = HttpApiBuilder.group(
      StarwatchApi,
      "system",
      (handlers) =>
        handlers
          .handle("health", () =>
            Effect.succeed({
              ok: true,
              service: "starwatch",
              version: "0.0.0"
            })
          )
          .handle("dbTime", () =>
            Effect.gen(function* () {
              const row = yield* db
                .prepare("SELECT datetime('now') AS now")
                .first<{ now: string }>();
              return { now: row?.now ?? "" };
            }).pipe(Effect.orDie)
          )
          .handle("vectorInfo", () =>
            index.describe().pipe(
              Effect.map((info) => ({
                vectorCount: info.vectorCount,
                dimensions: info.dimensions
              })),
              Effect.orDie
            )
          )
          .handle("bucketProbe", () =>
            bucket.head("__probe__").pipe(
              Effect.map((object) => ({ found: object !== null })),
              Effect.orDie
            )
          )
    );

    return {
      fetch: yield* HttpRouter.toHttpEffect(
        HttpApiBuilder.layer(StarwatchApi).pipe(
          Layer.provide(systemGroup),
          Layer.provide([Etag.layer, HttpPlatformStub, Path.layer])
        )
      )
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Cloudflare.D1.QueryDatabaseBinding,
        Cloudflare.R2.ReadWriteBucketBinding,
        Cloudflare.Vectorize.SearchIndexBinding
      )
    )
  )
);
