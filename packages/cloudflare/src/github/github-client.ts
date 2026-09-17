/**
 * GitHub API client (REST + GraphQL) for the public-data indexer.
 *
 * Conventions from docs/09:
 * - star pages ask for `application/vnd.github.star+json` and `created asc`;
 * - `If-None-Match` makes repeat page reads free (304);
 * - READMEs first probe `raw.githubusercontent.com` (zero quota) and only then
 *   fall back to `GET /repos/{fullName}/readme` with `Accept: ...raw`;
 * - rate-limit headers are surfaced on every {@link StarPage};
 * - 403/429 -> `GithubRateLimited`, 404 on a profile/star list -> `UserNotFound`,
 *   every other non-2xx -> `GithubUpstream`.
 */

import {
  GithubRateLimited,
  GithubUpstream,
  UserNotFound,
  type Group,
  type Repo,
} from "@starwatch/domain";
import {
  GithubClient,
  type GithubClientService,
  type GithubReadme,
  type ListStarPageOptions,
  type StarPage,
  GraphqlEnvelopeWire,
  ListItemsPageWire,
  StarItemWire,
  UserListsWire,
  UserWire,
  groupFromUserList,
} from "@starwatch/core/sync";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Headers from "effect/unstable/http/Headers";
import * as HttpClient from "effect/unstable/http/HttpClient";
import type * as HttpClientError from "effect/unstable/http/HttpClientError";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as Predicate from "effect/Predicate";
import type * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import {
  GITHUB_API_BASE,
  GITHUB_GRAPHQL_URL,
  parseLinkNext,
  readmeProbeUrls,
  starPageUrl,
} from "./github-urls.ts";

/** `Effect.timeout` tags its failure with `TimeoutError`; nothing else in this
 *  client's error union does, so the guard is both precise and readable. */
const isTimeoutError = Predicate.isTagged("TimeoutError");

export interface GithubClientOptions {
  /** Service token; empty string means anonymous (never used in production). */
  readonly token: string;
  /** Required by GitHub: `starwatch/<version> (+https://…/starwatch)`. */
  readonly userAgent: string;
}

/**
 * Per-request ceiling. Without it a stalled connection keeps a workflow step
 * pending forever: no error, no retry, and the run sits in an active phase
 * while the user watches a spinner (docs/03 §1.3 treats timeouts as an
 * expected failure that must back off, not hang).
 */
const GITHUB_REQUEST_TIMEOUT = "20 seconds";

/** docs/09 §1.4: stop paginating once `Link rel="next"` exceeds this cap. */
const MAX_LIST_PAGES = 100;

/** Runaway guard for item continuation (lists cap at 32, items rarely >100). */
const MAX_ITEM_PAGES = 1_000;

const LISTS_QUERY = `query StarwatchLists($login: String!, $listAfter: String, $itemAfter: String) {
  user(login: $login) {
    lists(first: 100, after: $listAfter) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        name
        isPrivate
        items(first: 100, after: $itemAfter) {
          pageInfo { hasNextPage endCursor }
          nodes { ... on Repository { databaseId } }
        }
      }
    }
  }
}`;

/** Item continuation for lists with more than 100 entries (>100 is rare). */
const LIST_ITEMS_QUERY = `query StarwatchListItems($id: ID!, $itemAfter: String) {
  node(id: $id) {
    ... on UserList {
      items(first: 100, after: $itemAfter) {
        pageInfo { hasNextPage endCursor }
        nodes { ... on Repository { databaseId } }
      }
    }
  }
}`;

/** Variables of the `StarwatchLists` query: login plus its two page cursors. */
interface ListGroupsVariables {
  readonly login: string;
  readonly listAfter: string | null;
  readonly itemAfter: string | null;
}

/** Variables of the `StarwatchListItems` query: list node id plus item cursor. */
interface ListItemsVariables {
  readonly id: string;
  readonly itemAfter: string;
}

const headerValue = (headers: Headers.Headers, name: string): string | undefined =>
  Option.getOrUndefined(Headers.get(headers, name));

const headerNumber = (headers: Headers.Headers, name: string): number | undefined => {
  const raw = headerValue(headers, name);

  if (raw === undefined) return undefined;
  const value = Number(raw);

  return Number.isFinite(value) ? value : undefined;
};

