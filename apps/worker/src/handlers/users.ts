import {
  BudgetExceeded,
  DEFAULT_SYNC_COOLDOWNS,
  isActiveSyncPhase,
  SyncCooldown,
  SyncInProgress,
  type ListsInfo,
  type SyncPhase,
  type UserIndexState,
  UserNotFound,
} from "@starwatch/domain";
import { canSync, GithubClient } from "@starwatch/core/sync";
import { activeRunState, ownerRunState, terminateActiveRuns } from "../sync/liveness.ts";
import { logError, logRun } from "../sync/log.ts";
import { isRunIncomplete, patchState, shouldTakeOver } from "../sync/state.ts";
import {
  budgetDay,
  DAILY_NEW_USERS,
  DAILY_SYNC_TRIGGERS_PER_IP,
  GLOBAL_BUDGET_KEY,
  RepoStore,
  SyncBudget,
} from "@starwatch/cloudflare/storage";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Exit from "effect/Exit";
import * as Stream from "effect/Stream";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import { StarwatchApi } from "../api.ts";
import { LOGIN_PATTERN } from "../constants.ts";
import { hashIp, idleState, clientIp, normalizeLogin, parseTime } from "./http.ts";
import { describeGithubError, nowIso } from "../sync/state.ts";
import type { WorkerDeps } from "./types.ts";

/**
 * Per-user routes. Every handler resolves the storage layer per request (the
 * Worker init phase cannot build layers: plan-time has no bindings) and maps
 * storage failures to defects -> HTTP 500.
 */

/**
 * Hide the stored semantic counter when this deployment runs without semantic
 * search. The column itself keeps its value — flipping the flag back on must
 * find every vector where the last on-run left it — but the capability is not
 * part of the wire contract, so the API reports zero rather than a number the
 * client has to know to ignore.
 */
