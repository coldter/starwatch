import { SEMANTIC_WINDOW } from "@starwatch/domain";
import { encodeVectors } from "@starwatch/core/search";
import {
  Embedder,
  GithubClient,
  hashReadme,
  planEmbedWork,
  planReadmeWork,
  type ReadmeStateMap
} from "@starwatch/core/sync";
import { repoEmbeddingText } from "@starwatch/cloudflare/ai";
import { README_MAX_CHARS, RepoStore, UserFts } from "@starwatch/cloudflare/storage";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { SyncDeps } from "../deps.ts";
import { MERGE_FAN_IN, README_FETCH_BATCH } from "../constants.ts";
import { describeGithubError, nowIso, patchState } from "./state.ts";
import {
  decodeVectors,
  VectorBlobFiles,
  vectorIdsKey,
  vectorBlobBinKey,
  vectorMergeBaseKey,
  vectorPartBaseKey
} from "../adapters/vector-bucket.ts";

/**
 * Tier 1 (semantic) refresh: fetch changed READMEs for the newest
 * `SEMANTIC_WINDOW` repos, embed the dirty subset, and rewrite the per-user
 * R2 vector blob (docs/15 §2).
 *
 * Free-tier step math (per invocation, docs/13 §1):
 *   * external subrequests ≤ 50 → README_FETCH_BATCH (8) × 6 worst-case raw
 *     probes/REST fallback = 48. D1 and R2 calls are Cloudflare-service
 *     subrequests, budgeted separately.
 *   * D1 queries ≤ 50 → per 8-repo batch: 1 `getRepos` + 1 `getReadmeTexts`
 *     + 8 `putReadme` + ≤6 FTS upsert statements ≈ 16.
 *   * AI: one `embed` call per non-empty batch (≤32 texts, one subrequest).
 *   * R2: 2 puts per batch (part `.bin` + `.ids.json`).
 *
 * Step count for a full 1,500-repo window: 1 plan + 188 README batches
 * (1,500 ÷ 8) + ≤5 fan-in merges + 1 finalize ≈ 195, inside the 1,024-step
 * free per-instance cap.
 */

export interface StarRefreshInput {
  readonly login: string;
}

/** What one tier-1 refresh run reports back (workflow instance output). */
export interface StarRefreshResult {
  readonly ok: boolean;
  readonly semanticDocs: number;
  readonly embedded: number;
}

const chunk = <A>(items: ReadonlyArray<A>, size: number): ReadonlyArray<ReadonlyArray<A>> => {
  const out: Array<ReadonlyArray<A>> = [];

  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));

  return out;
};

interface BatchOutcome {
  readonly ok: boolean;
  /** Base key of the written part, or `null` when nothing was embedded. */
  readonly partBase: string | null;
  readonly embedded: number;
  readonly error: string | null;
}

interface FinalizeOutcome {
  readonly ok: boolean;
  readonly semanticDocs: number;
  readonly embedded: number;
  readonly error: string | null;
}

const decodePart = (bytes: Uint8Array): Effect.Effect<ReadonlyArray<Float32Array>, never> =>
  Effect.try({
    try: () => decodeVectors(bytes),
    catch: (cause) => cause
  }).pipe(Effect.orDie);

const readPart = (
  base: string
): Effect.Effect<
  { readonly ids: ReadonlyArray<number>; readonly vectors: ReadonlyArray<Float32Array> } | null,
  never,
  VectorBlobFiles
> =>
  Effect.gen(function* () {
    const vectorFiles = yield* VectorBlobFiles;
    const bytes = yield* vectorFiles.getBytes(`${base}.bin`).pipe(Effect.orDie);
    const ids = yield* vectorFiles.getIds(`${base}.ids.json`).pipe(Effect.orDie);

    if (bytes === null || ids === null) return null;
    const vectors = yield* decodePart(bytes);

    if (vectors.length !== ids.length) return null;

    return { ids, vectors };
  });

