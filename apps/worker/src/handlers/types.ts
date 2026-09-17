import type { Embedder } from "@starwatch/core/sync";
import type { RepoStore, UserFts, VectorBlobStore } from "@starwatch/cloudflare/storage";
import type * as Cloudflare from "alchemy/Cloudflare";
import type * as Layer from "effect/Layer";
import type { SyncDepsService } from "../deps.ts";
import type { VectorBlobFiles } from "../adapters/vector-bucket.ts";
import type { StarListingInput } from "../sync/listing-workflow.ts";

/**
 * Services resolved in the Worker init phase and closed over by every handler
 * group. Layers stay unbuilt values so plan-time init never touches bindings.
 */
export interface WorkerDeps {
  /** Sync-side service graph (D1 storage + GitHub + embedder). */
  readonly sync: SyncDepsService;
  /** Search-side graph: storage + embedder + per-user R2 vector blob and id sidecar. */
  readonly searchLayer: Layer.Layer<
    RepoStore | UserFts | Embedder | VectorBlobStore | VectorBlobFiles
  >;
  /** Per-IP burst limiter on `/api/users/:login/search` (60/60s). */
  readonly searchRate: Cloudflare.RateLimitClient;
  /** Per-IP burst limiter on `POST /api/users/:login/sync` (5/60s). */
  readonly syncRate: Cloudflare.RateLimitClient;
  /** Per-IP burst limiter on the public-Lists refresh (12/60s). */
  readonly listsRate: Cloudflare.RateLimitClient;
  /** Tier 0 workflow handle (started by `POST /sync`). */
  readonly listing: Cloudflare.WorkflowHandle<StarListingInput, unknown>;
  /** Tier 1 workflow handle, for liveness checks on `fetching-readmes`/`embedding`. */
  readonly refresh: Cloudflare.WorkflowHandle<{ readonly login: string }, unknown>;
}
