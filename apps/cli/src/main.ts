/**
 * starwatch CLI — public service edition.
 *
 * There is no login and no token: every read is anonymous and user-scoped
 * commands take `-u, --user <login>` (or `STARWATCH_USER`). See
 * `docs/08-public-service-ux.md` §5.1 for the deltas from the self-host spec.
 */
import { Console, Effect, Option } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";
import { FetchHttpClient, HttpClient } from "effect/unstable/http";
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import {
  ApiError,
  CLI_VERSION,
  CliInputError,
  NoResultsError,
  getHealth,
  getRepoPage,
  getSyncState,
  getUserPage,
  searchStars,
  startSync
} from "./api.ts";
import {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  normalizeLogin,
  parseRepoShorthand,
  resolveApiUrl,
  resolveUser,
  splitCommaValues,
  validateLimit
} from "./config.ts";
import {
  renderEmptyHint,
  renderError,
  renderGroups,
  renderHealth,
  renderJson,
  renderRepoPage,
  renderSearch,
  renderSearchPlain,
  renderSearchSummary,
  renderStatusPage,
  renderSyncProgress,
  renderSyncStart,
  renderSyncState,
  resolveWidth,
  shouldUseColor
} from "./render.ts";
import type { UserIndexState } from "@starwatch/domain";

// Effect's Node layer runs on a real Node process; the CLI only needs `env`,
// `stdout.isTTY` and `stdout.columns`, so a minimal ambient shape keeps this
// package independent of @types/node.
declare const process: {
  readonly env: Record<string, string | undefined>;
  readonly stdout: {
    readonly isTTY?: boolean | undefined;
    readonly columns?: number | undefined;
  };
};

/** Poll cadence / cap for `sync --wait` (task contract: 2 s, 10 min). */
const SYNC_POLL_INTERVAL = "2 seconds";

const SYNC_POLL_TIMEOUT_MS = 10 * 60 * 1_000;

// ---------------------------------------------------------------------------
// Shared flags
// ---------------------------------------------------------------------------

const userFlag = Flag.string("user").pipe(
  Flag.withAlias("u"),
  Flag.withDescription("GitHub login whose stars to search (env: STARWATCH_USER)"),
  Flag.withDefault("")
);

const apiFlag = Flag.string("api").pipe(
  Flag.withDescription("API base URL (env: STARWATCH_API_URL)"),
  Flag.withDefault("")
);

const jsonFlag = Flag.boolean("json").pipe(
  Flag.withDescription("Print the raw JSON response"),
  Flag.withDefault(false)
);

const apiUrlOf = (flag: string): string => resolveApiUrl(flag, process.env["STARWATCH_API_URL"]);

const outputColor = (json: boolean, plain: boolean): boolean =>
  !json && !plain && shouldUseColor(process.stdout, process.env);

const outputWidth = (): number => resolveWidth(process.stdout.columns, process.env["COLUMNS"]);

const requireUser = (flagValue: string): Effect.Effect<string, CliInputError> => {
  const login = resolveUser(flagValue, process.env["STARWATCH_USER"]);

  return login === undefined
    ? Effect.fail(
        new CliInputError({
          message: "Missing --user.",
          hint: "Specify whose stars to search, e.g. --user alice (or set STARWATCH_USER)."
        })
      )
    : Effect.succeed(login);
};

const requireLogin = (candidate: string): Effect.Effect<string, CliInputError> => {
  const login = normalizeLogin(candidate);

  return login === ""
    ? Effect.fail(
        new CliInputError({
          message: "Missing GitHub login.",
          hint: "Pass the login, e.g. starwatch status alice."
        })
      )
    : Effect.succeed(login);
};

// ---------------------------------------------------------------------------
// search
// ---------------------------------------------------------------------------

