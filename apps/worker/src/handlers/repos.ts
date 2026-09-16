import { RepoNotFound } from "@starwatch/domain";
import { RepoStore } from "@starwatch/cloudflare/storage";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import { StarwatchApi } from "../api.ts";
import type { WorkerDeps } from "./types.ts";

export const reposGroup = (deps: WorkerDeps) =>
  HttpApiBuilder.group(StarwatchApi, "repos", (handlers) =>
    handlers.handle("getRepo", ({ params }) =>
      Effect.gen(function* () {
        const fullName = `${params.owner}/${params.name}`;
        const repos = yield* RepoStore;
        const repo = yield* repos.getRepoByFullName(fullName).pipe(Effect.orDie);

        if (repo === null) return yield* new RepoNotFound({ fullName });
        // Groups are per-login and the route carries no login context, so the
        // repo owner's imported Lists are the only sensible attribution.
        const ownerGroups = yield* repos.listGroups(repo.owner).pipe(Effect.orDie);

        return {
          repo,
          groups: ownerGroups.filter((group) => group.repoIds.includes(repo.id))
        };
      }).pipe(Effect.provide(deps.sync.storage))
    )
  );
