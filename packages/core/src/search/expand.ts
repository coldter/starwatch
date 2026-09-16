/**
 * Deterministic static query expansion (docs/17 §2.2, docs/18 §3).
 *
 * Expansion is ADDITIVE, never a replacement: it feeds a separate FTS leg
 * fused at weight 0.6. Triggers match WHOLE tokens or adjacent 2-token
 * phrases only — `auth` triggers the auth cluster, `author` never does
 * (the `auth*` prefix trap verified in docs/17 §2.3).
 */

import { LEXICON, type Concept } from "@starwatch/domain";
import { buildMatchExpression, normalizeQuery, phrasesFromQuery, tokenize } from "./text.ts";

/** docs/18 measured `hybrid+expand` with a flat OR leg; the cap keeps D1 rows bounded. */
export const MAX_EXPANSION_TERMS = 8;

export interface QueryExpansion {
  /** True when at least one concept's trigger fired. */
  readonly activated: boolean;
  /** Activated concept ids, in lexicon order. */
  readonly conceptIds: ReadonlyArray<string>;
  /** Deduped expansion terms (concept order → term order), capped. */
  readonly terms: ReadonlyArray<string>;
  /** FTS5-safe OR expression over {@link terms}; `undefined` when none. */
  readonly expression: string | undefined;
}

const EMPTY_EXPANSION: QueryExpansion = {
  activated: false,
  conceptIds: [],
  terms: [],
  expression: undefined,
};

const normalizeTrigger = (trigger: string): string => tokenize(trigger).join(" ");

const triggerMatches = (
  trigger: string,
  tokens: ReadonlyArray<string>,
  phrases: ReadonlyArray<string>,
): boolean => {
  const normalized = normalizeTrigger(trigger);

  if (normalized.length === 0) return false;

  if (normalized.includes(" ")) return phrases.includes(normalized);

  return tokens.includes(normalized);
};

/**
 * Expand `raw` using `lexicon` (defaults to the domain LEXICON). Multiple
 * activated concepts are OR-fused into one deterministic leg of at most
 * {@link MAX_EXPANSION_TERMS} terms; the original query stays the primary
 * lexical leg, so a missed trigger can only add recall, never remove a hit.
 * (docs/17 §2.2 rule 3 prescribes per-cluster AND with an OR fallback; the
 * flat OR with an 8-term cap is the v1 semantics specified for this module.)
 */
export const expandQuery = (
  raw: string,
  lexicon: ReadonlyArray<Concept> = LEXICON,
): QueryExpansion => {
  const text = normalizeQuery(raw);

  if (text.length === 0) return EMPTY_EXPANSION;

  const tokens = tokenize(text);
  const phrases = phrasesFromQuery(text);

  const conceptIds: string[] = [];
  const termKeys = new Set<string>();
  const terms: string[] = [];

  for (const concept of lexicon) {
    const triggered = concept.triggers.some((trigger) => triggerMatches(trigger, tokens, phrases));

    if (!triggered) continue;
    conceptIds.push(concept.id);

    for (const term of concept.expand) {
      if (terms.length >= MAX_EXPANSION_TERMS) break;
      const normalized = normalizeQuery(term).toLowerCase();

      if (normalized.length === 0 || termKeys.has(normalized)) continue;
      termKeys.add(normalized);
      terms.push(term);
    }
  }

  if (conceptIds.length === 0) return EMPTY_EXPANSION;

  return {
    activated: true,
    conceptIds,
    terms,
    expression: terms.length > 0 ? buildMatchExpression(terms, "or") : undefined,
  };
};