const hideSemanticDocs = (state: UserIndexState, semanticSearch: boolean): UserIndexState =>
  semanticSearch || state.semanticDocs === 0 ? state : { ...state, semanticDocs: 0 };

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
          const lists = yield* repos.getListsInfo(login).pipe(Effect.orDie);

          return {
            profile,
            state: hideSemanticDocs(stored ?? idleState(login), deps.sync.semanticSearch),
            groups,
            lists,
          };
        }).pipe(Effect.provide(deps.sync.storage)),
      )
      .handle("refreshUserGroups", ({ params, request }) =>
        Effect.gen(function* () {
          const ip = clientIp(request);

          const allowed = yield* deps.listsRate.limit({ key: `lists:${ip}` }).pipe(
            Effect.matchEffect({
              onSuccess: (result) => Effect.succeed(result.success),
              onFailure: () => Effect.succeed(true),
            }),
          );

          if (!allowed) {
            return yield* new BudgetExceeded({
              scope: "lists",
              message: "Too many collections refreshes; try again in a minute.",
            });
          }

          const login = normalizeLogin(params.login);

          if (!LOGIN_PATTERN.test(login)) return yield* new UserNotFound({ login });

          const repos = yield* RepoStore;
          const github = yield* GithubClient;
          const checkedAt = nowIso();

          // Collections only exist for an account the index already knows;
          // probing an unknown login would spend a GitHub request on a 404.
          const profile = yield* repos.getUser(login).pipe(Effect.orDie);

          if (profile === null) return yield* new UserNotFound({ login });

          const fetched = yield* github.listGroups(login).pipe(
            Effect.matchEffect({
              onSuccess: (groups) => Effect.succeed({ ok: true as const, groups }),
              onFailure: (error) =>
                Effect.succeed({ ok: false as const, message: describeGithubError(error) }),
            }),
          );

          // A failed read is not an empty account: keep the stored lists and
          // only record why this attempt could not refresh them.
          if (!fetched.ok) {
            const lists: ListsInfo = { state: "error", error: fetched.message, checkedAt };

            yield* repos.putListsInfo(login, lists).pipe(Effect.orDie);
            const groups = yield* repos.listGroups(login).pipe(Effect.orDie);

            logError("starwatch.lists.refresh-failed", {
              login,
              phase: "idle",
              reason: fetched.message,
            });

            return { groups, lists };
          }

          yield* repos.replaceGroups(login, fetched.groups).pipe(Effect.orDie);

          const lists: ListsInfo = {
            state: fetched.groups.length > 0 ? "ok" : "empty",
            error: null,
            checkedAt,
          };

          yield* repos.putListsInfo(login, lists).pipe(Effect.orDie);
          logRun("starwatch.lists.refreshed", {
            login,
            phase: "idle",
            groups: fetched.groups.length,
          });

          return { groups: fetched.groups, lists };
        }).pipe(Effect.provide(deps.sync.runLayers)),
      )
      .handle("startSync", ({ params, payload, request }) =>
        Effect.gen(function* () {
          const ip = clientIp(request);
          const day = budgetDay(new Date());
          // One caller key for both gates, already hashed: the burst limiter and
          // the daily counter should not disagree about who the caller is, and
          // nothing downstream should hold the raw address (docs/14 §3.3).
          const callerKey = yield* Effect.promise(() => hashIp(ip, day));

          const allowed = yield* deps.syncRate.limit({ key: `sync:${callerKey}` }).pipe(
            Effect.matchEffect({
              onSuccess: (result) => Effect.succeed(result.success),
              onFailure: () => Effect.succeed(true),
            }),
          );

          if (!allowed) {
            logError("starwatch.sync.refused", {
              login: normalizeLogin(params.login),
              phase: "idle",
              reason: "burst-limit",
            });

            return yield* new BudgetExceeded({
              scope: "sync",
              message: "Too many sync requests; try again in a minute.",
            });
          }

          const login = normalizeLogin(params.login);

          // Validate before spending anything. An unvalidated login costs a
          // GitHub request that only ends in 404, and cycling garbage logins is
          // the cheapest way to burn the shared quota (docs/14 §3.3).
          if (!LOGIN_PATTERN.test(login)) {
            logError("starwatch.sync.refused", {
              login,
              phase: "idle",
              reason: "invalid-login",
            });

            return yield* new UserNotFound({ login });
          }

          const repos = yield* RepoStore;
          const budget = yield* SyncBudget;

          // Budget before GitHub, not after: the counter has to bound the
          // requests an exhausted caller can still cause, and a login that does
          // not exist yet must be counted like any other attempt.
          const spend = yield* budget
            .consume(callerKey, day, DAILY_SYNC_TRIGGERS_PER_IP)
            .pipe(Effect.orDie);

          if (!spend.allowed) {
            logError("starwatch.sync.refused", {
              login,
              phase: "idle",
              reason: "ip-budget",
              used: spend.used,
              limit: spend.limit,
            });

            return yield* new BudgetExceeded({
              scope: "sync",
              message: `Daily sync limit reached (${spend.limit} per visitor per day).`,
            });
          }

          // First-time indexing: fetch + persist the profile here so a brand
          // new username can be synced without a prior lookup (docs/08 §1).
          let profile = yield* repos.getUser(login).pipe(Effect.orDie);

          if (profile === null) {
            const github = yield* GithubClient;
            const fetched = yield* Effect.exit(github.getUserProfile(login));

            if (Exit.isFailure(fetched)) {
              // Logged, then 404 for a missing user and a 500 for anything
              // else: a storm's own cause must be visible in Workers Logs.
              const reason = fetched.cause.toString();

              logError("starwatch.sync.refused", {
                login,
                phase: "idle",
                reason: "profile-failed",
                error: reason.slice(0, 120),
              });

              return yield* new UserNotFound({ login });
            }

            profile = fetched.value;
            yield* repos.upsertUser(profile).pipe(Effect.orDie);
          }

          const stored = yield* repos.getIndexState(login).pipe(Effect.orDie);
          const full = payload.full === true;

          // The owner is the id the handler recorded (migration 0004); the
          // legacy ids are only a fallback for rows written before it — which
          // is why a row without an owner still probes them below (a sleeping
          // run publishes `paused`, and the active-phase block skips that).
          const owner = yield* repos.getRunInstance(login).pipe(Effect.orDie);

          // An active phase normally means a run owns the index. Trust it only
          // while the engine still reports that run, and only terminate when it
          // has demonstrably stopped — *after* admission, never before, or a
          // refused request could kill a healthy run and leave the row active
          // with nothing behind it.
          let takeover = false;

          if (stored !== null && isActiveSyncPhase(stored.phase)) {
            const run = yield* activeRunState(deps, login, stored.phase, owner);

            if (!shouldTakeOver(stored, run)) {
              logError("starwatch.sync.refused", {
                login,
                phase: stored.phase,
                reason: "in-progress",
                status: run.status,
              });

              return yield* new SyncInProgress({ login });
            }

            takeover = true;
          }

          // A brand-new account costs a full GitHub sweep plus a README and
          // embedding pass, and no per-IP counter can bound the *total*: a
          // hundred visitors can each stay inside their own budget while the
          // shared free tier runs dry (docs/14 §4). Only a first-ever attempt
          // counts: retries of an account that already has a row would drain
          // the service-wide allowance without indexing anything new.
          if (stored === null) {
            const global = yield* budget
              .consume(GLOBAL_BUDGET_KEY, day, DAILY_NEW_USERS)
              .pipe(Effect.orDie);

            if (!global.allowed) {
              logError("starwatch.sync.refused", {
                login,
                phase: "idle",
                reason: "new-user-budget",
                used: global.used,
                limit: global.limit,
              });

              return yield* new BudgetExceeded({
                scope: "new-users",
                message: "New indexes are capped today; try again tomorrow.",
              });
            }
          }

          const lastSyncedMs = parseTime(stored?.lastSyncedAt);

          // One 24-hour window per account (docs/14 §4): both bounds read the
          // same `last_synced_at` stamp, so a re-check cannot slip past the
          // window a full refresh just started.
          //
          // A run that did not *finish* is exempt: a `paused`, `failed` or
          // still-active phase means the previous attempt took the window
          // without producing an index, and blocking it for a day is what turns
          // a transient GitHub limit into a day-long outage.
          const incomplete = isRunIncomplete(stored);

          const admission =
            incomplete || takeover
              ? { allowed: true as const, retryAfterSeconds: 0 }
              : canSync(
                  {
                    inProgress: false,
                    lastRelistAtMs: full ? null : lastSyncedMs,
                    lastFullRefreshAtMs: full ? lastSyncedMs : null,
                  },
                  Date.now(),
                  DEFAULT_SYNC_COOLDOWNS,
                );

          if (!admission.allowed) {
            logError("starwatch.sync.refused", {
              login,
              phase: stored?.phase ?? "idle",
              reason: admission.reason,
              retryAfterSeconds: admission.retryAfterSeconds,
              full,
            });

            return yield* new SyncCooldown({
              login,
              retryAfterSeconds: admission.retryAfterSeconds,
            });
          }

          // Attach to a run that already owns the account. `stored.phase` is
          // not active here, which is how a run sleeping out a rate limit looks:
          // leave its row alone (overwriting "paused" with "listing" would make
          // a waiting run look stalled, and only the paused row escapes the
          // stuck-run check) and hand the client the phase that is really there.
          const attachPhase: SyncPhase = stored?.phase ?? "listing";

          // A recorded owner is the common case; without one (a row from before
          // migration 0004) the legacy ids still have to be probed, otherwise
          // the instance sleeping out a rate limit is invisible.
          const attached =
            owner !== null && owner.length > 0
              ? yield* ownerRunState(deps, owner)
              : yield* activeRunState(deps, login, attachPhase, null);

          // Attaching is only right when the run is alive *and* healthy. A
          // live-but-stuck instance must fall through to the takeover below —
          // checking liveness alone made the stuck branch unreachable and left
          // the panel's "Start again" button permanently failing.
          const takeOverAttached =
            stored !== null && attached.live && shouldTakeOver(stored, attached);

          if (attached.live && !takeOverAttached) {
            logRun("starwatch.sync.attached", {
              login,
              phase: attachPhase,
              instanceId: attached.instanceId,
              status: attached.status,
            });

            return { started: false, phase: attachPhase };
          }

          // A non-live probe is *not* grounds for clearing the record: the probe
          // also fails when the engine is unreachable, and a wipe would invite a
          // duplicate run. The record is replaced by the next successful start.

          const owned = attached.live ? attached.status : null;

          // Terminate only now, with every admission check behind us.
          if ((takeover || takeOverAttached) && stored !== null) {
            const terminated = yield* terminateActiveRuns(deps, login, stored.phase, owner);

            logRun("starwatch.sync.takeover", {
              login,
              phase: stored.phase,
              terminated: terminated.length,
              quietMs: Number.isNaN(Date.parse(stored.updatedAt))
                ? null
                : Date.now() - Date.parse(stored.updatedAt),
            });

            // Whatever the recorded id pointed at is dead — the takeover check
            // proved it, and it has just been terminated. The claim below is a
            // conditional UPDATE on that column, so leaving the stale id would
            // refuse the claim and strand the account in an active phase with
            // no run behind it. Runs that end through a terminal path release
            // their own id; this covers the ones killed before they could.
            yield* repos.setRunInstance(login, null).pipe(Effect.ignore);
          }

          const requestId = crypto.randomUUID();
          // Unique per run. A fixed id collided with instances still inside
          // their retention window, and the fallback id could never be looked
          // up again — the run that owned the account was then invisible to
          // liveness *and* dedupe.
          const instanceId = `listing-${login}-${requestId}`;

          // Claim, then create. Claiming first is fail-closed: if this
          // invocation dies in between, the next request finds a recorded id
          // whose instance does not exist, which probes as "not live" and
          // recovers from. And because the claim is an atomic conditional
          // update, two concurrent requests cannot both start a run.
          yield* patchState(login, { phase: "listing", reposMetadata: 0, lastError: null });

          const claimed = yield* repos.claimRunInstance(login, instanceId).pipe(Effect.orDie);

          if (!claimed) {
            // Another request won the race between our probe and this claim.
            const winner = yield* repos.getRunInstance(login).pipe(Effect.orDie);

            logError("starwatch.sync.refused", {
              login,
              phase: "listing",
              reason: "claim-lost",
              instanceId: winner,
            });

            return { started: false, phase: "listing" as const };
          }

          const created = yield* Effect.exit(
            deps.listing.create({ id: instanceId, params: { login, full, requestId } }),
          );

          if (Exit.isFailure(created)) {
            // Nothing owns the account, so release the id — and settle the row:
            // leaving it `listing` with no owner would answer 409 for the whole
            // abandonment window while the panel offered nothing (the takeover
            // above may have already terminated the previous run).
            yield* repos.setRunInstance(login, null).pipe(Effect.orDie);
            yield* patchState(login, {
              phase: "failed",
              lastError: "The indexing queue rejected the job; try again shortly.",
            });

            logError("starwatch.sync.refused", {
              login,
              phase: "failed",
              reason: "queue-rejected",
            });

            return yield* new BudgetExceeded({
              scope: "sync",
              message: "The indexing queue could not accept this job; try again shortly.",
            });
          }

          logRun("starwatch.sync.started", {
            login,
            phase: "listing",
            full,
            takeover: takeover || takeOverAttached,
            instanceId,
            previousStatus: owned,
          });

          return { started: true, phase: "listing" as const };
        }).pipe(Effect.provide(Layer.mergeAll(deps.sync.storage, deps.sync.github))),
      )
      .handle("getSyncState", ({ params }) =>
        Effect.gen(function* () {
          const login = normalizeLogin(params.login);
          const repos = yield* RepoStore;
          const profile = yield* repos.getUser(login).pipe(Effect.orDie);

          if (profile === null) return yield* new UserNotFound({ login });
          const stored = yield* repos.getIndexState(login).pipe(Effect.orDie);

          return hideSemanticDocs(stored ?? idleState(login), deps.sync.semanticSearch);
        }).pipe(Effect.provide(deps.sync.storage)),
      )
      .handle("syncEvents", ({ params }) =>
        Effect.gen(function* () {
          const login = normalizeLogin(params.login);
          const repos = yield* RepoStore;
          const profile = yield* repos.getUser(login).pipe(Effect.orDie);

          if (profile === null) return yield* new UserNotFound({ login });

          const semantic = deps.sync.semanticSearch;

          const initial = hideSemanticDocs(
            (yield* repos.getIndexState(login).pipe(Effect.orDie)) ?? idleState(login),
            semantic,
          );

          const updates = Stream.tick("1 seconds").pipe(
            // Each tick builds (and closes) its own short-lived layer, so the
            // SSE stream never depends on the request scope being open while
            // it is being consumed.
            Stream.mapEffect(() =>
              Effect.gen(function* () {
                const store = yield* RepoStore;

                const state = yield* store.getIndexState(login).pipe(Effect.orDie);

                return hideSemanticDocs(state ?? initial, semantic);
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
