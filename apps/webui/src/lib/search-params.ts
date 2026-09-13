import type { SearchMode } from "@starwatch/domain";

/**
 * URL search state for `/u/$login` (docs/06 §3, docs/08 §3.1).
 *
 * `validateSearch` returns only the keys actually present in the URL, so
 * defaults never leak into shareable links. The page normalizes once with
 * `normalizeUserSearch`. `group` is a repeated param
 * (`?group=work&group=reading`) handled by the router's custom parser.
 */

export const SEARCH_MODES = ["auto", "keyword", "hybrid", "semantic"] as const;

const MODE_SET: ReadonlySet<string> = new Set(SEARCH_MODES);

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

function asString(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function asPositiveInt(value: unknown): number | undefined {
  const raw = asString(value);
  if (raw === undefined) return undefined;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return undefined;
  return parsed;
}

export function toSearchMode(value: unknown): SearchMode {
  const raw = asString(value);
  return raw !== undefined && MODE_SET.has(raw) ? (raw as SearchMode) : DEFAULT_MODE;
}

function splitGroups(value: unknown): string[] {
  const values = Array.isArray(value) ? value : [value];
  const out: string[] = [];
  for (const entry of values) {
    if (typeof entry !== "string") continue;
    for (const part of entry.split(",")) {
      const slug = part.trim();
      if (slug && !out.includes(slug)) out.push(slug);
    }
  }
  return out;
}

export function parseRepoSpec(value: unknown): string | undefined {
  const raw = asString(value)?.trim();
  if (!raw) return undefined;
  return /^[^/\s]+\/[^/\s]+$/.test(raw) ? raw : undefined;
}

/** `validateSearch` for `/u/$login`; never throws, never materializes defaults. */
export function parseUserSearch(raw: Record<string, unknown>): UserSearch {
  const out: UserSearch = {};

  const q = asString(raw.q)?.trim();
  if (q) out.q = q;

  const mode = toSearchMode(raw.mode);
  if (mode !== DEFAULT_MODE) out.mode = mode;

  const lang = asString(raw.lang)?.trim();
  if (lang) out.lang = lang;

  const group = splitGroups(raw.group);
  if (group.length > 0) out.group = group;

  if (raw.archived === true || raw.archived === "true" || raw.archived === "1") out.archived = true;

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