const search = Command.make(
  "search",
  {
    query: Argument.string("query").pipe(
      Argument.withDescription("Search query; multiple words are joined with spaces"),
      Argument.variadic({ min: 1 })
    ),
    user: userFlag,
    mode: Flag.choice("mode", ["auto", "keyword", "hybrid", "semantic"] as const).pipe(
      Flag.withDescription("Retrieval mode (auto routes server-side)"),
      Flag.withDefault("auto")
    ),
    lang: Flag.string("lang").pipe(
      Flag.withDescription("GitHub language filter, case-insensitive"),
      Flag.withDefault("")
    ),
    topic: Flag.string("topic").pipe(
      Flag.atLeast(0),
      Flag.withDescription("Topic filter; repeatable, commas within one value are OR")
    ),
    group: Flag.string("group").pipe(
      Flag.atLeast(0),
      Flag.withDescription("GitHub List filter; repeatable")
    ),
    minStars: Flag.integer("min-stars").pipe(
      Flag.withDescription("Minimum stars (inclusive)"),
      Flag.optional
    ),
    maxStars: Flag.integer("max-stars").pipe(
      Flag.withDescription("Maximum stars (inclusive)"),
      Flag.optional
    ),
    archived: Flag.boolean("archived").pipe(
      Flag.withDescription("Only archived repos (--no-archived excludes them)"),
      Flag.optional
    ),
    license: Flag.string("license").pipe(
      Flag.withDescription("SPDX license id, case-insensitive"),
      Flag.withDefault("")
    ),
    starredAfter: Flag.string("starred-after").pipe(
      Flag.withDescription("Starred on/after this date (YYYY-MM-DD or ISO-8601)"),
      Flag.withDefault("")
    ),
    starredBefore: Flag.string("starred-before").pipe(
      Flag.withDescription("Starred before this date (YYYY-MM-DD or ISO-8601)"),
      Flag.withDefault("")
    ),
    limit: Flag.integer("limit").pipe(
      Flag.withDescription(`Maximum hits, 1-${MAX_LIMIT}`),
      Flag.withDefault(DEFAULT_LIMIT)
    ),
    explain: Flag.boolean("explain").pipe(
      Flag.withDescription("Show retrieval legs and fused score per hit"),
      Flag.withDefault(false)
    ),
    plain: Flag.boolean("plain").pipe(
      Flag.withDescription("Print owner/name per line"),
      Flag.withDefault(false)
    ),
    json: jsonFlag,
    api: apiFlag
  },
  ({
    query,
    user,
    mode,
    lang,
    topic,
    group,
    minStars,
    maxStars,
    archived,
    license,
    starredAfter,
    starredBefore,
    limit,
    explain,
    plain,
    json,
    api
  }) =>
    Effect.gen(function* () {
      const login = yield* requireUser(user);
      const limitError = validateLimit(limit);

      if (limitError !== undefined) {
        return yield* Effect.fail(new CliInputError({ message: limitError }));
      }

      const text = query.join(" ").trim();

      if (text === "") {
        return yield* Effect.fail(
          new CliInputError({
            message: "The query must not be empty.",
            hint: `Example: starwatch search "durable jobs" --user ${login}`
          })
        );
      }

      const response = yield* searchStars(apiUrlOf(api), login, {
        q: text,
        mode,
        lang,
        topics: splitCommaValues(topic),
        groups: splitCommaValues(group),
        minStars: Option.getOrUndefined(minStars),
        maxStars: Option.getOrUndefined(maxStars),
        archived: Option.getOrUndefined(archived),
        license,
        starredAfter,
        starredBefore,
        limit
      });

      if (json) {
        yield* Console.log(renderJson(response));
      } else if (plain) {
        const lines = renderSearchPlain(response);

        if (lines !== "") yield* Console.log(lines);
      } else {
        const output = renderSearch(response, {
          color: outputColor(json, plain),
          width: outputWidth(),
          explain
        });

        if (output !== "") yield* Console.log(output);

        if (response.hits.length > 0) yield* Console.error(renderSearchSummary(response));
      }

      if (response.hits.length === 0) {
        yield* Console.error(renderEmptyHint(text, response.mode));

        return yield* Effect.fail(new NoResultsError({ query: text }));
      }
    })
);

// ---------------------------------------------------------------------------
// show
// ---------------------------------------------------------------------------

const show = Command.make(
  "show",
  {
    repo: Argument.string("repo").pipe(Argument.withDescription("Repository as owner/name")),
    json: jsonFlag,
    api: apiFlag
  },
  ({ repo, json, api }) =>
    Effect.gen(function* () {
      const parsed = parseRepoShorthand(repo);

      if (parsed === undefined) {
        return yield* Effect.fail(
          new CliInputError({
            message: `Expected owner/repo, got "${repo}".`,
            hint: "Example: starwatch show BurntSushi/ripgrep"
          })
        );
      }

      const page = yield* getRepoPage(apiUrlOf(api), parsed.owner, parsed.name);
      yield* Console.log(
        json ? renderJson(page) : renderRepoPage(page, { color: outputColor(json, false) })
      );
    })
);

// ---------------------------------------------------------------------------
// sync
// ---------------------------------------------------------------------------

const pollSync = (
  apiUrl: string,
  login: string
): Effect.Effect<UserIndexState, ApiError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const startedAt = Date.now();
    let state = yield* getSyncState(apiUrl, login);
    let lastLine = "";

    while (state.phase !== "ready" && state.phase !== "failed") {
      if (Date.now() - startedAt >= SYNC_POLL_TIMEOUT_MS) {
        return yield* Effect.fail(
          new ApiError({
            code: "TIMEOUT",
            message: `Timed out after 10 minutes waiting for @${login} (phase ${state.phase}).`,
            hint: `Check progress later with: starwatch status ${login}`
          })
        );
      }

      yield* Effect.sleep(SYNC_POLL_INTERVAL);
      state = yield* getSyncState(apiUrl, login);
      const line = renderSyncProgress(state);

      if (line !== lastLine) {
        lastLine = line;
        yield* Console.error(line);
      }
    }

    return state;
  });

