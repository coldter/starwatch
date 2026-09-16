import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { SearchMode } from "@starwatch/domain";

/**
 * URL search state for `/u/$login` (docs/06 §3, docs/08 §3.1).
 *
 * This module is the URL I/O boundary: the router hands `validateSearch` an
 * untyped search bag (`Record<string, unknown>`), `decodeRawSearchBag` decodes
 * it into raw search values, and every field is decoded again with the schema
 * that owns it before use.
 *
 * `validateSearch` returns only the keys actually present in the URL, so
 * defaults never leak into shareable links. The page normalizes once with
 * `normalizeUserSearch`. `group` is a repeated param
 * (`?group=work&group=reading`) handled by the router's custom parser.
 */

export const SEARCH_MODES = ["auto", "keyword", "hybrid", "semantic"] as const;

export const DEFAULT_MODE: SearchMode = "auto";

export const PAGE_SIZE = 20;

export const SEARCH_LIMIT = 50;

/** URL-shaped search: every field optional, defaults omitted. */
export interface UserSearch {
  q?: string;
  mode?: SearchMode;
  lang?: string;
  group?: string[];
  archived?: boolean;
  minStars?: number;
  page?: number;
  /** `owner/name` — opens the repo detail drawer when present. */
  repo?: string;
}

/** Normalized search state used by the page and components. */
export interface SearchState {
  q: string;
  mode: SearchMode;
  lang: string | undefined;
  group: string[];
  archived: boolean;
  minStars: number | undefined;
  page: number;
  repo: string | undefined;
}

export const EMPTY_SEARCH: SearchState = {
  q: "",
  mode: DEFAULT_MODE,
  lang: undefined,
  group: [],
  archived: false,
  minStars: undefined,
  page: 1,
  repo: undefined
};

/**
 * One raw value a search key can carry: the router's `parseSearch` emits
 * strings and repeated-key string lists, typed navigation adds numbers and
 * booleans.
 */
const RawSearchValue = Schema.Union([
  Schema.String,
  Schema.Number,
  Schema.Boolean,
  Schema.Array(Schema.String)
]);

export type RawSearchValue = typeof RawSearchValue.Type;

/** `?archived`: booleans from navigation, `"true"`/`"1"` from the URL. */
const RawFlag = Schema.Union([Schema.Boolean, Schema.Literal("true"), Schema.Literal("1")]);

/** `?group`: one value per key occurrence, or a list from typed navigation. */
const RawGroupList = Schema.ArrayEnsure(Schema.String);

/** The raw search bag as the router hands it over: arbitrary keys, raw values. */
const RawSearchBag = Schema.Record(Schema.String, RawSearchValue);

export type RawSearchBag = typeof RawSearchBag.Type;

/**
 * Decode the router's untyped search bag into raw search values. A bag the
 * router cannot produce (not an object, or values that are not raw search
 * values) decodes to `None` and means "no search state".
 */
export const decodeRawSearchBag = Schema.decodeUnknownOption(RawSearchBag);

/**
 * Text from a raw scalar: URL values are strings, typed navigation adds finite
 * numbers. Lists, booleans and non-finite numbers carry no text.
 */
function asString(value: RawSearchValue | undefined): string | undefined {
  const text = Schema.decodeUnknownOption(Schema.String)(value);

  if (Option.isSome(text)) return text.value;

  const numeric = Schema.decodeUnknownOption(Schema.Number)(value);

  if (Option.isSome(numeric) && Number.isFinite(numeric.value)) return String(numeric.value);

  return undefined;
}

function asPositiveInt(value: RawSearchValue | undefined): number | undefined {
  const raw = asString(value);

  if (raw === undefined) return undefined;
  const parsed = Number.parseInt(raw, 10);

  if (!Number.isFinite(parsed) || parsed < 0) return undefined;

  return parsed;
}

export function toSearchMode(value: string | number | ReadonlyArray<string> | undefined): SearchMode {
  const raw = asString(value);

  return Option.getOrElse(Schema.decodeUnknownOption(SearchMode)(raw), () => DEFAULT_MODE);
}

function splitGroups(value: RawSearchValue | undefined): string[] {
  const decoded = Schema.decodeUnknownOption(RawGroupList)(value);

  if (Option.isNone(decoded)) return [];
  const out: string[] = [];

  for (const entry of decoded.value) {
    for (const part of entry.split(",")) {
      const slug = part.trim();

      if (slug && !out.includes(slug)) out.push(slug);
    }
  }

  return out;
}

export function parseRepoSpec(value: RawSearchValue | undefined): string | undefined {
  const raw = asString(value)?.trim();

  if (!raw) return undefined;

  return /^[^/\s]+\/[^/\s]+$/.test(raw) ? raw : undefined;
}

/** `validateSearch` for `/u/$login`; never throws, never materializes defaults. */
export function parseUserSearch(raw: RawSearchBag): UserSearch {
  const out: UserSearch = {};

  const q = asString(raw.q)?.trim();

  if (q) out.q = q;

  const mode = toSearchMode(asString(raw.mode));

  if (mode !== DEFAULT_MODE) out.mode = mode;

  const lang = asString(raw.lang)?.trim();

  if (lang) out.lang = lang;

  const group = splitGroups(raw.group);

  if (group.length > 0) out.group = group;

  if (Option.isSome(Schema.decodeUnknownOption(RawFlag)(raw.archived))) out.archived = true;

  const minStars = asPositiveInt(raw.minStars);

  if (minStars !== undefined && minStars > 0) out.minStars = minStars;

  const page = Math.max(1, asPositiveInt(raw.page) ?? 1);

  if (page > 1) out.page = page;

  const repo = parseRepoSpec(raw.repo);

  if (repo) out.repo = repo;

  return out;
}

/** Materialize defaults exactly once, at the page boundary. */
export function normalizeUserSearch(raw: UserSearch): SearchState {
  return {
    q: raw.q ?? "",
    mode: raw.mode ?? DEFAULT_MODE,
    lang: raw.lang,
    group: raw.group ?? [],
    archived: raw.archived ?? false,
    minStars: raw.minStars,
    page: raw.page ?? 1,
    repo: raw.repo
  };
}

/** Serialize normalized state to navigation input, omitting every default. */
export function toUrlSearch(state: SearchState): UserSearch {
  const out: UserSearch = {};

  if (state.q) out.q = state.q;

  if (state.mode !== DEFAULT_MODE) out.mode = state.mode;

  if (state.lang) out.lang = state.lang;

  if (state.group.length > 0) out.group = [...state.group];

  if (state.archived) out.archived = true;

  if (state.minStars !== undefined) out.minStars = state.minStars;

  if (state.page > 1) out.page = state.page;

  if (state.repo) out.repo = state.repo;

  return out;
}

export function hasActiveFilters(state: SearchState): boolean {
  return (
    state.lang !== undefined ||
    state.group.length > 0 ||
    state.archived ||
    state.minStars !== undefined
  );
}

export function toggleGroup(state: SearchState, slug: string): string[] {
  return state.group.includes(slug)
    ? state.group.filter((entry) => entry !== slug)
    : [...state.group, slug];
}
