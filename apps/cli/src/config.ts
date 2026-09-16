/**
 * Pure CLI configuration helpers: base-URL resolution, query-string assembly,
 * shorthand parsing and exit-code mapping.
 *
 * Nothing in this module performs I/O, so every function is unit-testable.
 */

/** Default Worker endpoint for local development (`docs/08-public-service-ux.md`). */
export const DEFAULT_API_URL = "http://127.0.0.1:8787";

export const DEFAULT_LIMIT = 10;

/** Server-side cap: semantic search fuses a top-50 window (`docs/05-cli.md` §3.3). */
export const MAX_LIMIT = 50;

/** Process exit codes shared by every command (SIGINT is handled by the runtime). */
export const EXIT_CODES = {
  success: 0,
  error: 1,
  noResults: 2,
  interrupted: 130,
} as const;

export type ExitCode = (typeof EXIT_CODES)[keyof typeof EXIT_CODES];

/** `flag > env > default` for the API base URL; trailing slashes are dropped. */
export const normalizeBaseUrl = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();

  if (!trimmed) return undefined;

  return trimmed.replace(/\/+$/, "");
};

export const resolveApiUrl = (flag: string | undefined, env: string | undefined): string =>
  normalizeBaseUrl(flag) ?? normalizeBaseUrl(env) ?? DEFAULT_API_URL;

/**
 * Accepts `login`, `@login`, `github.com/login`, a profile URL, or a full
 * `https://github.com/login` URL and returns the bare login.
 */
export const normalizeLogin = (value: string | undefined): string => {
  if (!value) return "";

  return value
    .trim()
    .replace(/^(?:https?:\/\/)?(?:www\.)?github\.com\//i, "")
    .replace(/[?#].*$/, "")
    .replace(/^@/, "")
    .replace(/\/+$/, "");
};

/** `flag > env`; `undefined` means the user-scoped command cannot run. */
export const resolveUser = (
  flag: string | undefined,
  env: string | undefined,
): string | undefined => {
  const fromFlag = normalizeLogin(flag);

  if (fromFlag !== "") return fromFlag;
  const fromEnv = normalizeLogin(env);

  return fromEnv === "" ? undefined : fromEnv;
};

export interface RepoShorthand {
  readonly owner: string;
  readonly name: string;
}

/**
 * Accepts `owner/repo`, `github.com/owner/repo`, `https://github.com/owner/repo`,
 * a trailing `/` and a trailing `.git`; returns `undefined` for anything else.
 */
export const parseRepoShorthand = (input: string): RepoShorthand | undefined => {
  const cleaned = input
    .trim()
    .replace(/\.git$/i, "")
    .replace(/^https?:\/\//i, "")
    .replace(/^www\./i, "")
    .replace(/^github\.com\//i, "")
    .replace(/[?#].*$/, "")
    .replace(/\/+$/, "");

  const parts = cleaned.split("/").filter((part) => part !== "");

  if (parts.length !== 2) return undefined;
  const [owner, name] = parts;

  if (owner === undefined || name === undefined || owner === "" || name === "") return undefined;

  return { owner, name };
};

/**
 * Repeatable flags may also pack values with commas: `--topic a,b --topic c`
 * expands to `["a", "b", "c"]`.
 */
export const splitCommaValues = (values: readonly string[]): ReadonlyArray<string> =>
  values.flatMap((value) =>
    value
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part !== ""),
  );

/** Returns a human error message, or `undefined` when the limit is valid. */
export const validateLimit = (limit: number): string | undefined =>
  Number.isInteger(limit) && limit >= 1 && limit <= MAX_LIMIT
    ? undefined
    : `--limit must be an integer between 1 and ${MAX_LIMIT} (got ${limit})`;

/** `search` succeeded whenever it returned at least one hit (`docs/05-cli.md` §4.6). */
export const exitCodeForSearch = (hitCount: number): ExitCode =>
  hitCount > 0 ? EXIT_CODES.success : EXIT_CODES.noResults;

export type QueryValue = string | number | boolean | ReadonlyArray<string> | undefined;

/**
 * Serializes query params deterministically: skips `undefined`/empty values and
 * repeats the key once per array entry (`topic=a&topic=b`).
 */
export const encodeQuery = (params: Readonly<Record<string, QueryValue>>): string => {
  const parts: Array<string> = [];

  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === "") continue;

    if (Array.isArray(value)) {
      for (const item of value) {
        if (item === "") continue;
        parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(item)}`);
      }

      continue;
    }

    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  }

  return parts.join("&");
};

export interface SearchQueryParams {
  readonly q: string;
  readonly mode?: string | undefined;
  readonly lang?: string | undefined;
  readonly topics?: ReadonlyArray<string> | undefined;
  readonly groups?: ReadonlyArray<string> | undefined;
  readonly minStars?: number | undefined;
  readonly maxStars?: number | undefined;
  readonly archived?: boolean | undefined;
  readonly license?: string | undefined;
  readonly starredAfter?: string | undefined;
  readonly starredBefore?: string | undefined;
  readonly limit?: number | undefined;
}

/** Maps CLI options onto the Worker's `GET /api/users/:login/search` params. */
export const buildSearchQueryString = (params: SearchQueryParams): string =>
  encodeQuery({
    q: params.q,
    mode: params.mode,
    lang: params.lang,
    topic: params.topics,
    group: params.groups,
    minStars: params.minStars,
    maxStars: params.maxStars,
    archived: params.archived,
    license: params.license,
    starredAfter: params.starredAfter,
    starredBefore: params.starredBefore,
    limit: params.limit,
  });

export const userPath = (login: string): string => `/api/users/${encodeURIComponent(login)}`;

export const searchPath = (login: string): string => `${userPath(login)}/search`;

export const syncPath = (login: string): string => `${userPath(login)}/sync`;

export const repoPath = (owner: string, name: string): string =>
  `/api/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;

export const healthPath = "/api/health";

export const buildUrl = (apiUrl: string, path: string, query?: string): string =>
  query === undefined || query === "" ? `${apiUrl}${path}` : `${apiUrl}${path}?${query}`;

/** `http://host:port/path` → `http://host:port`; falls back to the raw input. */
export const originOf = (url: string): string => {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
};
