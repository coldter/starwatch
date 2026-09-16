/**
 * Query text normalization and FTS5-safe MATCH construction.
 *
 * Safety invariant (docs/07 §7.6, docs/17 §2.3): user input NEVER reaches a
 * `MATCH` expression as raw syntax. Every token is wrapped in double quotes
 * with internal quotes doubled, so FTS operators (`AND`, `OR`, `NOT`, `NEAR`,
 * `*`, `^`, `:`) are only ever emitted by {@link buildMatchExpression}.
 *
 * Everything here is pure and dependency-free on purpose: it runs on every
 * query, on the Worker isolate's 10 ms CPU budget.
 */

/** Hard cap on a normalized query string (docs/07 §7.6: 512 chars). */
export const MAX_QUERY_CHARS = 512;

/** Token cap applied at the Snippet/ranking boundaries (docs/07 §7.6). */
export const MAX_QUERY_TOKENS = 64;

const CONTROL_CHARS = /\p{Cc}/gu;

const WHITESPACE_RUN = /\s+/g;

const CAMEL_LOWER_UPPER = /([\p{Ll}\p{N}])(\p{Lu})/gu;

const CAMEL_ACRONYM = /(\p{Lu}+)(\p{Lu}\p{Ll})/gu;

const WORD_RUN = /[\p{L}\p{N}]+/gu;

/**
 * NFC-normalize and replace control characters (including newlines/tabs) with
 * spaces. Control characters are *stripped* from query/index text in docs/07;
 * replacing them with a space keeps `foo\nbar` as two tokens instead of
 * gluing it into `foobar`.
 */
export const stripControlChars = (raw: string): string =>
  raw.normalize("NFC").replace(CONTROL_CHARS, " ");

/**
 * Canonical normalization for a raw query string: NFC, control chars -> space,
 * whitespace collapsed, trimmed, clamped to {@link MAX_QUERY_CHARS}.
 */
export const normalizeQuery = (raw: string): string =>
  stripControlChars(raw).replace(WHITESPACE_RUN, " ").trim().slice(0, MAX_QUERY_CHARS).trimEnd();

/**
 * Lowercase tokenizer. Splits on any non alphanumeric code point (so `-`, `.`,
 * `_`, `/`, `@` and `:` are all separators) and additionally splits camelCase
 * boundaries before lowercasing (`useEffect` -> `use`, `effect`). Digit
 * sequences stay attached to their token (`oauth2`, `bge` + `m3`) so version
 * and identifier fragments survive ("keep tokens with digits split sensibly").
 * Duplicate tokens are preserved: callers that need a set should dedupe.
 */
export const tokenize = (text: string): ReadonlyArray<string> =>
  stripControlChars(text)
    .replace(CAMEL_ACRONYM, "$1 $2")
    .replace(CAMEL_LOWER_UPPER, "$1 $2")
    .toLowerCase()
    .match(WORD_RUN) ?? [];

/**
 * FTS5-safe term: wraps in double quotes and doubles internal quotes. Returns
 * a quoted-empty string for blank input; callers should filter empties before
 * building expressions.
 */
export const escapeFtsTerm = (term: string): string =>
  `"${stripControlChars(term).trim().replaceAll('"', '""')}"`;

/**
 * Builds a pure quoted-term MATCH expression. Only this function ever emits
 * ` AND ` / ` OR `; tokens cannot introduce operators. Duplicate terms
 * (case-insensitive) are dropped because boolean MATCH cannot gain recall from
 * repetition. Returns an empty string when there is nothing to match, which
 * callers must treat as "skip this leg" (FTS5 rejects `MATCH ''`).
 */
export const buildMatchExpression = (
  tokens: ReadonlyArray<string>,
  mode: "and" | "or"
): string => {
  const seen = new Set<string>();
  const terms: string[] = [];

  for (const token of tokens) {
    const trimmed = token.trim();

    if (trimmed.length === 0) continue;
    const key = trimmed.toLowerCase();

    if (seen.has(key)) continue;
    seen.add(key);
    terms.push(escapeFtsTerm(trimmed));
  }

  return terms.join(mode === "and" ? " AND " : " OR ");
};

/**
 * Adjacent `size`-token phrases from a raw query, joined by a single space.
 * Used to activate multi-word lexicon triggers such as `http client`,
 * `rate limit` and `background jobs`. `rate-limit` tokenizes to
 * `["rate", "limit"]` and therefore also yields the phrase `rate limit`.
 */
export const phrasesFromQuery = (raw: string, size = 2): ReadonlyArray<string> => {
  if (size < 2) return [];
  const tokens = tokenize(raw);
  const out: string[] = [];
  const seen = new Set<string>();

  for (let i = 0; i + size <= tokens.length; i++) {
    const phrase = tokens.slice(i, i + size).join(" ");

    if (seen.has(phrase)) continue;
    seen.add(phrase);
    out.push(phrase);
  }

  return out;
};
