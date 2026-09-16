/**
 * Query shape classification (docs/17 §1.1) and quality-aware match strategy
 * selection (docs/18 §6.2, fixing the zero-only AND→OR fallback of docs/07 §7.2).
 *
 * Shapes drive routing and expansion:
 *   - `identifier`  single token with identifier signals (punctuation, digits,
 *                   camelCase, `owner/name`); expansion OFF, trigram carries it.
 *   - `keyword`     1–2 plain tokens; expansion ON (lexicon).
 *   - `descriptive` 3+ tokens / prose; expansion OFF (semantic covers paraphrase).
 *
 * These heuristics are deliberately local: they must not depend on D1/name
 * lookup so the function stays pure and testable.
 */

import { normalizeQuery, tokenize } from "./text.ts";

export type QueryKind = "identifier" | "keyword" | "descriptive";

export type MatchStrategy = "and" | "or";

/** Characters that make a single word look like an identifier. */
export const IDENTIFIER_SIGNAL = /[0-9\-_.@/:]/;

/** `drizzle-orm`, `gql.tada`, `wttr.in`, `bge-m3`, `better_auth`. */
export const REPO_NAME_PATTERN = /^[a-z0-9]+(?:[-_.][a-z0-9]+)+$/;

/** `useEffect`, `useDeferredValue` (acronym boundaries are handled by tokenize). */
export const CAMEL_CASE_PATTERN = /^[a-z][a-z0-9]*(?:[A-Z][a-z0-9]*)+$/;

/**
 * A normalized query is identifier-like when it is a single word containing
 * digits or punctuation, camelCase, an `owner/name` pair, or matches the
 * repo-name shape. Multi-word text is never identifier-like.
 */
export const isIdentifierLike = (text: string): boolean => {
  const compact = normalizeQuery(text);

  if (compact.length === 0 || compact.includes(" ")) return false;

  if (IDENTIFIER_SIGNAL.test(compact)) return true;

  if (CAMEL_CASE_PATTERN.test(compact)) return true;

  return REPO_NAME_PATTERN.test(compact.toLowerCase());
};

/**
 * Classify a raw query. Identifier signals are checked on the compact text
 * first because tokenization splits identifiers (`gql.tada` -> 2 tokens,
 * `Effect-TS/effect` -> 3); only then do plain token counts decide.
 * Empty/whitespace input is treated as `keyword` (the caller decides
 * browse-vs-search before ranking).
 */
export const classifyQuery = (raw: string): QueryKind => {
  const text = normalizeQuery(raw);

  if (text.length === 0) return "keyword";

  if (isIdentifierLike(text)) return "identifier";

  return tokenize(text).length <= 2 ? "keyword" : "descriptive";
};

/**
 * docs/18 §6.2: implicit AND is the precision default, but a thin AND result
 * (fewer than {@link MIN_AND_HITS} repos — e.g. `tui for git` matching one list
 * repo) is worse than the noisier OR. The caller runs AND, counts hits, and
 * asks this function whether to retry with OR.
 */
export const MIN_AND_HITS = 3;

export const chooseMatchStrategy = (keywordHits: number): MatchStrategy =>
  keywordHits >= MIN_AND_HITS ? "and" : "or";
