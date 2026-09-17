import { describe, expect, it } from "@effect/vitest";
import { GithubRateLimited, GithubUpstream, UserNotFound } from "@starwatch/domain";
import { GithubClient } from "@starwatch/core/sync";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Headers from "effect/unstable/http/Headers";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientError from "effect/unstable/http/HttpClientError";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import { makeGithubClient } from "../../src/github/github-client.ts";

interface StubResponse {
  readonly status: number;
  readonly headers?: Record<string, string>;
  readonly body?: string;
}

/**
 * A stub that never answers at all: the connection the client's `execute` maps
 * to `GithubUpstream` with `status: 0` (raw.githubusercontent.com drops pooled
 * connections, which is what the README probes have to survive).
 */
interface DroppedConnection {
  readonly drop: true;
}

const droppedConnection: DroppedConnection = { drop: true };

type StubHandler = (
  request: HttpClientRequest.HttpClientRequest,
) => StubResponse | DroppedConnection;

const jsonResponse = <A>(
  value: A,
  status = 200,
  headers: Record<string, string> = {},
): StubResponse => ({
  status,
  headers: { "content-type": "application/json", ...headers },
  body: JSON.stringify(value),
});

const textResponse = (
  value: string,
  status = 200,
  headers: Record<string, string> = {},
): StubResponse => ({ status, headers, body: value });

const webResponse = (stub: StubResponse): Response => {
  const response = new Response(stub.body ?? null, {
    // Web `Response` rejects null-body statuses (e.g. 304); build as 200 and
    // shadow the status so the client under test still sees the real code.
    status: stub.status === 304 || stub.status < 200 ? 200 : stub.status,
    headers: stub.headers,
  });

  if (response.status !== stub.status) {
    Object.defineProperty(response, "status", {
      value: stub.status,
      enumerable: true,
    });
  }

  return response;
};

const runClient = <A, E>(
  handler: StubHandler,
  program: Effect.Effect<A, E, GithubClient>,
): Promise<A> => {
  const http = HttpClient.make((request) => {
    const response = handler(request);

    if ("drop" in response) {
      return Effect.fail(
        new HttpClientError.HttpClientError({
          reason: new HttpClientError.TransportError({
            request,
            description: "connection reset",
          }),
        }),
      );
    }

    return Effect.succeed(HttpClientResponse.fromWeb(request, webResponse(response)));
  });

  const layer = Layer.provide(
    makeGithubClient({
      token: "test-token",
      userAgent: "starwatch-test/0.0.0",
    }),
    Layer.succeed(HttpClient.HttpClient, http),
  );

  return Effect.runPromise(program.pipe(Effect.provide(layer)));
};

const requestHeader = (
  request: HttpClientRequest.HttpClientRequest,
  name: string,
): string | undefined => Option.getOrUndefined(Headers.get(request.headers, name));

/** GraphQL request body the client encodes through `bodyJsonUnsafe`. */
const GraphqlRequestBody = Schema.Struct({
  query: Schema.optional(Schema.String),
});

type GraphqlRequestBody = typeof GraphqlRequestBody.Type;

const requestJsonBody = (
  request: HttpClientRequest.HttpClientRequest,
): GraphqlRequestBody | undefined => {
  const body = request.body;

  if (!Predicate.isTagged(body, "Uint8Array")) return undefined;

  return Option.getOrUndefined(
    Schema.decodeUnknownOption(GraphqlRequestBody)(JSON.parse(new TextDecoder().decode(body.body))),
  );
};

const repoJson = (id: number, name: string) => ({
  id,
  full_name: `owner/${name}`,
  owner: { login: "owner" },
  name,
  description: `the ${name} repo`,
  language: "TypeScript",
  topics: ["tooling"],
  stargazers_count: 10,
  forks_count: 1,
  archived: false,
  license: { spdx_id: "MIT" },
  homepage: null,
  pushed_at: "2026-09-01T00:00:00Z",
  html_url: `https://github.com/owner/${name}`,
});

const profileJson = {
  login: "coldter",
  id: 77_358_146,
  name: null,
  avatar_url: "https://avatars.githubusercontent.com/u/77358146",
  bio: null,
  company: null,
  location: null,
  followers: 3,
  public_repos: 5,
  created_at: "2015-01-02T03:04:05Z",
};

