import { BudgetExceeded } from "@starwatch/domain";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import { StarwatchApi } from "../api.ts";
import { runSearch } from "../search/search-service.ts";
import { clientIp, normalizeLogin, parseFilters, parseLimit, parseMode } from "./http.ts";
import type { WorkerDeps } from "./types.ts";

export const searchGroup = (deps: WorkerDeps) =>
  HttpApiBuilder.group(StarwatchApi, "search", (handlers) =>
    handlers.handle("searchRepos", ({ params, query, request }) =>
      Effect.gen(function* () {
        const ip = clientIp(request);
        const allowed = yield* deps.searchRate.limit({ key: `search:${ip}` }).pipe(
          Effect.matchEffect({
            onSuccess: (result) => Effect.succeed(result.success),
            onFailure: () => Effect.succeed(true)
          })
        );
        if (!allowed) {
          return yield* new BudgetExceeded({
            scope: "search",
            message: "Search rate limit reached; retry in a minute."
          });
        }

        return yield* runSearch(
          {
            login: normalizeLogin(params.login),
            query: query.q,
            mode: parseMode(query.mode),
            filters: parseFilters(query),
            limit: parseLimit(query.limit)
          },
          { vectorFiles: deps.vectorFiles }
        ).pipe(Effect.orDie, Effect.provide(deps.searchLayer));
      })
    )
  );
