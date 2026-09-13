import type { SearchFilters, SearchHit, SearchMode, SearchResponse } from "@starwatch/domain";
import {
  buildMatchExpression,
  chooseMatchStrategy,
  classifyQuery,
  computeNameStats,
  evidenceTerms,
  expandQuery,
  fuse,
  makeSnippet,
  normalizeQuery,
  rankByScore,
  tokenize,
  topK,
  type Ranked
} from "@starwatch/core/search";
import { Embedder } from "@starwatch/core/sync";
import { RepoStore, UserFts, VectorBlobStore } from "@starwatch/cloudflare/storage";
import type { SqlError } from "effect/unstable/sql/SqlError";
import * as Effect from "effect/Effect";
import { MAX_FTS_CANDIDATE_IDS, SEARCH_LEG_LIMIT, SNIPPET_HITS } from "../constants.ts";
import { vectorIdsKey, type VectorBlobFilesShape } from "../adapters/vector-bucket.ts";

/**
 * Search orchestration (docs/17 §3): resolve filters → run the keyword /
 * expansion / semantic legs in parallel shape → fuse with `@starwatch/core/search`
 * → hydrate snippets + groups for the visible page.
 *
 * Legs:
 *   * keyword  — the normalized query, AND first with a quality-aware OR
 *                fallback when the AND result is thin (`chooseMatchStrategy`).
 *   * expanded — the static lexicon leg (docs/17 §2), hybrid/auto modes only.
 *   * semantic — one 384d repo vector per repo from the per-user R2 blob,
 *                exact kNN over the *filtered* candidate set (docs/15 §4).
 *
 * A requested-but-unavailable semantic leg degrades to keyword-only with
 * `degraded: "keyword-only"` instead of failing (docs/08 §3.4).
 */

/** BM25 column weights for `(full_name, description, topics, readme)`. */
const FTS_WEIGHTS: ReadonlyArray<number> = [10, 5, 4, 1];

export interface SearchInput {
  readonly login: string;
  readonly query: string;
  readonly mode: SearchMode;
  readonly filters: SearchFilters;
  readonly limit: number;
}

export interface SearchRuntime {
  /** Sidecar (`vectors/{login}.ids.json`) access for the semantic leg. */
  readonly vectorFiles: VectorBlobFilesShape;
}

/** Run an optional leg, degrading to `null` on any failure (never fatal). */
const optional = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A | null, never, R> =>
  effect.pipe(
    Effect.matchEffect({
      onSuccess: (value) => Effect.succeed(value),
      onFailure: () => Effect.succeed(null)
    })
  );

const emptyResponse = (query: string, startedAt: number): SearchResponse => ({
  query,
  mode: "keyword",
  hits: [],
  tookMs: Date.now() - startedAt,
  semanticCoverage: 0
});

export const runSearch = (
  input: SearchInput,
  runtime: SearchRuntime
): Effect.Effect<
  SearchResponse,
  SqlError,
  RepoStore | UserFts | Embedder | VectorBlobStore