describe("GithubClient.getUserProfile", () => {
  it("decodes a profile and sends the required headers", async () => {
    let seen: HttpClientRequest.HttpClientRequest | undefined;

    const profile = await runClient(
      (request) => {
        seen = request;

        return jsonResponse(profileJson);
      },
      GithubClient.use((client) => client.getUserProfile("coldter")),
    );

    expect(profile.login).toBe("coldter");
    expect(profile.publicRepos).toBe(5);
    expect(seen?.url).toBe("https://api.github.com/users/coldter");
    expect(requestHeader(seen!, "accept")).toBe("application/vnd.github+json");
    expect(requestHeader(seen!, "x-github-api-version")).toBe("2026-03-10");
    expect(requestHeader(seen!, "authorization")).toBe("Bearer test-token");
    expect(requestHeader(seen!, "user-agent")).toBe("starwatch-test/0.0.0");
  });

  it("maps 404 to UserNotFound", async () => {
    const result = await runClient(
      () => textResponse("not found", 404),
      GithubClient.use((client) => client.getUserProfile("nobody")).pipe(Effect.result),
    );

    expect(Result.isFailure(result)).toBe(true);

    if (Result.isFailure(result)) {
      expect(result.failure).toBeInstanceOf(UserNotFound);
    }
  });

  it("maps 403 with reset headers to GithubRateLimited", async () => {
    const result = await runClient(
      () =>
        textResponse("rate limited", 403, {
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": "1900000000",
        }),
      GithubClient.use((client) => client.getUserProfile("coldter")).pipe(Effect.result),
    );

    expect(Result.isFailure(result)).toBe(true);

    if (Result.isFailure(result)) {
      const failure = result.failure;

      expect(failure).toBeInstanceOf(GithubRateLimited);

      if (Schema.is(GithubRateLimited)(failure)) {
        expect(failure.resetAt).toBe(new Date(1_900_000_000 * 1000).toISOString());
      }
    }
  });

  it("maps other failures to GithubUpstream", async () => {
    const result = await runClient(
      () => textResponse("boom", 500),
      GithubClient.use((client) => client.getUserProfile("coldter")).pipe(Effect.result),
    );

    expect(Result.isFailure(result)).toBe(true);

    if (Result.isFailure(result)) {
      const failure = result.failure;

      expect(failure).toBeInstanceOf(GithubUpstream);

      if (Schema.is(GithubUpstream)(failure)) {
        expect(failure.status).toBe(500);
      }
    }
  });
});

describe("GithubClient.listStarPage", () => {
  it("decodes star+json items, the etag map and Link pagination", async () => {
    let seen: HttpClientRequest.HttpClientRequest | undefined;

    const page = await runClient(
      (request) => {
        seen = request;

        return jsonResponse(
          [
            { starred_at: "2026-07-09T00:00:00Z", repo: repoJson(1, "one") },
            { starred_at: "2026-07-10T00:00:00Z", repo: repoJson(2, "two") },
          ],
          200,
          {
            etag: '"abc"',
            link:
              '<https://api.github.com/user/1/starred?per_page=100&page=2>; rel="next", ' +
              '<https://api.github.com/user/1/starred?per_page=100&page=4>; rel="last"',
            "x-ratelimit-remaining": "4321",
            "x-ratelimit-reset": "1900000000",
          },
        );
      },
      GithubClient.use((client) => client.listStarPage("coldter", { page: 1 })),
    );

    expect(page.notModified).toBe(false);
    expect(page.repos).toHaveLength(2);
    expect(page.repos[0]?.starredAt).toBe("2026-07-09T00:00:00Z");
    expect(page.starredAt.get(2)).toBe("2026-07-10T00:00:00Z");
    expect(page.etag).toBe('"abc"');
    expect(page.nextPage).toBe(2);
    expect(page.rateLimitRemaining).toBe(4321);
    expect(page.rateLimitResetAt).toBe(new Date(1_900_000_000 * 1000).toISOString());

    const url = new URL(seen!.url);
    expect(url.pathname).toBe("/users/coldter/starred");
    expect(url.searchParams.get("per_page")).toBe("100");
    expect(url.searchParams.get("sort")).toBe("created");
    expect(url.searchParams.get("direction")).toBe("asc");
    expect(requestHeader(seen!, "accept")).toBe("application/vnd.github.star+json");
  });

  it("returns notModified for a free 304 and preserves the etag", async () => {
    let seen: HttpClientRequest.HttpClientRequest | undefined;

    const page = await runClient(
      (request) => {
        seen = request;

        return textResponse("", 304, {
          etag: '"old-etag"',
          "x-ratelimit-remaining": "4999",
        });
      },
      GithubClient.use((client) => client.listStarPage("coldter", { page: 3, etag: '"old-etag"' })),
    );

    expect(page.notModified).toBe(true);
    expect(page.repos).toEqual([]);
    expect(page.starredAt.size).toBe(0);
    expect(page.etag).toBe('"old-etag"');
    expect(page.nextPage).toBeUndefined();
    expect(page.rateLimitRemaining).toBe(4999);
    expect(requestHeader(seen!, "if-none-match")).toBe('"old-etag"');
  });

  it("maps a 404 star listing to UserNotFound", async () => {
    const result = await runClient(
      () => textResponse("not found", 404),
      GithubClient.use((client) => client.listStarPage("gone", { page: 1 })).pipe(Effect.result),
    );

    expect(Result.isFailure(result)).toBe(true);

    if (Result.isFailure(result)) {
      expect(result.failure).toBeInstanceOf(UserNotFound);
    }
  });
});

