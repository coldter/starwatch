import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  Group,
  Repo,
  SearchResponse,
  SyncPhase,
  UserIndexState,
  UserProfile,
  type SearchMode,
  type SearchSort,
} from "@starwatch/domain";

/**
 * The single typed API module (docs/06 §8): every network call goes through
 * here, responses are decoded with the domain schemas, and aborts propagate
 * untouched so hooks can ignore them.
 *
 * Contract (apps/worker builds against the same shapes):
 *   GET  /api/users/:login                     → { profile, state, groups }
 *   GET  /api/users/:login/search?…            → SearchResponse
 *   POST /api/users/:login/sync { full? }      → { started, phase }
 *   GET  /api/users/:login/sync                → UserIndexState
 *   GET  /api/users/:login/sync/events         → SSE of UserIndexState
 *   GET  /api/repos/:owner/:name               → { repo, groups }
 */

export interface UserPayload {
  profile: UserProfile;
  state: UserIndexState;
  groups: ReadonlyArray<Group>;
}

export interface RepoPayload {
  repo: Repo;
  groups: ReadonlyArray<Group>;
}

export interface SyncStartResponse {
  started: boolean;
  phase: SyncPhase;
}

const UserPayloadSchema = Schema.Struct({
  profile: UserProfile,
  state: UserIndexState,
  groups: Schema.Array(Group),
});

const RepoPayloadSchema = Schema.Struct({
  repo: Repo,
  groups: Schema.Array(Group),
});

const SyncStartSchema = Schema.Struct({
  started: Schema.Boolean,
  phase: SyncPhase,
});

export type ApiErrorKind =
  | "network"
  | "not-found"
  | "rate-limited"
  | "busy"
  | "budget"
  | "decode"
  | "http";

export class ApiError extends Error {
  readonly kind: ApiErrorKind;
  readonly status: number | null;
  readonly retryAfterSeconds: number | null;
  readonly detail: string | null;

  constructor(
    kind: ApiErrorKind,
    message: string,
    options: {
      status?: number | null;
      retryAfterSeconds?: number | null;
      detail?: string | null;
      cause?: unknown;
    } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ApiError";
    this.kind = kind;
    this.status = options.status ?? null;
    this.retryAfterSeconds = options.retryAfterSeconds ?? null;
    this.detail = options.detail ?? null;
  }
}

/** Error-like values (`DOMException`, thrown records) tag themselves with `name`. */
const NamedError = Schema.Struct({
  name: Schema.optional(Schema.String),
});

export function isAbortError(cause: unknown): boolean {
  if (cause instanceof DOMException && cause.name === "AbortError") return true;

  const named = Schema.decodeUnknownOption(NamedError)(cause);

  return Option.isSome(named) && named.value.name === "AbortError";
}

export function asApiError(cause: unknown): ApiError {
  if (cause instanceof ApiError) return cause;

  return new ApiError(
    "network",
    "Couldn't reach the server. Check your connection and try again.",
    {
      cause,
    },
  );
}

const ErrorBody = Schema.Struct({
  _tag: Schema.optional(Schema.String),
  message: Schema.optional(Schema.String),
});

/**
 * Decode a JSON response body with the schema that owns it. Every network
 * payload is parsed here, at the HTTP boundary.
 */
async function decodeResponse<S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  response: Response,
  what: string,
): Promise<S["Type"]> {
  try {
    const body: unknown = await response.json();

    return Schema.decodeUnknownSync(schema)(body);
  } catch (cause) {
    throw new ApiError("decode", `Couldn't read the ${what} response.`, {
      status: response.status,
      cause,
    });
  }
}

function parseRetryAfter(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number.parseInt(header, 10);

  if (Number.isFinite(seconds) && seconds >= 0) return seconds;
  const date = Date.parse(header);

  if (Number.isNaN(date)) return null;

  return Math.max(0, Math.round((date - Date.now()) / 1000));
}

function humanizeRetry(seconds: number | null): string {
  if (seconds === null) return "";

  if (seconds < 60) return ` Try again in ~${seconds}s.`;

  return ` Try again in ~${Math.round(seconds / 60)} min.`;
}