> =>
  Effect.gen(function* () {
    const startedAt = Date.now();
    const repos = yield* RepoStore;
    const fts = yield* UserFts;
    const embedder = yield* Embedder;
    const vectorStore = yield* VectorBlobStore;

    const query = normalizeQuery(input.query);
    const semanticRequested = input.mode !== "keyword";
    const hybridRequested = input.mode === "auto" || input.mode === "hybrid";

    // Hard filters become the candidate set first: every leg is constrained to
    // it, so a filter can never leak a row into the response (docs/17 §3.4).
    const candidates = yield* repos.listReposForSearch(input.login, input.filters);
    if (candidates.length === 0) {
      return emptyResponse(query, startedAt);
    }

    const repoMap = new Map(candidates.map((repo) => [repo.id, repo] as const));
    const candidateSet = new Set(repoMap.keys());
    const candidateIds =
      candidates.length <= MAX_FTS_CANDIDATE_IDS ? candidates.map((repo) => repo.id) : undefined;

    const tokens = tokenize(query);
    // A query with no indexable tokens (empty or punctuation-only) has
    // nothing to retrieve — skip the AI call and all legs.
    if (tokens.length === 0) {
      return emptyResponse(query, startedAt);
    }
    const shape = classifyQuery(query);
    const expansion = expandQuery(query);

    const searchOptions = { limit: SEARCH_LEG_LIMIT, candidateIds, weights: FTS_WEIGHTS };

    // ---- keyword leg -------------------------------------------------------
    let keywordRanks: ReadonlyArray<Ranked> = [];
    if (tokens.length > 0) {
      const andExpression = buildMatchExpression(tokens, "and");
      if (andExpression.length > 0) {
        const andHits = yield* fts.searchKeyword(input.login, andExpression, searchOptions);
        let hits = andHits;
        // docs/18 §6.2: a thin AND match (e.g. `tui for git`) is worse than
        // the noisier OR, so fall back before fusion, not only on zero hits.
        if (tokens.length > 1 && chooseMatchStrategy(andHits.length) === "or") {
          const orExpression = buildMatchExpression(tokens, "or");
          if (orExpression.length > 0) {
            hits = yield* fts.searchKeyword(input.login, orExpression, searchOptions);
          }
        }
        keywordRanks = hits.map((hit) => ({ repoId: hit.repoId, rank: hit.rank }));
      }
    }

    // ---- expansion leg -----------------------------------------------------
    // docs/17 §1.1 routing: lexicon expansion is for `kw` queries; identifier
    // queries rely on exact/trigram evidence and stay precision-first.
    let expandedRanks: ReadonlyArray<Ranked> = [];
    if (hybridRequested && shape !== "identifier" && expansion.activated && expansion.expression !== undefined) {
      const hits = yield* fts.searchKeyword(input.login, expansion.expression, searchOptions);
      expandedRanks = hits.map((hit) => ({ repoId: hit.repoId, rank: hit.rank }));
    }

    // ---- semantic leg ------------------------------------------------------
    let semanticRanks: ReadonlyArray<Ranked> = [];
    let semanticRan = false;
    let semanticDocs = 0;
    let semanticCoverage = 0;
    if (semanticRequested) {
      const pointer = yield* repos.getVectorBlob(input.login);
      if (pointer !== null) {
        const vectors = yield* optional(vectorStore.getVectors(input.login));
        const ids = yield* optional(runtime.vectorFiles.getIds(vectorIdsKey(input.login)));
        const dims = vectors?.[0]?.length ?? 0;
        if (
          vectors !== null &&
          vectors.length > 0 &&
          ids !== null &&
          ids.length === vectors.length &&
          dims === pointer.dims
        ) {
          const embedded = yield* optional(embedder.embed([query]));
          const queryVector = embedded?.[0];
          if (queryVector !== undefined && queryVector.length === dims) {
            // Exact kNN over the filtered universe only (docs/15 §2.1).
            const entries = ids.flatMap((id, index) => {
              const vector = vectors[index];
              return vector === undefined || !candidateSet.has(id) ? [] : [{ id, vector }];
            });
            semanticRanks = rankByScore(
              topK(queryVector, entries, SEARCH_LEG_LIMIT).map(({ id, score }) => ({ repoId: id, score }))
            );
            semanticRan = true;
            semanticDocs = vectors.length;
            semanticCoverage = Math.min(1, semanticDocs / candidates.length);
          }
        }
      }
    }

    // ---- fusion + hydration ------------------------------------------------
    // Name IDF needs only the repos that actually scored in a leg (≤150), not
    // the whole candidate universe — tokenizing 10k names would eat the free
    // CPU budget (docs/13 §2a).
    const legRepoIds = new Set<number>();
    for (const ranks of [keywordRanks, expandedRanks, semanticRanks]) {
      for (const ranked of ranks) legRepoIds.add(ranked.repoId);
    }
    const nameStats = computeNameStats(
      [...legRepoIds].flatMap((id) => {
        const repo = repoMap.get(id);
        return repo === undefined ? [] : [repo];
      })
    );

    const fused = fuse(
      {
        keyword: keywordRanks,
        expanded: expandedRanks,
        semantic: semanticRanks,
        repos: repoMap
      },
      {
        queryTokens: tokens,
        conceptTerms: expansion.terms,
        nameStats
      }
    );

    const selected = fused.slice(0, input.limit);
    const resultIds = selected.map((hit) => hit.repo.id);
    const snippetIds = resultIds.slice(0, SNIPPET_HITS);
    const [groupMap, readmeMap] = yield* Effect.all(
      [repos.groupsForRepos(input.login, resultIds), repos.getReadmeTexts(input.login, snippetIds)],
      { concurrency: 2 }
    );

    const snippetTerms = evidenceTerms(tokens, expansion.terms);
    const hits: Array<SearchHit> = selected.map((hit, index) => ({
      repo: hit.repo,
      score: hit.score,
      snippet: makeSnippet(
        hit.repo,
        snippetTerms,
        index < SNIPPET_HITS ? readmeMap.get(hit.repo.id) : undefined
      ),
      matchedBy: [...hit.matchedBy],
      groups: [...(groupMap.get(hit.repo.id) ?? [])]
    }));

    const mode: SearchResponse["mode"] = semanticRan
      ? input.mode === "semantic"
        ? "semantic"
        : "hybrid"
      : "keyword";

    return {
      query,
      mode,
      hits,
      tookMs: Date.now() - startedAt,
      semanticCoverage,
      ...(semanticRequested && !semanticRan ? { degraded: "keyword-only" as const } : {})
    };
  });
