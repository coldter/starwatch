import * as Schema from "effect/Schema";
import { Repo } from "./repo.ts";

/** Which retrieval legs to run. `auto` picks based on the query shape. */
export const SearchMode = Schema.Literals(["auto", "keyword", "hybrid", "semantic"]);
export type SearchMode = typeof SearchMode.Type;

/** Structured filters, composable with every search mode. */
export const SearchFilters = Schema.Struct({
  language: Schema.optional(Schema.String),
  minStars: Schema.optional(Schema.Number),
  maxStars: Schema.optional(Schema.Number),
  topics: Schema.optional(Schema.Array(Schema.String)),
  archived: Schema.optional(Schema.Boolean),
  starredAfter: Schema.optional(Schema.String),
  starredBefore: Schema.optional(Schema.String),
  license: Schema.optional(Schema.String)
});
export type SearchFilters = typeof SearchFilters.Type;

export const SearchRequest = Schema.Struct({
  query: Schema.String,
  mode: Schema.optional(SearchMode),
  filters: Schema.optional(SearchFilters),
  limit: Schema.optional(Schema.Number)
});
export type SearchRequest = typeof SearchRequest.Type;

/** Which retrieval leg produced a hit. */
export const MatchSource = Schema.Literals(["keyword", "semantic"]);
export type MatchSource = typeof MatchSource.Type;

export const SearchHit = Schema.Struct({
  repo: Repo,
  score: Schema.Number,
  snippet: Schema.String,
  matchedBy: Schema.Array(MatchSource)
});
export type SearchHit = typeof SearchHit.Type;
