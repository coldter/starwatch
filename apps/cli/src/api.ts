/**
 * Worker API client. Every call targets the contract in the task brief and
 * decodes the body with `@starwatch/domain` schemas so the CLI never renders
 * unvalidated data. HTTP failures are mapped to one-line, actionable messages.
 */
import { Effect, Result } from "effect";
import * as Schema from "effect/Schema";
import * as Runtime from "effect/Runtime";
import { HttpClient, HttpBody } from "effect/unstable/http";
import {
  Group,
  Repo,
  SearchResponse,
  SyncPhase,
  UserIndexState,
  UserProfile,
} from "@starwatch/domain";
import {
  DEFAULT_API_URL,
  buildSearchQueryString,
  buildUrl,
  healthPath,
  originOf,
  repoPath,
  searchPath,
  syncPath,
  userPath,
  type SearchQueryParams,
} from "./config.ts";

export const CLI_VERSION = "0.0.0";

// ---------------------------------------------------------------------------
// Response schemas (the Worker's JSON envelopes)
// ---------------------------------------------------------------------------

export const UserPageResponse = Schema.Struct({
  profile: UserProfile,
  state: UserIndexState,
  groups: Schema.Array(Group),
});

export type UserPageResponse = typeof UserPageResponse.Type;

export const RepoPageResponse = Schema.Struct({
  repo: Repo,
  groups: Schema.Array(Group),
});

export type RepoPageResponse = typeof RepoPageResponse.Type;

export const SyncStartResponse = Schema.Struct({
  started: Schema.Boolean,
  phase: SyncPhase,
});

export type SyncStartResponse = typeof SyncStartResponse.Type;

export const HealthResponse = Schema.Struct({
  ok: Schema.Boolean,
  service: Schema.String,
  version: Schema.String,
});

export type HealthResponse = typeof HealthResponse.Type;

// ---------------------------------------------------------------------------
// Errors: each carries the process exit code the runtime should use
// ---------------------------------------------------------------------------

export class ApiError extends Schema.TaggedError<ApiError>()("ApiError", {
  code: Schema.String,
  message: Schema.String,
  hint: Schema.optional(Schema.String),
  status: Schema.optional(Schema.Number),
}) {
  override readonly [Runtime.errorExitCode] = 1;
  override readonly [Runtime.errorReported] = false;
}

/** Bad input (missing `--user`, unparseable `owner/repo`) — exit 1. */
export class CliInputError extends Schema.TaggedError<CliInputError>()("CliInputError", {
  message: Schema.String,
  hint: Schema.optional(Schema.String),
}) {
  override readonly [Runtime.errorExitCode] = 1;
  override readonly [Runtime.errorReported] = false;
}

/** `search` succeeded with zero hits — exit 2 (`docs/05-cli.md` §4.6). */
export class NoResultsError extends Schema.TaggedError<NoResultsError>()("NoResultsError", {
  query: Schema.String,
}) {
  override readonly [Runtime.errorExitCode] = 2;
  override readonly [Runtime.errorReported] = false;
}

// ---------------------------------------------------------------------------
// HTTP error description (pure, unit-tested)
// ---------------------------------------------------------------------------

export interface ErrorContext {
  readonly login?: string | undefined;
  readonly repo?: string | undefined;
}

export interface HttpErrorInfo {
  readonly code: string;
  readonly message: string;
  readonly hint?: string | undefined;
}

interface BodyFields {
  readonly code?: string | undefined;
  readonly message?: string | undefined;
  readonly retryAfterSeconds?: number | undefined;
}

/** Fields the Worker puts in an error body, nested or flat on the wire. */
const ErrorBodyFields = Schema.Struct({
  _tag: Schema.optional(Schema.String),
  code: Schema.optional(Schema.String),
  message: Schema.optional(Schema.String),
  retryAfterSeconds: Schema.optional(Schema.Finite),
});

/**
 * The envelope comes first: the flat variant tolerates excess properties, so
 * it must not get the chance to discard a nested `error` object.
 */
const ErrorBodyPayload = Schema.Union([Schema.Struct({ error: ErrorBodyFields }), ErrorBodyFields]);

const ErrorBodyJson = Schema.fromJsonString(ErrorBodyPayload);

/** An empty string on the wire means the field is absent. */
const nonEmptyString = (value: string | undefined): string | undefined =>
  value === undefined || value === "" ? undefined : value;

/** Parse a Worker error body; a malformed body degrades to "no fields". */
const errorFields = (bodyText: string): BodyFields => {
  const decoded = Schema.decodeUnknownResult(ErrorBodyJson)(bodyText);

  if (Result.isFailure(decoded)) return {};

  const record = "error" in decoded.success ? decoded.success.error : decoded.success;

  return {
    code: nonEmptyString(record.code) ?? nonEmptyString(record._tag),
    message: nonEmptyString(record.message),
    retryAfterSeconds: record.retryAfterSeconds,
  };
};

const userLabel = (context: ErrorContext): string =>
  context.login === undefined ? "this user" : `@${context.login}`;