describe("GithubClient.getReadme", () => {
  it("returns the first successful raw probe", async () => {
    const requests: string[] = [];

    const readme = await runClient(
      (request) => {
        requests.push(request.url);

        if (request.url.endsWith("/README.md")) return textResponse("# Hello");

        return textResponse("missing", 404);
      },
      GithubClient.use((client) => client.getReadme("owner/repo", "main")),
    );

    expect(readme).toEqual({ text: "# Hello", source: "raw" });
    expect(requests).toHaveLength(1);
  });

  it("falls back to the REST readme endpoint after all raw misses", async () => {
    const requests: HttpClientRequest.HttpClientRequest[] = [];

    const readme = await runClient(
      (request) => {
        requests.push(request);

        if (request.url.startsWith("https://raw.githubusercontent.com/")) {
          return textResponse("missing", 404);
        }

        return textResponse("# Fallback", 200, {
          "content-type": "text/plain",
        });
      },
      GithubClient.use((client) => client.getReadme("owner/repo", "main")),
    );

    expect(readme).toEqual({ text: "# Fallback", source: "rest" });
    expect(requests).toHaveLength(6);
    const fallback = requests[5];
    expect(fallback?.url).toBe("https://api.github.com/repos/owner/repo/readme");
    expect(requestHeader(fallback!, "accept")).toBe("application/vnd.github.raw");
  });

  it("returns null when the REST fallback is a 404", async () => {
    const readme = await runClient(
      (request) =>
        request.url.startsWith("https://raw.githubusercontent.com/")
          ? textResponse("missing", 404)
          : textResponse("not found", 404),
      GithubClient.use((client) => client.getReadme("owner/repo", "main")),
    );

    expect(readme).toBeNull();
  });

  it("keeps probing, and falls back to REST, when the raw CDN drops the connection", async () => {
    const requests: HttpClientRequest.HttpClientRequest[] = [];

    const readme = await runClient(
      (request) => {
        requests.push(request);

        if (request.url.startsWith("https://raw.githubusercontent.com/")) return droppedConnection;

        return textResponse("# Fallback", 200, { "content-type": "text/plain" });
      },
      GithubClient.use((client) => client.getReadme("owner/repo", "main")),
    );

    expect(readme).toEqual({ text: "# Fallback", source: "rest" });
    // Five raw candidates, then the one-request REST fallback: a dropped
    // connection is retried along the same ladder as a 404.
    expect(requests).toHaveLength(6);
  });

  it("answers from a later raw candidate when an earlier one drops", async () => {
    const readme = await runClient(
      (request) => {
        if (request.url.endsWith("/README.md")) return droppedConnection;

        if (request.url.endsWith("/readme.md")) return textResponse("# Lowercase");

        return textResponse("missing", 404);
      },
      GithubClient.use((client) => client.getReadme("owner/repo", "main")),
    );

    expect(readme).toEqual({ text: "# Lowercase", source: "raw" });
  });

  it("reports the dropped connection rather than calling a README missing", async () => {
    const result = await runClient(
      (request) =>
        request.url.startsWith("https://raw.githubusercontent.com/")
          ? droppedConnection
          : textResponse("not found", 404),
      Effect.result(GithubClient.use((client) => client.getReadme("owner/repo", "main"))),
    );

    expect(Result.isFailure(result)).toBe(true);

    if (Result.isFailure(result)) {
      const failure = result.failure;

      expect(failure).toBeInstanceOf(GithubUpstream);

      if (Schema.is(GithubUpstream)(failure)) {
        // Status 0 is the client's "we never reached GitHub": the refresh
        // workflow keys its per-repo skip off exactly this, so a connection
        // failure must never look like a 404 ("no README") instead.
        expect(failure.status).toBe(0);
      }
    }
  });
});

