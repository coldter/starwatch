/**
 * Plain-text snippet assembly (docs/07 §6, docs/17 §4.2).
 *
 * `makeSnippet` centers a ≤220-char window on the first whole-word query-term
 * match in the README, falls back to the description, then to the empty
 * string. No HTML, no markup: highlighters work on `text` later.
 */

import type { Repo } from "@starwatch/domain";

export const SNIPPET_MAX_CHARS = 220;

export const SNIPPET_ELLIPSIS = "\u2026";

/** How many chars of context to show before the matched term when clipping. */
export const SNIPPET_CONTEXT_BEFORE = 60;

const MIN_MATCH_CHARS = 2;

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const collapse = (value: string): string => value.replace(/\s+/g, " ").trim();

const termPattern = (term: string): RegExp | undefined => {
  const trimmed = collapse(term);

  if (trimmed.length < MIN_MATCH_CHARS) return undefined;

  return new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(trimmed)}(?![\\p{L}\\p{N}])`, "iu");
};

export interface TermMatch {
  readonly index: number;
  readonly length: number;
}

/** First whole-word occurrence of any term (earliest wins; ties keep term order). */
export const findFirstTermMatch = (
  text: string,
  terms: ReadonlyArray<string>,
): TermMatch | undefined => {
  let best: TermMatch | undefined;

  for (const term of terms) {
    const pattern = termPattern(term);

    if (!pattern) continue;
    const match = pattern.exec(text);

    if (!match || match.index === undefined) continue;

    if (!best || match.index < best.index) {
      best = { index: match.index, length: match[0].length };
    }
  }

  return best;
};

const clipHead = (text: string): string => {
  const cleaned = collapse(text);

  if (cleaned.length <= SNIPPET_MAX_CHARS) return cleaned;
  const clipped = cleaned.slice(0, SNIPPET_MAX_CHARS - 1);

  return `${clipped}${SNIPPET_ELLIPSIS}`;
};

const windowAround = (text: string, match: TermMatch): string => {
  if (text.length <= SNIPPET_MAX_CHARS) return collapse(text);

  let start = Math.max(0, match.index - SNIPPET_CONTEXT_BEFORE);

  if (start > 0) {
    // Snap the window start forward to a word boundary, never past the match.
    const nextSpace = text.indexOf(" ", start);

    if (nextSpace !== -1) start = Math.min(nextSpace + 1, match.index);
  }

  const end = Math.min(text.length, start + SNIPPET_MAX_CHARS);
  const prefix = start > 0 ? SNIPPET_ELLIPSIS : "";
  const suffix = end < text.length ? SNIPPET_ELLIPSIS : "";
  const budget = SNIPPET_MAX_CHARS - prefix.length - suffix.length;
  let body = collapse(text.slice(start, end));

  if (body.length > budget) {
    // Prefer cutting at the last word boundary inside the budget.
    const lastSpace = body.lastIndexOf(" ", budget);
    body = lastSpace > 0 ? body.slice(0, lastSpace) : body.slice(0, budget);
  }

  return `${prefix}${body}${suffix}`;
};

/**
 * Build the snippet for a hit. `terms` should be the original query tokens
 * (plus expansion terms when the hit came from that leg). Word-boundary-aware,
 * case-insensitive; returns "" only when neither README nor description has
 * any usable text.
 */
export const makeSnippet = (repo: Repo, terms: ReadonlyArray<string>, readme?: string): string => {
  const readmeText = readme ?? "";

  if (readmeText.length > 0) {
    const match = findFirstTermMatch(readmeText, terms);

    if (match) return windowAround(readmeText, match);
  }

  const description = repo.description ?? "";

  if (description.length > 0) {
    const match = findFirstTermMatch(description, terms);

    if (match) return windowAround(description, match);

    return clipHead(description);
  }

  return "";
};
