import * as Schema from "effect/Schema";
import { Group } from "./group.ts";
import { Repo } from "./repo.ts";

/** Which retrieval legs to run. `auto` applies the quality-aware routing. */
export const SearchMode = Schema.Literals(["auto", "keyword", "hybrid", "semantic"]);

export type SearchMode = typeof SearchMode.Type;

/**
 * Result ordering (docs/07 §4). `relevance` is the default and keeps the fused
 * ranking; the others re-order the match set by stars or by a starred/pushed
 * date (docs/07 §5.5 tie-breakers).
 */
export const SearchSort = Schema.Literals(["relevance", "stars", "starred", "pushed"]);

export type SearchSort = typeof SearchSort.Type;

/** Structured filters, composable with every search mode. All hard constraints. */
export const SearchFilters = Schema.Struct({
  language: Schema.optional(Schema.String),
  minStars: Schema.optional(Schema.Number),
  maxStars: Schema.optional(Schema.Number),
  topics: Schema.optional(Schema.Array(Schema.String)),
  groups: Schema.optional(Schema.Array(Schema.String)),
  archived: Schema.optional(Schema.Boolean),
  license: Schema.optional(Schema.String),
  starredAfter: Schema.optional(Schema.String),
  starredBefore: Schema.optional(Schema.String),
});

export type SearchFilters = typeof SearchFilters.Type;

export const SearchRequest = Schema.Struct({
  query: Schema.String,
  mode: Schema.optional(SearchMode),
  sort: Schema.optional(SearchSort),
  filters: Schema.optional(SearchFilters),
  limit: Schema.optional(Schema.Number),
});

export type SearchRequest = typeof SearchRequest.Type;

/** Which retrieval leg produced a hit. */
export const MatchSource = Schema.Literals(["keyword", "expanded", "semantic", "name"]);

export type MatchSource = typeof MatchSource.Type;

export const SearchHit = Schema.Struct({
  repo: Repo,
  score: Schema.Number,
  snippet: Schema.String,
  matchedBy: Schema.Array(MatchSource),
  groups: Schema.Array(Schema.String),
});

export type SearchHit = typeof SearchHit.Type;

export const DegradedReason = Schema.Literals(["keyword-only", "semantic-window", "rate-limited"]);

export type DegradedReason = typeof DegradedReason.Type;

export const SearchResponse = Schema.Struct({
  query: Schema.String,
  mode: Schema.Literals(["keyword", "hybrid", "semantic"]),
  hits: Schema.Array(SearchHit),
  /**
   * Rows the active ordering covers: every filtered candidate for browse, the
   * fused match set for a query. Lets a client page past the first window.
   */
  total: Schema.Number,
  tookMs: Schema.Number,
  semanticCoverage: Schema.Number,
  degraded: Schema.optional(DegradedReason),
});

export type SearchResponse = typeof SearchResponse.Type;

export { Group, Repo };
