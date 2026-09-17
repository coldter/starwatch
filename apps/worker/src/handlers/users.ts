import {
  DEFAULT_SYNC_COOLDOWNS,
  BudgetExceeded,
  SyncCooldown,
  SyncInProgress,
  UserNotFound,
} from "@starwatch/domain";
import { canSync, GithubClient } from "@starwatch/core/sync";
import { RepoStore } from "@starwatch/cloudflare/storage";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Exit from "effect/Exit";
import * as Stream from "effect/Stream";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import { StarwatchApi } from "../api.ts";
import { idleState, clientIp, normalizeLogin, parseTime } from "./http.ts";
import type { WorkerDeps } from "./types.ts";

/**
 * Per-user routes. Every handler resolves the storage layer per request (the
 * Worker init phase cannot build layers: plan-time has no bindings) and maps
 * storage failures to defects -> HTTP 500.
 */
export const usersGroup = (deps: WorkerDeps) =>
  HttpApiBuilder.group(StarwatchApi, "users", (handlers) =>
    handlers
      .handle("getUser", ({ params }) =>
        Effect.gen(function* () {
          const login = normalizeLogin(params.login);
          const repos = yield* RepoStore;
          const profile = yield* repos.getUser(login).pipe(Effect.orDie);

          if (profile === null) return yield* new UserNotFound({ login });
          const stored = yield* repos.getIndexState(login).pipe(Effect.orDie);
          const groups = yield* repos.listGroups(login).pipe(Effect.orDie);

          return { profile, state: stored ?? idleState(login), groups };
        }).pipe(Effect.provide(deps.sync.storage)),
      )
      .handle("startSync", ({ params, payload, request }) =>
        Effect.gen(function* () {
          const ip = clientIp(request);

          const allowed = yield* deps.syncRate
            .limit({ key: `sync:${ip}` })
            .pipe(
              Effect.matchEffect({
                onSuccess: (result) => Effect.succeed(result.success),
                onFailure: () => Effect.succeed(true),
              }),
            );

          if (!allowed) {
            return yield* new BudgetExceeded({
              scope: "sync",
              message: "Too many sync requests; try again in a minute.",
            });
          }

          const login = normalizeLogin(params.login);
          const repos = yield* RepoStore;
          // First-time indexing: fetch + persist the profile here so a brand
          // new username can be synced without a prior lookup (docs/08 §1).
          let profile = yield* repos.getUser(login).pipe(Effect.orDie);

          if (profile === null) {
            const github = yield* GithubClient;
            profile = yield* github.getUserProfile(login).pipe(
              Effect.catchTags({
                GithubUpstream: (error) => Effect.die(error),
                GithubRateLimited: (error) => Effect.die(error),
              }),
            );
            yield* repos.upsertUser(profile).pipe(Effect.orDie);
          }

          const stored = yield* repos.getIndexState(login).pipe(Effect.orDie);
          const phase = stored?.phase ?? "idle";

          if (
            phase === "listing" ||
            phase === "fetching-readmes" ||
            phase === "embedding"
          ) {
            return yield* new SyncInProgress({ login });
          }

          const full = payload.full === true;
          const lastSyncedMs = parseTime(stored?.lastSyncedAt);

          const admission = canSync(
            {
              inProgress: false,
              // The single `last_synced_at` stamp backs both windows: relist
              // requests use it as the 15-min bound, full requests as 24 h.
              lastRelistAtMs: full ? null : lastSyncedMs,
              lastFullRefreshAtMs: full ? lastSyncedMs : null,
            },
            Date.now(),
            DEFAULT_SYNC_COOLDOWNS,
          );

          if (!admission.allowed) {
            return yield* new SyncCooldown({
              login,
              retryAfterSeconds: admission.retryAfterSeconds,
            });
          }

          // Dedupe by instance id: attach to a live job, otherwise start one.
          const id = `listing-${login}`;
          const existing = yield* Effect.exit(deps.listing.get(id));

          if (Exit.isSuccess(existing)) {
            const status = yield* Effect.exit(existing.value.status());

            if (Exit.isSuccess(status)) {
              const state = status.value.status;

              if (
                state === "queued" ||
                state === "running" ||
                state === "paused" ||
                state === "waiting" ||
                state === "waitingForPause"
              ) {
                return { started: false, phase: "listing" as const };
              }
            }
          }

          const requestId = crypto.randomUUID();

          let created = yield* Effect.exit(
            deps.listing.create({ id, params: { login, full, requestId } }),
          );

          if (Exit.isFailure(created)) {
            // Terminal instances linger for retention; fall back to a unique
            // id rather than refusing a legitimate cooldown-expired refresh.
            created = yield* Effect.exit(
              deps.listing.create({
                id: `${id}-${Date.now()}`,
                params: { login, full, requestId },
              }),
            );
          }

          if (Exit.isFailure(created)) {
            return yield* new BudgetExceeded({
              scope: "sync",
              message:
                "The indexing queue could not accept this job; try again shortly.",
            });
          }

          return { started: true, phase: "listing" as const };
        }).pipe(
          Effect.provide(Layer.mergeAll(deps.sync.storage, deps.sync.github)),
        ),
      )
      .handle("getSyncState", ({ params }) =>
        Effect.gen(function* () {
          const login = normalizeLogin(params.login);
          const repos = yield* RepoStore;
          const profile = yield* repos.getUser(login).pipe(Effect.orDie);

          if (profile === null) return yield* new UserNotFound({ login });
          const stored = yield* repos.getIndexState(login).pipe(Effect.orDie);

          return stored ?? idleState(login);
        }).pipe(Effect.provide(deps.sync.storage)),
      )
      .handle("syncEvents", ({ params }) =>
        Effect.gen(function* () {
          const login = normalizeLogin(params.login);
          const repos = yield* RepoStore;
          const profile = yield* repos.getUser(login).pipe(Effect.orDie);

          if (profile === null) return yield* new UserNotFound({ login });

          const initial =
            (yield* repos.getIndexState(login).pipe(Effect.orDie)) ??
            idleState(login);

          const updates = Stream.tick("1 seconds").pipe(
            // Each tick builds (and closes) its own short-lived layer, so the
            // SSE stream never depends on the request scope being open while
            // it is being consumed.
            Stream.mapEffect(() =>
              Effect.gen(function* () {
                const store = yield* RepoStore;

                const state = yield* store
                  .getIndexState(login)
                  .pipe(Effect.orDie);

                return state ?? initial;
              }).pipe(Effect.provide(deps.sync.storage)),
            ),
            // 1 initial + 119 ticks ≈ 2 minutes, then the SSE stream closes;
            // clients reconnect with a fresh `GET /sync` (docs/08 §2.5).
            Stream.take(119),
          );

          return Stream.concat(Stream.succeed(initial), updates);
        }).pipe(Effect.provide(deps.sync.storage)),
      )
      .handle("getUserGroups", ({ params }) =>
        Effect.gen(function* () {
          const login = normalizeLogin(params.login);
          const repos = yield* RepoStore;
          const profile = yield* repos.getUser(login).pipe(Effect.orDie);

          if (profile === null) return yield* new UserNotFound({ login });

          return yield* repos.listGroups(login).pipe(Effect.orDie);
        }).pipe(Effect.provide(deps.sync.storage)),
      ),
  );