async function toApiError(response: Response): Promise<ApiError> {
  let detail: string | null = null;
  let tag: string | null = null;

  try {
    const body: unknown = await response.clone().json();
    const decoded = Schema.decodeUnknownOption(ErrorBody)(body);

    if (Option.isSome(decoded)) {
      const { _tag, message } = decoded.value;

      if (message !== undefined && message.trim()) detail = message;

      if (_tag !== undefined) tag = _tag;
    }
  } catch {
    // Non-JSON error body — fall back to the status text below.
  }

  const retryAfterSeconds = parseRetryAfter(response.headers.get("retry-after"));

  if (response.status === 404) {
    return new ApiError("not-found", detail ?? "Not found on GitHub.", {
      status: response.status,
      detail,
    });
  }

  if (response.status === 429 || tag === "SyncCooldown" || tag === "GithubRateLimited") {
    return new ApiError(
      "rate-limited",
      detail ?? `Rate limited.${humanizeRetry(retryAfterSeconds)}`,
      { status: response.status, retryAfterSeconds, detail },
    );
  }

  if (response.status === 409 || tag === "SyncInProgress") {
    return new ApiError("busy", detail ?? "Indexing is already running for this user.", {
      status: response.status,
      detail,
    });
  }

  if (response.status === 403 || tag === "BudgetExceeded") {
    return new ApiError("budget", detail ?? "Temporarily limited. Try again later.", {
      status: response.status,
      detail,
    });
  }

  if (response.status >= 500) {
    return new ApiError("http", detail ?? "Server error. Retry in a moment.", {
      status: response.status,
      detail,
    });
  }

  return new ApiError("http", detail ?? `Request failed (${response.status}).`, {
    status: response.status,
    detail,
  });
}

async function request(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("accept", "application/json");

  if (init.body !== undefined && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }

  let response: Response;

  try {
    response = await fetch(path, { ...init, headers });
  } catch (cause) {
    if (isAbortError(cause)) throw cause;
    throw asApiError(cause);
  }

  if (!response.ok) throw await toApiError(response);

  return response;
}

const userPath = (login: string): string => `/api/users/${encodeURIComponent(login)}`;

const repoPath = (owner: string, name: string): string =>
  `/api/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;

export async function fetchUser(login: string, signal?: AbortSignal): Promise<UserPayload> {
  const response = await request(userPath(login), { signal });

  return decodeResponse(UserPayloadSchema, response, "user");
}

export interface SearchQuery {
  q: string;
  mode?: SearchMode;
  sort?: SearchSort;
  lang?: string;
  groups?: ReadonlyArray<string>;
  /** Worker semantics: `true` = only archived, `false` = exclude, omitted = any. */
  archived?: boolean;
  minStars?: number;
  maxStars?: number;
  limit?: number;
}

/** Exported for tests/debugging; `useSearch` uses `fetchSearch`. */
export function searchUrl(login: string, query: SearchQuery): string {
  const params = new URLSearchParams();
  params.set("q", query.q);

  if (query.mode && query.mode !== "auto") params.set("mode", query.mode);

  if (query.sort !== undefined && query.sort !== "relevance") params.set("sort", query.sort);

  if (query.lang) params.set("lang", query.lang);

  // One comma-separated value, not a repeated key: the worker declares `group`
  // as a single string and splits it itself, and a repeated key reaches the
  // HTTP API as an array that fails query decoding (400).
  if (query.groups !== undefined && query.groups.length > 0)
    params.set("group", query.groups.join(","));

  if (query.archived !== undefined) params.set("archived", String(query.archived));

  if (query.minStars !== undefined) params.set("minStars", String(query.minStars));

  if (query.maxStars !== undefined) params.set("maxStars", String(query.maxStars));
  params.set("limit", String(query.limit ?? 50));

  return `${userPath(login)}/search?${params.toString()}`;
}

export async function fetchSearch(
  login: string,
  query: SearchQuery,
  signal?: AbortSignal,
): Promise<SearchResponse> {
  const response = await request(searchUrl(login, query), { signal });

  return decodeResponse(SearchResponse, response, "search");
}

export async function startUserSync(
  login: string,
  options: { full?: boolean } = {},
  signal?: AbortSignal,
): Promise<SyncStartResponse> {
  const response = await request(`${userPath(login)}/sync`, {
    method: "POST",
    body: JSON.stringify({ full: options.full === true }),
    signal,
  });

  return decodeResponse(SyncStartSchema, response, "sync");
}

export async function fetchSyncState(login: string, signal?: AbortSignal): Promise<UserIndexState> {
  const response = await request(`${userPath(login)}/sync`, { signal });

  return decodeResponse(UserIndexState, response, "sync state");
}

export function userSyncEventsUrl(login: string): string {
  return `${userPath(login)}/sync/events`;
}

export async function fetchRepo(
  owner: string,
  name: string,
  signal?: AbortSignal,
): Promise<RepoPayload> {
  const response = await request(repoPath(owner, name), { signal });

  return decodeResponse(RepoPayloadSchema, response, "repository");
}
