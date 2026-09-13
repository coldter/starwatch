import * as Schema from "effect/Schema";
import {
  Group,
  Repo,
  SearchResponse,
  SyncPhase,
  UserIndexState,
  UserProfile,
  type SearchMode
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
  groups: Schema.Array(Group)
});

const RepoPayloadSchema = Schema.Struct({
  repo: Repo,
  groups: Schema.Array(Group)
});

const SyncStartSchema = Schema.Struct({
  started: Schema.Boolean,
  phase: SyncPhase
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
    } = {}
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ApiError";
    this.kind = kind;
    this.status = options.status ?? null;
    this.retryAfterSeconds = options.retryAfterSeconds ?? null;
    this.detail = options.detail ?? null;
  }
}

export function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === "AbortError") ||
    (typeof error === "object" && error !== null && (error as { name?: unknown }).name === "AbortError")
  );
}

export function asApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  return new ApiError("network", "Couldn't reach starwatch. Check your connection and try again.", {
    cause: error
  });
}

function decode<S extends Schema.ConstraintDecoder<unknown>>(schema: S, value: unknown, what: string): S["Type"] {
  try {
    return Schema.decodeUnknownSync(schema)(value);
  } catch (cause) {
    throw new ApiError("decode", `starwatch couldn't read the ${what} response.`, { cause });
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
    if (typeof body === "object" && body !== null) {
      const record = body as Record<string, unknown>;
      if (typeof record.message === "string" && record.message.trim()) detail = record.message;
      if (typeof record._tag === "string") tag = record._tag;
    }
  } catch {
    // Non-JSON error body — fall back to the status text below.
  }
  const retryAfterSeconds = parseRetryAfter(response.headers.get("retry-after"));

  if (response.status === 404) {
    return new ApiError("not-found", detail ?? "We couldn't find that on GitHub.", {
      status: response.status,
      detail
    });
  }
  if (response.status === 429 || tag === "SyncCooldown" || tag === "GithubRateLimited") {
    return new ApiError(
      "rate-limited",
      detail ?? `starwatch is rate-limited right now.${humanizeRetry(retryAfterSeconds)}`,
      { status: response.status, retryAfterSeconds, detail }
    );
  }
  if (response.status === 409 || tag === "SyncInProgress") {
    return new ApiError("busy", detail ?? "Indexing is already running for this user.", {
      status: response.status,
      detail
    });
  }
  if (response.status === 403 || tag === "BudgetExceeded") {
    return new ApiError("budget", detail ?? "This is temporarily limited to protect the free budget.", {
      status: response.status,
      detail
    });
  }
  if (response.status >= 500) {
    return new ApiError("http", detail ?? "starwatch hit a server error. Retry in a moment.", {
      status: response.status,
      detail
    });
  }
  return new ApiError("http", detail ?? `Request failed (${response.status}).`, {
    status: response.status,
    detail
  });
}

async function request(path: string, init: RequestInit = {}): Promise<unknown> {
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
    throw new ApiError("network", "Couldn't reach starwatch. Check your connection and try again.", { cause });
  }

  if (!response.ok) throw await toApiError(response);
  if (response.status === 204) return null;
  try {
    return await response.json();
  } catch (cause) {
    throw new ApiError("decode", "starwatch couldn't read the server response.", {
      status: response.status,
      cause
    });
  }
}

const userPath = (login: string): string => `/api/users/${encodeURIComponent(login)}`;
const repoPath = (owner: string, name: string): string =>
  `/api/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;

export async function fetchUser(login: string, signal?: AbortSignal): Promise<UserPayload> {
  const body = await request(userPath(login), { signal });
  return decode(UserPayloadSchema, body, "user");
}

export interface SearchQuery {
  q: string;
  mode?: SearchMode;
  lang?: string;
  groups?: ReadonlyArray<string>;
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
  if (query.lang) params.set("lang", query.lang);
  for (const group of query.groups ?? []) params.append("group", group);
  if (query.archived) params.set("archived", "true");
  if (query.minStars !== undefined) params.set("minStars", String(query.minStars));
  if (query.maxStars !== undefined) params.set("maxStars", String(query.maxStars));
  params.set("limit", String(query.limit ?? 50));
  return `${userPath(login)}/search?${params.toString()}`;
}

export async function fetchSearch(
  login: string,
  query: SearchQuery,
  signal?: AbortSignal
): Promise<SearchResponse> {
  const body = await request(searchUrl(login, query), { signal });
  return decode(SearchResponse, body, "search");
}

export async function startUserSync(
  login: string,
  options: { full?: boolean } = {},
  signal?: AbortSignal
): Promise<SyncStartResponse> {
  const body = await request(`${userPath(login)}/sync`, {
    method: "POST",
    body: JSON.stringify({ full: options.full === true }),
    signal
  });
  return decode(SyncStartSchema, body, "sync");
}

export async function fetchSyncState(login: string, signal?: AbortSignal): Promise<UserIndexState> {
  const body = await request(`${userPath(login)}/sync`, { signal });
  return decode(UserIndexState, body, "sync state");
}

export function userSyncEventsUrl(login: string): string {
  return `${userPath(login)}/sync/events`;
}

export async function fetchRepo(owner: string, name: string, signal?: AbortSignal): Promise<RepoPayload> {
  const body = await request(repoPath(owner, name), { signal });
  return decode(RepoPayloadSchema, body, "repository");
}