/** Maps an HTTP status + error body to a readable message and a named fix. */
export const mapHttpError = (
  status: number,
  bodyText: string,
  context: ErrorContext,
): HttpErrorInfo => {
  const fields = errorFields(bodyText);
  const apiMessage = fields.message ?? `The starwatch API returned HTTP ${status}.`;

  if (status === 404) {
    if (context.repo !== undefined) {
      const name = context.repo.split("/")[1] ?? context.repo;

      return {
        code: "NOT_FOUND",
        message: `Repository "${context.repo}" is not indexed.`,
        hint:
          "Check the spelling, or search for it from a user's page: " +
          `starwatch search "${name}" --user <login>`,
      };
    }

    if (context.login !== undefined) {
      return {
        code: "NOT_FOUND",
        message: `No GitHub user named "${context.login}".`,
        hint: "Check the spelling — usernames use letters, numbers and single hyphens.",
      };
    }

    return { code: "NOT_FOUND", message: apiMessage };
  }

  if (status === 429) {
    if (fields.code === "SyncInProgress") {
      return {
        code: "RATE_LIMITED",
        message: fields.message ?? `An index is already running for ${userLabel(context)}.`,
        hint: `Follow it with: starwatch sync ${context.login ?? "<login>"} --wait`,
      };
    }

    if (fields.code === "SyncCooldown") {
      const retry =
        fields.retryAfterSeconds === undefined
          ? ""
          : ` Try again in ~${fields.retryAfterSeconds}s.`;

      return {
        code: "RATE_LIMITED",
        message: fields.message ?? `Indexing ${userLabel(context)} is in cooldown.`,
        hint: retry.trim() === "" ? "Wait for the cooldown to pass, then retry." : retry.trim(),
      };
    }

    return {
      code: "RATE_LIMITED",
      message: fields.message ?? "The service is rate limiting requests right now.",
      hint:
        fields.retryAfterSeconds === undefined
          ? "Wait a moment and try again."
          : `Retry in ~${fields.retryAfterSeconds}s.`,
    };
  }

  if (status === 409) {
    return {
      code: "CONFLICT",
      message: fields.message ?? "The request conflicts with the current state of the index.",
      hint: "Re-run without --full, or follow the active run with: starwatch sync <login> --wait",
    };
  }

  if (status === 400) {
    return {
      code: "BAD_REQUEST",
      message: fields.message ?? "The service rejected the request.",
      hint: "Check the query and filters, then retry.",
    };
  }

  if (status >= 500) {
    return {
      code: "SERVER",
      message: fields.message ?? `The starwatch API had a problem (HTTP ${status}).`,
      hint: "Try again in a moment; if it persists, run: starwatch health",
    };
  }

  return { code: fields.code ?? "UNKNOWN", message: apiMessage };
};

const networkError = (url: string, cause: unknown): ApiError => {
  const detail = cause instanceof Error && cause.message !== "" ? ` (${cause.message})` : "";
  const origin = originOf(url);

  return new ApiError({
    code: "NETWORK",
    message: `Could not reach the starwatch API at ${origin}${detail}.`,
    hint:
      `Check the service is running and that --api is correct (default ${DEFAULT_API_URL}); ` +
      `run: starwatch health --api ${origin}`,
  });
};

const badResponse = (url: string, detail: string): ApiError =>
  new ApiError({
    code: "BAD_RESPONSE",
    message: `The starwatch API ${detail} at ${originOf(url)}.`,
    hint: "The service may be an older or newer version — check: starwatch health",
  });

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

export interface RequestInit {
  readonly method?: "GET" | "POST";
  readonly body?: unknown;
}

const fetchJson = <A>(
  schema: Schema.ConstraintDecoder<A, never>,
  url: string,
  context: ErrorContext,
  init?: RequestInit,
): Effect.Effect<A, ApiError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const headers = { "x-starwatch-client": `cli/${CLI_VERSION}` };

    const request =
      init?.method === "POST"
        ? client.post(url, { headers, body: HttpBody.jsonUnsafe(init.body) })
        : client.get(url, { headers });

    const response = yield* request.pipe(Effect.mapError((cause) => networkError(url, cause)));

    if (response.status >= 400) {
      const bodyText = yield* response.text.pipe(Effect.orElseSucceed(() => ""));
      const info = mapHttpError(response.status, bodyText, context);

      return yield* Effect.fail(
        new ApiError({
          code: info.code,
          message: info.message,
          hint: info.hint,
          status: response.status,
        }),
      );
    }

    const body = yield* response.json.pipe(
      Effect.mapError(() => badResponse(url, "returned a malformed JSON body")),
    );

    return yield* Schema.decodeUnknownEffect(schema)(body).pipe(
      Effect.mapError(() => badResponse(url, "returned an unexpected response shape")),
    );
  });

export const getUserPage = (
  apiUrl: string,
  login: string,
): Effect.Effect<UserPageResponse, ApiError, HttpClient.HttpClient> =>
  fetchJson(UserPageResponse, buildUrl(apiUrl, userPath(login)), { login });

export const searchStars = (
  apiUrl: string,
  login: string,
  params: SearchQueryParams,
): Effect.Effect<SearchResponse, ApiError, HttpClient.HttpClient> =>
  fetchJson(SearchResponse, buildUrl(apiUrl, searchPath(login), buildSearchQueryString(params)), {
    login,
  });

export const startSync = (
  apiUrl: string,
  login: string,
  full: boolean,
): Effect.Effect<SyncStartResponse, ApiError, HttpClient.HttpClient> =>
  fetchJson(
    SyncStartResponse,
    buildUrl(apiUrl, syncPath(login)),
    { login },
    {
      method: "POST",
      body: { full },
    },
  );

export const getSyncState = (
  apiUrl: string,
  login: string,
): Effect.Effect<UserIndexState, ApiError, HttpClient.HttpClient> =>
  fetchJson(UserIndexState, buildUrl(apiUrl, syncPath(login)), { login });

export const getRepoPage = (
  apiUrl: string,
  owner: string,
  name: string,
): Effect.Effect<RepoPageResponse, ApiError, HttpClient.HttpClient> =>
  fetchJson(RepoPageResponse, buildUrl(apiUrl, repoPath(owner, name)), {
    repo: `${owner}/${name}`,
  });

export const getHealth = (
  apiUrl: string,
): Effect.Effect<HealthResponse, ApiError, HttpClient.HttpClient> =>
  fetchJson(HealthResponse, buildUrl(apiUrl, healthPath), {});