const isSuccess = (status: number): boolean => status >= 200 && status < 300;

const isRateLimitedStatus = (status: number): boolean => status === 403 || status === 429;

const repoPath = (fullName: string): string =>
  fullName.split("/").map(encodeURIComponent).join("/");

export const makeGithubClient = (
  options: GithubClientOptions,
): Layer.Layer<GithubClient, never, HttpClient.HttpClient> =>
  Layer.effect(
    GithubClient,
    Effect.gen(function* () {
      const http = yield* HttpClient.HttpClient;

      const apiHeaders = (extra?: Readonly<Record<string, string>>) => {
        const headers = {
          accept: "application/vnd.github+json",
          "user-agent": options.userAgent,
          "x-github-api-version": "2026-03-10",
          ...extra,
        };

        if (options.token.length === 0) return headers;

        return { ...headers, authorization: `Bearer ${options.token}` };
      };

      const execute = (
        request: HttpClientRequest.HttpClientRequest,
      ): Effect.Effect<HttpClientResponse.HttpClientResponse, GithubUpstream> =>
        http.execute(request).pipe(
          // A hung connection is the one failure that looks like progress: the
          // step never settles, so it never retries and the run sits in an
          // active phase forever. Failing here at least lets the workflow's
          // retry policy (and, in the limit, the start handler's abandonment
          // check) take over. GitHub's p99 is well under a second; 20 s is
          // generous for a cold isolate, a 100-item star page and a README.
          Effect.timeout(GITHUB_REQUEST_TIMEOUT),
          Effect.mapError((error) =>
            isTimeoutError(error)
              ? new GithubUpstream({
                  message: `GitHub request timed out after ${GITHUB_REQUEST_TIMEOUT}`,
                  status: 0,
                })
              : new GithubUpstream({
                  message: error.message,
                  status: error.response?.status ?? 0,
                }),
          ),
        );

      const decodeBody = <S extends Schema.Constraint & { readonly DecodingServices: never }>(
        schema: S,
        response: HttpClientResponse.HttpClientResponse,
      ): Effect.Effect<S["Type"], GithubUpstream> =>
        Effect.gen(function* () {
          const json = yield* response.json.pipe(
            Effect.mapError(
              (error: HttpClientError.HttpClientError) =>
                new GithubUpstream({ message: error.message, status: response.status }),
            ),
          );

          return yield* Schema.decodeUnknownEffect(schema)(json).pipe(
            Effect.mapError(
              (issue) =>
                new GithubUpstream({
                  message: `Unexpected GitHub response body: ${issue.message}`,
                  status: response.status,
                }),
            ),
          );
        });

      const rateLimit = (headers: Headers.Headers) => {
        const remaining = headerNumber(headers, "x-ratelimit-remaining");
        const reset = headerNumber(headers, "x-ratelimit-reset");

        return {
          remaining,
          resetAt: reset === undefined ? undefined : new Date(reset * 1000).toISOString(),
        };
      };

      /**
       * Secondary limits come back as 403/429 with `retry-after` and no reset
       * header; primary exhaustion carries `x-ratelimit-reset`. Both are worth
       * waiting out, so both are captured here (docs/03 §1.3).
       */
      const rateLimited = (
        status: number,
        resetAt: string | undefined,
        headers?: Headers.Headers,
      ): GithubRateLimited => {
        const retryAfter = headers === undefined ? undefined : headerNumber(headers, "retry-after");

        return new GithubRateLimited({
          message: `GitHub rate limit or secondary limit (HTTP ${status})`,
          resetAt: resetAt ?? null,
          retryAfterSeconds: retryAfter === undefined || retryAfter <= 0 ? null : retryAfter,
        });
      };

      const upstream = (status: number): GithubUpstream =>
        new GithubUpstream({
          message: `GitHub responded with HTTP ${status}`,
          status,
        });

      const getUserProfile = Effect.fn("GithubClient.getUserProfile")(function* (login: string) {
        const response = yield* execute(
          HttpClientRequest.get(`${GITHUB_API_BASE}/users/${encodeURIComponent(login)}`, {
            headers: apiHeaders(),
          }),
        );

        if (response.status === 404) return yield* new UserNotFound({ login });
        const rate = rateLimit(response.headers);

        if (isRateLimitedStatus(response.status)) {
          return yield* rateLimited(response.status, rate.resetAt, response.headers);
        }

        if (!isSuccess(response.status)) return yield* upstream(response.status);

        return yield* decodeBody(UserWire, response);
      });

      const listStarPage = Effect.fn("GithubClient.listStarPage")(function* (
        login: string,
        pageOptions: ListStarPageOptions,
      ) {
        const perPage = pageOptions.perPage ?? 100;
        const baseHeaders = apiHeaders({ accept: "application/vnd.github.star+json" });

        const headers =
          pageOptions.etag === undefined
            ? baseHeaders
            : { ...baseHeaders, "if-none-match": pageOptions.etag };

        const response = yield* execute(
          HttpClientRequest.get(starPageUrl(login, pageOptions.page, perPage), { headers }),
        );

        const rate = rateLimit(response.headers);

        if (response.status === 304) {
          return {
            repos: [],
            starredAt: new Map<number, string>(),
            etag: headerValue(response.headers, "etag") ?? pageOptions.etag,
            notModified: true,
            nextPage: undefined,
            rateLimitRemaining: rate.remaining ?? 0,
            rateLimitResetAt: rate.resetAt,
          } satisfies StarPage;
        }

        if (response.status === 404) return yield* new UserNotFound({ login });

        if (isRateLimitedStatus(response.status)) {
          return yield* rateLimited(response.status, rate.resetAt, response.headers);
        }

        if (!isSuccess(response.status)) return yield* upstream(response.status);

        const items = yield* decodeBody(Schema.Array(StarItemWire), response);
        const starredAt = new Map<number, string>();
        const repos: Repo[] = [];

        for (const item of items) {
          starredAt.set(item.repo.id, item.starredAt);
          repos.push({ ...item.repo, starredAt: item.starredAt });
        }

        return {
          repos,
          starredAt,
          etag: headerValue(response.headers, "etag"),
          notModified: false,
          nextPage: parseLinkNext(headerValue(response.headers, "link")),
          rateLimitRemaining: rate.remaining ?? 0,
          rateLimitResetAt: rate.resetAt,
        } satisfies StarPage;
      });

      const getReadme = Effect.fn("GithubClient.getReadme")(function* (
        fullName: string,
        defaultBranch: string,
      ) {
        const probeHeaders = { "user-agent": options.userAgent };

        for (const url of readmeProbeUrls(fullName, defaultBranch)) {
          const response = yield* execute(HttpClientRequest.get(url, { headers: probeHeaders }));

          if (isSuccess(response.status)) {
            const text = yield* response.text.pipe(
              Effect.mapError(
                (error: HttpClientError.HttpClientError) =>
                  new GithubUpstream({ message: error.message, status: response.status }),
              ),
            );

            return { text, source: "raw" } satisfies GithubReadme;
          }

          if (isRateLimitedStatus(response.status)) {
            return yield* rateLimited(response.status, undefined, response.headers);
          }
          // 404 (wrong path/variant) and other misses: try the next candidate.
        }

        const fallback = yield* execute(
          HttpClientRequest.get(`${GITHUB_API_BASE}/repos/${repoPath(fullName)}/readme`, {
            headers: apiHeaders({ accept: "application/vnd.github.raw" }),
          }),
        );

        const rate = rateLimit(fallback.headers);

        if (fallback.status === 404) return null;

        if (isRateLimitedStatus(fallback.status)) {
          return yield* rateLimited(fallback.status, rate.resetAt, fallback.headers);
        }

        if (!isSuccess(fallback.status)) return yield* upstream(fallback.status);

        const text = yield* fallback.text.pipe(
          Effect.mapError(
            (error: HttpClientError.HttpClientError) =>
              new GithubUpstream({ message: error.message, status: fallback.status }),
          ),
        );

        return { text, source: "rest" } satisfies GithubReadme;
      });

      const graphql = <S extends Schema.Constraint & { readonly DecodingServices: never }>(
        query: string,
        variables: ListGroupsVariables | ListItemsVariables,
        dataSchema: S,
        login: string,
      ): Effect.Effect<S["Type"], GithubUpstream | GithubRateLimited | UserNotFound> =>
        Effect.gen(function* () {
          const request = HttpClientRequest.bodyJsonUnsafe(
            HttpClientRequest.post(GITHUB_GRAPHQL_URL, {
              headers: apiHeaders({ "content-type": "application/json" }),
            }),
            { query, variables },
          );

          const response = yield* execute(request);
          const rate = rateLimit(response.headers);

          if (isRateLimitedStatus(response.status)) {
            return yield* rateLimited(response.status, rate.resetAt, response.headers);
          }

          if (!isSuccess(response.status)) return yield* upstream(response.status);
          const envelope = yield* decodeBody(GraphqlEnvelopeWire, response);
          const errors = envelope.errors;

          if (errors !== undefined && errors.length > 0) {
            const message = errors.map((error) => error.message).join("; ");

            if (/could not resolve to a user/i.test(message)) {
              return yield* new UserNotFound({ login });
            }

            return yield* new GithubUpstream({ message, status: response.status });
          }

          return yield* Schema.decodeUnknownEffect(dataSchema)(envelope.data).pipe(
            Effect.mapError(
              () =>
                new GithubUpstream({
                  message: "Unexpected GitHub GraphQL response shape",
                  status: response.status,
                }),
            ),
          );
        });

      const listGroups = Effect.fn("GithubClient.listGroups")(function* (login: string) {
        // The GraphQL API requires authentication, so without a token this is a
        // guaranteed 401 — or an anonymous-IP 403 once the shared 60/hour REST
        // quota is gone. Failing with the configuration fact is more useful to
        // the operator than echoing whichever status that IP happened to get.
        if (options.token.length === 0) {
          return yield* new GithubUpstream({
            message:
              "GitHub Lists need an authenticated request: set GITHUB_TOKEN to a fine-grained token with public read access.",
            status: 0,
          });
        }

        const groups: Group[] = [];
        let listAfter: string | undefined = undefined;

        for (let listPage = 1; ; listPage++) {
          if (listPage > MAX_LIST_PAGES) {
            return yield* new GithubUpstream({
              message: `GitHub returned more than ${MAX_LIST_PAGES} list pages`,
              status: 200,
            });
          }

          const data: (typeof UserListsWire)["Type"] = yield* graphql(
            LISTS_QUERY,
            { login, listAfter: listAfter ?? null, itemAfter: null },
            UserListsWire,
            login,
          );

          if (data.user === null) return yield* new UserNotFound({ login });

          for (const node of data.user.lists.nodes) {
            if (node.isPrivate) continue;
            const extraRepoIds: number[] = [];
            let pageInfo = node.items.pageInfo;

            for (let itemPage = 1; pageInfo.hasNextPage; itemPage++) {
              const cursor = pageInfo.endCursor;

              if (cursor === null) break;

              if (itemPage > MAX_ITEM_PAGES) {
                return yield* new GithubUpstream({
                  message: `GitHub returned more than ${MAX_ITEM_PAGES} item pages for list ${node.id}`,
                  status: 200,
                });
              }

              const itemsData: (typeof ListItemsPageWire)["Type"] = yield* graphql(
                LIST_ITEMS_QUERY,
                { id: node.id, itemAfter: cursor },
                ListItemsPageWire,
                login,
              );

              if (itemsData.node === null) {
                return yield* new GithubUpstream({
                  message: `GitHub list ${node.id} disappeared during pagination`,
                  status: 200,
                });
              }

              for (const item of itemsData.node.items.nodes) {
                if (item !== null) extraRepoIds.push(item.databaseId);
              }

              pageInfo = itemsData.node.items.pageInfo;
            }

            groups.push(groupFromUserList(node, groups.length, extraRepoIds));
          }

          if (!data.user.lists.pageInfo.hasNextPage) break;
          const nextCursor: string | null = data.user.lists.pageInfo.endCursor;

          if (nextCursor === null) break;
          listAfter = nextCursor;
        }

        return groups;
      });

      return {
        getUserProfile,
        listStarPage,
        listGroups,
        getReadme,
      } satisfies GithubClientService;
    }),
  );