describe("GithubClient.listGroups", () => {
  it("decodes public lists, skips private ones and slugs names", async () => {
    const requests: HttpClientRequest.HttpClientRequest[] = [];

    const groups = await runClient(
      (request) => {
        requests.push(request);

        return jsonResponse({
          data: {
            user: {
              lists: {
                pageInfo: { hasNextPage: false, endCursor: "L1" },
                nodes: [
                  {
                    id: "UL_1",
                    name: "Rust / Tools",
                    isPrivate: false,
                    items: {
                      pageInfo: { hasNextPage: false, endCursor: null },
                      nodes: [{ databaseId: 11 }, null, { databaseId: 12 }],
                    },
                  },
                  {
                    id: "UL_2",
                    name: "Private",
                    isPrivate: true,
                    items: {
                      pageInfo: { hasNextPage: false, endCursor: null },
                      nodes: [{ databaseId: 99 }],
                    },
                  },
                ],
              },
            },
          },
        });
      },
      GithubClient.use((client) => client.listGroups("coldter")),
    );

    expect(groups).toEqual([
      {
        id: "UL_1",
        name: "Rust / Tools",
        slug: "rust-tools",
        position: 0,
        repoIds: [11, 12],
      },
    ]);
    expect(requests[0]?.method).toBe("POST");
    expect(requests[0]?.url).toBe("https://api.github.com/graphql");
    const body = requestJsonBody(requests[0]!);
    expect(body?.query).toContain("lists(first: 100");
    expect(body?.query).toContain("items(first: 100");
  });

  it("paginates list items through the node query", async () => {
    const groups = await runClient(
      (request) => {
        const body = requestJsonBody(request);

        if (body?.query?.includes("StarwatchListItems")) {
          return jsonResponse({
            data: {
              node: {
                items: {
                  pageInfo: { hasNextPage: false, endCursor: "I2" },
                  nodes: [{ databaseId: 2 }],
                },
              },
            },
          });
        }

        return jsonResponse({
          data: {
            user: {
              lists: {
                pageInfo: { hasNextPage: false, endCursor: "L1" },
                nodes: [
                  {
                    id: "UL_big",
                    name: "Big",
                    isPrivate: false,
                    items: {
                      pageInfo: { hasNextPage: true, endCursor: "I1" },
                      nodes: [{ databaseId: 1 }],
                    },
                  },
                ],
              },
            },
          },
        });
      },
      GithubClient.use((client) => client.listGroups("coldter")),
    );

    expect(groups).toEqual([
      { id: "UL_big", name: "Big", slug: "big", position: 0, repoIds: [1, 2] },
    ]);
  });

  it("maps GraphQL errors to GithubUpstream", async () => {
    const result = await runClient(
      () => jsonResponse({ errors: [{ message: "Something exploded" }] }),
      GithubClient.use((client) => client.listGroups("coldter")).pipe(Effect.result),
    );

    expect(Result.isFailure(result)).toBe(true);

    if (Result.isFailure(result)) {
      const failure = result.failure;

      expect(failure).toBeInstanceOf(GithubUpstream);

      if (Schema.is(GithubUpstream)(failure)) {
        expect(failure.message).toBe("Something exploded");
      }
    }
  });

  it("maps an unknown user GraphQL error to UserNotFound", async () => {
    const result = await runClient(
      () =>
        jsonResponse({
          errors: [
            {
              message: "Could not resolve to a User with the login of 'nobody'.",
            },
          ],
        }),
      GithubClient.use((client) => client.listGroups("nobody")).pipe(Effect.result),
    );

    expect(Result.isFailure(result)).toBe(true);

    if (Result.isFailure(result)) {
      expect(result.failure).toBeInstanceOf(UserNotFound);
    }
  });
});
