import type { Ai, D1Database } from "@cloudflare/workers-types";
import { D1Client } from "@effect/sql-d1";
import {
  makeWorkersAiEmbedder,
  WorkersAiTextEmbedding,
  type WorkersAiBinding,
} from "@starwatch/cloudflare/ai";
import { makeGithubClient } from "@starwatch/cloudflare/github";
import { camelize, RepoStore, UserFts } from "@starwatch/cloudflare/storage";
import { Embedder, GithubClient, type EmbedderService } from "@starwatch/core/sync";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import {
  layerVectorBlobFiles,
  type RawR2Bucket,
  type VectorBlobFiles,
} from "./adapters/vector-bucket.ts";

/**
 * Everything a sync workflow needs, resolved once per Worker isolate in the
 * init phase and passed into each workflow class through the {@link SyncDeps}
 * service.
 *
 * Layers are kept as **values** (not built contexts): the Worker init phase
 * runs at plan time in Node with an empty binding environment, so building
 * the D1/HTTP layers must wait until a request or workflow run — each of
 * which carries a fresh `Scope` for the per-run service graph.
 */

export interface SyncDepsService {
  /** `RepoStore` + `UserFts` wired to the D1 `SqlClient` (`camelize` rows). */
  readonly storage: Layer.Layer<RepoStore | UserFts>;
  /** GitHub REST/GraphQL client over the Workers global `fetch`. */
  readonly github: Layer.Layer<GithubClient>;
  /** Workers AI embedder (`bge-small-en-v1.5`, 384d). */
  readonly embedder: EmbedderService;
  /** One layer to provide to a workflow run body. */
  readonly runLayers: Layer.Layer<RepoStore | UserFts | GithubClient | Embedder | VectorBlobFiles>;
}

export class SyncDeps extends Context.Service<SyncDeps, SyncDepsService>()("starwatch/SyncDeps") {}

export interface SyncDepsOptions {
  readonly rawD1: D1Database;
  readonly rawBucket: RawR2Bucket;
  readonly rawAi: Ai | undefined;
  /** Fine-grained PAT with no permissions; empty string = anonymous (dev). */
  readonly githubToken: string;
  readonly userAgent: string;
}

/**
 * Adapt the raw Workers AI binding to the embedder's minimal `run` contract,
 * decoding the model envelope with the schema that owns its shape.
 *
 * `raw` is `undefined` during the Alchemy **plan phase** (Node, no bindings),
 * so the run function is resolved lazily and only rejects if it is actually
 * used before isolate boot provides a real `env.AI`.
 */
const toWorkersAiBinding = (raw: Ai | undefined): WorkersAiBinding => ({
  run: async (model, input) => {
    if (raw === undefined) {
      return Promise.reject(
        new Error("Workers AI binding unavailable (plan-time construction or missing AI binding)"),
      );
    }

    const result = await raw.run(model, input);

    return Schema.decodeUnknownSync(WorkersAiTextEmbedding)(result);
  },
});

/**
 * Build the sync dependency values for one isolate.
 *
 * Kept as a **value factory** (not a buildable `Layer`): the Worker init phase
 * runs at plan time in Node with an empty binding environment, so building the
 * D1/HTTP layers must wait until a request or workflow run — each of which
 * carries a fresh `Scope` for the per-run service graph.
 */
export const syncDepsFrom = (options: SyncDepsOptions): SyncDepsService => {
  const sql = D1Client.layer({
    db: options.rawD1,
    // The storage layer expects post-transform camelCase keys (docs/08 §sql).
    transformResultNames: camelize,
  }).pipe(Layer.orDie);

  const storage = Layer.mergeAll(RepoStore.layer, UserFts.layer).pipe(Layer.provide(sql));

  const github = makeGithubClient({
    token: options.githubToken,
    userAgent: options.userAgent,
  }).pipe(Layer.provide(FetchHttpClient.layer));

  const embedder = makeWorkersAiEmbedder(toWorkersAiBinding(options.rawAi));

  return {
    storage,
    github,
    embedder,
    runLayers: Layer.mergeAll(
      storage,
      github,
      Layer.succeed(Embedder, embedder),
      layerVectorBlobFiles(options.rawBucket),
    ),
  };
};

/** Exported for tests / tools that only want the AI adapter surface. */
export { toWorkersAiBinding };