const sync = Command.make(
  "sync",
  {
    login: Argument.string("login").pipe(Argument.withDescription("GitHub login to index")),
    full: Flag.boolean("full").pipe(
      Flag.withDescription("Re-fetch and re-embed everything, ignoring ETags"),
      Flag.withDefault(false)
    ),
    wait: Flag.boolean("wait").pipe(
      Flag.withDescription("Poll every 2 s until ready/failed (10 min cap)"),
      Flag.withDefault(false)
    ),
    json: jsonFlag,
    api: apiFlag
  },
  ({ login, full, wait, json, api }) =>
    Effect.gen(function* () {
      const target = yield* requireLogin(login);
      const apiUrl = apiUrlOf(api);
      const start = yield* startSync(apiUrl, target, full);

      if (json) {
        if (!wait) yield* Console.log(renderJson(start));
      } else {
        yield* Console.error(renderSyncStart(start));
      }

      if (!wait) return;

      const finalState = yield* pollSync(apiUrl, target);

      if (json) {
        yield* Console.log(renderJson(finalState));
      } else {
        yield* Console.log(renderSyncState(finalState));
      }

      if (finalState.phase === "failed") {
        return yield* Effect.fail(
          new ApiError({
            code: "SYNC_FAILED",
            message: `Indexing @${target} failed.`,
            hint: finalState.lastError ?? `Re-run: starwatch sync ${target}`
          })
        );
      }
    })
);

// ---------------------------------------------------------------------------
// status / groups / health
// ---------------------------------------------------------------------------

const status = Command.make(
  "status",
  {
    login: Argument.string("login").pipe(Argument.withDescription("GitHub login to inspect")),
    json: jsonFlag,
    api: apiFlag
  },
  ({ login, json, api }) =>
    Effect.gen(function* () {
      const target = yield* requireLogin(login);
      const page = yield* getUserPage(apiUrlOf(api), target);
      yield* Console.log(
        json ? renderJson(page) : renderStatusPage(page, { color: outputColor(json, false) })
      );
    })
);

const groups = Command.make(
  "groups",
  {
    login: Argument.string("login").pipe(Argument.withDescription("GitHub login whose GitHub Lists to list")),
    json: jsonFlag,
    api: apiFlag
  },
  ({ login, json, api }) =>
    Effect.gen(function* () {
      const target = yield* requireLogin(login);
      const page = yield* getUserPage(apiUrlOf(api), target);
      yield* Console.log(json ? renderJson(page.groups) : renderGroups(page.groups));
    })
);

const health = Command.make(
  "health",
  { json: jsonFlag, api: apiFlag },
  ({ json, api }) =>
    Effect.gen(function* () {
      const apiUrl = apiUrlOf(api);
      const result = yield* getHealth(apiUrl);
      yield* Console.log(json ? renderJson(result) : renderHealth(result, apiUrl));

      if (!result.ok) {
        return yield* Effect.fail(
          new ApiError({
            code: "UNHEALTHY",
            message: "The starwatch API reported that it is not healthy."
          })
        );
      }
    })
);

// ---------------------------------------------------------------------------
// Root command + runner
// ---------------------------------------------------------------------------

const HELP = [
  "starwatch — search anyone's public GitHub stars.",
  "",
  "Commands:",
  "  search <query>     Search a user's stars (requires --user)",
  "  show <owner/repo>  Detail for one indexed repo",
  "  sync <login>       Start (or attach to) an indexing run",
  "  status <login>     Index state and coverage",
  "  groups <login>     GitHub Lists imported for a user",
  "  health             API reachability",
  "",
  "Run `starwatch <command> --help` for flags."
].join("\n");

const cli = Command.make("starwatch", {}, () => Console.log(HELP)).pipe(
  Command.withDescription("Search anyone's public GitHub stars"),
  Command.withSubcommands([search, show, sync, status, groups, health])
);

const reportError = <E extends ApiError | CliInputError>(error: E): Effect.Effect<never, E> =>
  Effect.gen(function* () {
    yield* Console.error(renderError(error));

    return yield* Effect.fail(error);
  });

export const main = Command.run(cli, { version: CLI_VERSION }).pipe(
  Effect.catchTags({
    ApiError: reportError,
    CliInputError: reportError
  }),
  Effect.provide(NodeServices.layer),
  Effect.provide(FetchHttpClient.layer)
);

NodeRuntime.runMain(main);
