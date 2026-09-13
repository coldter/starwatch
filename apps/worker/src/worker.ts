import type { Ai, D1Database, R2Bucket } from "@cloudflare/workers-types";
import { Embedder } from "@starwatch/core/sync";
import { R2VectorBlobStore, VectorBlobStore } from "@starwatch/cloudflare/storage";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Etag from "effect/unstable/http/Etag";
import * as HttpPlatform from "effect/unstable/http/HttpPlatform";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import { makeVectorBlobBucket, type RawR2Bucket } from "./adapters/vector-bucket.ts";
import { StarwatchApi } from "./api.ts";
import { SERVICE_VERSION } from "./constants.ts";
import { makeSyncDeps, SyncDeps } from "./deps.ts";
import { reposGroup } from "./handlers/repos.ts";
import { searchGroup } from "./handlers/search.ts";
import { systemGroup } from "./handlers/system.ts";
import type { WorkerDeps } from "./handlers/types.ts";
import { usersGroup } from "./handlers/users.ts";
import { Bucket, Database } from "./resources.ts";
import { StarListingWorkflow } from "./sync/listing-workflow.ts";

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
 *
 * Layers are intentionally **not built** in init: plan-time init has no
 * binding values, so each request/workflow run builds its own service graph
 * against the per-event `Scope`. The isolate pays only for the layers a route
 * actually uses.
 */
export default Cloudflare.Worker(
  "StarwatchWorker",
  {
    main: import.meta.url,
    assets: {
      directory: "../webui/dist",
      // API traffic always reaches the Worker; every other path falls through
      // to the SPA assets with an index.html fallback.
      runWorkerFirst: ["/api/*"],
      notFoundHandling: "single-page-application"
    },
    compatibility: {
      date: "2026-09-01",
      flags: ["nodejs_compat"]
    }
  },
  Effect.gen(function* () {
    // Yield the bindings to attach them to this Worker, then read the raw
    // runtime handles from `WorkerEnvironment` (the same env accessor the
    // binding layers use). Calling `.raw` here would require `RuntimeContext`,
    // which the init phase does not have.
    const database = yield* Database;
    const bucketResource = yield* Bucket;
    const env = yield* Cloudflare.Workers.WorkerEnvironment;
    yield* Cloudflare.D1.QueryDatabase(database);
    yield* Cloudflare.R2.ReadWriteBucket(bucketResource);
    yield* Cloudflare.Workers.AI("AI");
    const rawD1 = env[database.LogicalId] as D1Database;
    const rawBucket = env[bucketResource.LogicalId] as R2Bucket;
    const rawAi = env.AI as Ai;

    // Zero-permission fine-grained PAT (docs/09 §4.1); empty in local dev.
    const githubToken = yield* Config.redacted("GITHUB_TOKEN").pipe(
      Config.withDefault(Redacted.make(""))
    );

    // Per-IP burst filters (docs/14 §3.2); the global budgets remain a DO
    // follow-up, so these bindings are the first line of defence.
    const searchRate = yield* Cloudflare.RateLimit("SEARCH_RATE", {
      namespaceId: 1001,
      simple: { limit: 60, period: 60 }
    });
    const syncRate = yield* Cloudflare.RateLimit("SYNC_RATE", {
      namespaceId: 1002,
      simple: { limit: 5, period: 60 }
    });

    const rawR2 = rawBucket as unknown as RawR2Bucket;
    const vectorBucket = makeVectorBlobBucket(rawR2);
    const sync = makeSyncDeps({
      rawD1,
      rawBucket: rawR2,
      rawAi,
      githubToken: Redacted.value(githubToken),
      userAgent: `starwatch/${SERVICE_VERSION} (+https://starwatch.workers.dev)`
    });

    const searchLayer = Layer.mergeAll(
      sync.storage,
      Layer.succeed(Embedder, sync.embedder),
      Layer.succeed(VectorBlobStore, new R2VectorBlobStore(vectorBucket))
    );

    // Yielding the workflow class runs its init once per isolate and returns
    // the start/inspect handle used by `POST /api/users/:login/sync`.
    // `provideService` (not `provide`) avoids a Scope requirement in init.
    const listing = yield* StarListingWorkflow.pipe(Effect.provideService(SyncDeps, sync));

    const deps: WorkerDeps = {
      sync,
      searchLayer,
      vectorFiles: sync.vectorFiles,
      searchRate,
      syncRate,
      listing
    };

    return {
      fetch: yield* HttpRouter.toHttpEffect(
        HttpApiBuilder.layer(StarwatchApi).pipe(
          Layer.provide(
            Layer.mergeAll(systemGroup(deps), usersGroup(deps), searchGroup(deps), reposGroup(deps))
          ),
          Layer.provide([Etag.layer, HttpPlatformStub, Path.layer])
        )
      )
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Cloudflare.D1.QueryDatabaseBinding,
        Cloudflare.R2.ReadWriteBucketBinding,
        Cloudflare.Workers.AIBinding,
        Cloudflare.Workers.RateLimitBinding
      )
    )
  )
);