/** Merge N part bases into one intermediate base (one of ≤MERGE_FAN_IN). */
const mergeParts = (
  login: string,
  round: number,
  index: number,
  bases: ReadonlyArray<string>
): Effect.Effect<string, never, VectorBlobFiles> =>
  Effect.gen(function* () {
    const vectorFiles = yield* VectorBlobFiles;
    const vectors: Float32Array[] = [];
    const ids: number[] = [];

    for (const base of bases) {
      const part = yield* readPart(base);

      if (part === null) continue;
      vectors.push(...part.vectors);
      ids.push(...part.ids);
    }

    const out = vectorMergeBaseKey(login, round, index);
    yield* vectorFiles.putPart(out, vectors, ids).pipe(Effect.orDie);

    return out;
  });

/**
 * Mark the user's state as failed without masking the underlying error. Used
 * at the workflow boundary, where every failure mode (typed or defect) must
 * still surface to the UI as a state change.
 */
const markFailed = (login: string, message: string): Effect.Effect<void, never, RepoStore> =>
  patchState(login, { phase: "failed", lastError: message });

const refreshBody = Effect.fn("StarRefreshWorkflow.body")(function* (input: StarRefreshInput) {
  const login = input.login;
  const repos = yield* RepoStore;
  const fts = yield* UserFts;
  const github = yield* GithubClient;
  const embedder = yield* Embedder;
  const vectorFiles = yield* VectorBlobFiles;

  // ---- plan: which READMEs are dirty, and the semantic window -----------
  const plan = yield* Cloudflare.Workflows.task(
    "plan",
    Effect.gen(function* () {
      const all = yield* repos.listReposForSearch(login, {}).pipe(Effect.orDie);
      const states: ReadmeStateMap = yield* repos.getReadmeStates(login).pipe(Effect.orDie);
      const batches = planReadmeWork(all, states, { batchSize: README_FETCH_BATCH });
      const windowIds = all.slice(0, SEMANTIC_WINDOW).map((repo) => repo.id);

      return { batches, windowIds };
    }),
    { retries: { limit: 2, delay: "5 seconds" } }
  );

  // ---- per-batch README fetch + embed + part write ----------------------
  const partBases: string[] = [];
  let embeddedTotal = 0;

  for (let index = 0; index < plan.batches.length; index++) {
    const ids = plan.batches[index] ?? [];

    const outcome = yield* Cloudflare.Workflows.task(
      `readme-batch-${index}`,
      Effect.gen(function* () {
        const repoRows = yield* repos.getRepos(login, ids).pipe(Effect.orDie);
        const repoById = new Map(repoRows.map((repo) => [repo.id, repo] as const));
        const previousTexts = yield* repos.getReadmeTexts(login, ids).pipe(Effect.orDie);
        const existingHashes = new Map<number, string>();

        for (const [id, text] of previousTexts) existingHashes.set(id, hashReadme(text));

        const newTexts = new Map<number, string>();

        for (const id of ids) {
          const repo = repoById.get(id);

          if (repo === undefined) continue;

          // `Repo` carries no default branch (schema freeze), so probe the
          // forgiving `HEAD` ref; the README client tries the raw variants
          // then the one-request REST fallback (docs/09 §3.3).
          const fetched = yield* github.getReadme(repo.fullName, "HEAD").pipe(
            Effect.matchEffect({
              onSuccess: (value) => Effect.succeed({ ok: true as const, value }),
              onFailure: (error) => Effect.succeed({ ok: false as const, message: describeGithubError(error) })
            })
          );

          if (!fetched.ok) {
            return {
              ok: false,
              partBase: null,
              embedded: 0,
              error: fetched.message
            } satisfies BatchOutcome;
          }

          const readme = fetched.value;

          if (readme === null) {
            yield* repos
              .putReadme(id, { text: null, hash: null, state: "missing", checkedAt: nowIso() })
              .pipe(Effect.orDie);
            newTexts.set(id, "");
          } else {
            const text =
              readme.text.length > README_MAX_CHARS ? readme.text.slice(0, README_MAX_CHARS) : readme.text;

            yield* repos
              .putReadme(id, { text, hash: hashReadme(text), state: "present", checkedAt: nowIso() })
              .pipe(Effect.orDie);
            newTexts.set(id, text);
          }
        }

        // Keep lexical search fresh with the fetched README text.
        const docs = ids.flatMap((id) => {
          const repo = repoById.get(id);

          return repo === undefined
            ? []
            : [
                {
                  repoId: repo.id,
                  fullName: repo.fullName,
                  description: repo.description,
                  topics: repo.topics,
                  readme: newTexts.get(id) ?? ""
                }
              ];
        });

        yield* fts.upsertUserDocs(login, docs).pipe(Effect.orDie);

        // Semantic work is content-hash driven (docs/15 §2.1): only docs
        // whose distilled text changed are re-embedded.
        const dirty = planEmbedWork(repoRows, newTexts, existingHashes);

        if (dirty.length === 0) {
          return { ok: true, partBase: null, embedded: 0, error: null } satisfies BatchOutcome;
        }

        const texts = dirty.flatMap((id) => {
          const repo = repoById.get(id);

          return repo === undefined ? [] : [repoEmbeddingText(repo, newTexts.get(id) ?? "")];
        });

        const vectors = yield* embedder.embed(texts);

        const partBase = vectorPartBaseKey(login, index);
        yield* vectorFiles.putPart(partBase, vectors, dirty).pipe(Effect.orDie);

        return { ok: true, partBase, embedded: dirty.length, error: null } satisfies BatchOutcome;
      }).pipe(
        // A failed batch must surface as a state, never fail the run
        // silently: embedding errors degrade, README errors pause.
        Effect.matchEffect({
          onSuccess: (value) => Effect.succeed(value),
          onFailure: (error) =>
            Effect.succeed({
              ok: false,
              partBase: null,
              embedded: 0,
              error: String(error)
            } satisfies BatchOutcome)
        })
      )
    );

    embeddedTotal += outcome.embedded;

    if (!outcome.ok) {
      yield* markFailed(login, outcome.error ?? "README batch failed");

      return { ok: false, semanticDocs: 0, embedded: embeddedTotal } satisfies StarRefreshResult;
    }

    if (outcome.partBase !== null) partBases.push(outcome.partBase);
  }

  // ---- fan-in merge: keep every merge step under the subrequest cap ----
  const intermediateBases: string[] = [];
  let current = partBases;
  let round = 1;

  while (current.length > MERGE_FAN_IN) {
    const groups = chunk(current, MERGE_FAN_IN);
    const next: string[] = [];

    for (let index = 0; index < groups.length; index++) {
      const merged = yield* Cloudflare.Workflows.task(
        `merge-${round}-${index}`,
        mergeParts(login, round, index, groups[index] ?? [])
      );

      next.push(merged);
    }

    intermediateBases.push(...next);
    current = next;
    round += 1;
  }

  // The final level holds every new vector exactly once: the part bases when
  // no merge ran, otherwise the last merge-intermediate set.
  const sourceBases = current;

  // ---- finalize: overlay existing + new vectors, write the canonical blob
  const finalize = yield* Cloudflare.Workflows.task(
    "finalize",
    Effect.gen(function* () {
      const previous = yield* repos.getIndexState(login).pipe(Effect.orDie);
      const windowSet = new Set(plan.windowIds);

      // Overlay: keep earlier vectors for unchanged window repos, replace
      // with fresh part vectors, drop anything outside the current window.
      const overlay = new Map<number, Float32Array>();
      const existingBytes = yield* vectorFiles.getBytes(vectorBlobBinKey(login)).pipe(Effect.orDie);
      const existingIds = yield* vectorFiles.getIds(vectorIdsKey(login)).pipe(Effect.orDie);

      if (existingBytes !== null && existingIds !== null) {
        const decoded = yield* decodePart(existingBytes);

        if (decoded.length === existingIds.length) {
          for (let i = 0; i < existingIds.length; i++) {
            const id = existingIds[i];
            const vector = decoded[i];

            if (id !== undefined && vector !== undefined && windowSet.has(id)) overlay.set(id, vector);
          }
        }
      }

      // Final-level bases only; the fan-in merge already collapsed every
      // part exactly once, so this reads ≤MERGE_FAN_IN objects.
      for (const base of sourceBases) {
        const part = yield* readPart(base);

        if (part === null) continue;

        for (let i = 0; i < part.ids.length; i++) {
          const id = part.ids[i];
          const vector = part.vectors[i];

          if (id !== undefined && vector !== undefined && windowSet.has(id)) overlay.set(id, vector);
        }
      }

      const ids = [...overlay.keys()];
      const vectors = ids.map((id) => overlay.get(id)!);
      let semanticDocs = previous?.semanticDocs ?? 0;

      // Rewrite only when there is new material or the existing blob no
      // longer matches the current window set (unstars / window shrink).
      const upToDate =
        existingIds !== null &&
        existingIds.length === ids.length &&
        existingIds.every((id) => overlay.has(id));

      if (sourceBases.length > 0 || !upToDate) {
        if (vectors.length > 0) {
          const bytes = yield* Effect.try({
            try: () => encodeVectors(vectors),
            catch: (cause) => cause
          }).pipe(Effect.orDie);

          yield* vectorFiles.putBytes(vectorBlobBinKey(login), bytes).pipe(Effect.orDie);
          yield* vectorFiles.putIds(vectorIdsKey(login), ids).pipe(Effect.orDie);
          const dims = vectors[0]?.length ?? 0;

          if (dims > 0) {
            yield* repos.putVectorBlob(login, dims, bytes.byteLength).pipe(Effect.orDie);
          }

          semanticDocs = vectors.length;
        }
      }

      const stats = yield* repos.countStats(login).pipe(Effect.orDie);
      yield* repos
        .upsertIndexState({
          login,
          phase: "ready",
          starsTotal: stats.starsTotal,
          reposMetadata: stats.reposMetadata,
          readmesFetched: stats.readmesFetched,
          semanticDocs,
          lastSyncedAt: previous?.lastSyncedAt ?? null,
          lastError: null,
          updatedAt: nowIso()
        })
        .pipe(Effect.orDie);

      // One R2 delete call for every scratch object (parts + intermediates).
      const scratch = [...partBases, ...intermediateBases].flatMap((base) => [
        `${base}.bin`,
        `${base}.ids.json`
      ]);

      yield* vectorFiles.deleteMany(scratch).pipe(Effect.orDie);

      return { ok: true, semanticDocs, embedded: embeddedTotal, error: null } satisfies FinalizeOutcome;
    }),
    { retries: { limit: 3, delay: "5 seconds" } }
  );

  return { ok: finalize.ok, semanticDocs: finalize.semanticDocs, embedded: finalize.embedded } satisfies StarRefreshResult;
});

export class StarRefreshWorkflow extends Cloudflare.Workflow<StarRefreshWorkflow>()(
  "StarRefreshWorkflow",
  // Free per-instance cap is 1,024 steps; observed worst case ≈ 195.
  { limits: { steps: 1_000 } },
  Effect.gen(function* () {
    const deps = yield* SyncDeps;

    return Effect.fn(function* (input: StarRefreshInput) {
      const exit = yield* Effect.exit(refreshBody(input).pipe(Effect.provide(deps.runLayers)));

      if (Exit.isSuccess(exit)) return exit.value;
      yield* markFailed(input.login, "semantic refresh failed").pipe(
        Effect.provide(deps.runLayers),
        Effect.ignore
      );

      return { ok: false, semanticDocs: 0, embedded: 0 } satisfies StarRefreshResult;
    });
  })
) {}

/** Pure step-count budget helper (documented math, exported for tests). */
export const refreshStepBudget = (repoCount: number): number => {
  const batches = Math.ceil(repoCount / README_FETCH_BATCH);
  const mergePasses = batches > MERGE_FAN_IN ? Math.ceil(batches / MERGE_FAN_IN) : 0;

  return 1 + batches + mergePasses + 1;
};
