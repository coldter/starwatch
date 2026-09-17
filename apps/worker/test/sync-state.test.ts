import { describe, expect, it } from "@effect/vitest";
import { RepoStore } from "@starwatch/cloudflare/storage";
import { Effect, Layer } from "effect";
import {
  applyMigration,
  makeSqliteLayer,
  makeUser,
} from "../../../packages/cloudflare/test/storage/support.ts";
import { MAX_RATE_LIMIT_WAIT_MS } from "../src/sync/rate-limit.ts";
import {
  STUCK_QUEUED_RUN_MS,
  isRunAbandoned,
  isRunIncomplete,
  isRunStuck,
  patchState,
  shouldTakeOver,
  STALE_RUN_MS,
  STUCK_LIVE_RUN_MS,
} from "../src/sync/state.ts";

/**
 * `patchState` is the only writer of `user_index_state`, and the sync start
 * path leans on one property of it: stamping `phase: "listing"` must make the
 * run visible as *active* without disturbing `last_synced_at`.
 *
 * That ordering matters to the UI. A client opens the events stream right after
 * `POST /sync`; if the stored row is still terminal at that moment, the client
 * stops watching and the finished run's fresh `last_synced_at` never reaches
 * the freshness chip. `last_synced_at` is also the cooldown anchor (docs/08
 * §2.2), so a starting run must not reset it either.
 */

const LOGIN = "coldter";

const testLive = () => RepoStore.layer.pipe(Layer.provideMerge(makeSqliteLayer()));

const seeded = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    yield* applyMigration;
    const repos = yield* RepoStore;

    yield* repos.upsertUser(makeUser(LOGIN));

    return yield* effect;
  });

const readState = Effect.gen(function* () {
  const repos = yield* RepoStore;

  return yield* repos.getIndexState(LOGIN);
});

describe("patchState during a sync", () => {
  it.effect("makes a starting run visible as active before any other write", () =>
    seeded(
      Effect.gen(function* () {
        yield* patchState(LOGIN, { phase: "listing", lastError: null });
        const state = yield* readState;

        expect(state?.phase).toBe("listing");
        expect(state?.lastSyncedAt).toBeNull();
      }),
    ).pipe(Effect.provide(testLive())),
  );

  it.effect("keeps the previous successful stamp when a re-list starts", () =>
    seeded(
      Effect.gen(function* () {
        yield* patchState(LOGIN, {
          phase: "ready",
          lastSyncedAt: "2026-01-01T00:00:00.000Z",
        });
        yield* patchState(LOGIN, { phase: "listing", lastError: null });
        const state = yield* readState;

        expect(state?.phase).toBe("listing");
        expect(state?.lastSyncedAt).toBe("2026-01-01T00:00:00.000Z");
      }),
    ).pipe(Effect.provide(testLive())),
  );

  it.effect("advances the stamp when the run finalizes", () =>
    seeded(
      Effect.gen(function* () {
        yield* patchState(LOGIN, {
          phase: "ready",
          lastSyncedAt: "2026-01-01T00:00:00.000Z",
          lastError: "earlier failure",
        });
        yield* patchState(LOGIN, {
          phase: "ready",
          lastSyncedAt: "2026-02-02T00:00:00.000Z",
          lastError: null,
        });
        const state = yield* readState;

        expect(state?.phase).toBe("ready");
        expect(state?.lastSyncedAt).toBe("2026-02-02T00:00:00.000Z");
        expect(state?.lastError).toBeNull();
      }),
    ).pipe(Effect.provide(testLive())),
  );
});

describe("isRunAbandoned", () => {
  const now = Date.parse("2026-09-17T12:00:00.000Z");

  const beat = (minutesAgo: number) => ({
    phase: "fetching-readmes" as const,
    updatedAt: new Date(now - minutesAgo * 60_000).toISOString(),
  });

  it("trusts a run the engine still reports alive, however quiet", () => {
    expect(isRunAbandoned(beat(60), true, now)).toBe(false);
  });

  it("trusts a fresh heartbeat while the run is starting up", () => {
    expect(isRunAbandoned(beat(0), false, now)).toBe(false);
  });

  it("calls a quiet, dead run abandoned so it can be restarted", () => {
    expect(isRunAbandoned(beat(6), false, now)).toBe(true);
  });

  it("treats an unreadable stamp as not abandoned", () => {
    expect(isRunAbandoned({ phase: "listing", updatedAt: "nonsense" }, false, now)).toBe(false);
  });

  it("keeps the stall threshold well above one heartbeat interval", () => {
    expect(STALE_RUN_MS).toBeGreaterThan(2 * 60_000);
  });
});

describe("isRunStuck", () => {
  const now = Date.parse("2026-09-17T12:00:00.000Z");

  const rows = (minutesAgo: number) => ({
    phase: "listing" as const,
    updatedAt: new Date(now - minutesAgo * 60_000).toISOString(),
  });

  it("ignores a run that is not live — that is abandonment, not a stuck step", () => {
    expect(isRunStuck(rows(60), false, now)).toBe(false);
  });

  it("believes a live instance while it is still heartbeating", () => {
    expect(isRunStuck(rows(1), true, now)).toBe(false);
  });

  it("calls a live-but-silent instance stuck past the step ceiling", () => {
    expect(isRunStuck(rows(30), true, now)).toBe(true);
  });

  it("keeps the stuck ceiling well above the abandonment window", () => {
    expect(STUCK_LIVE_RUN_MS).toBeGreaterThan(STALE_RUN_MS);
  });
});

describe("isRunIncomplete (the 24-hour window exemption)", () => {
  it("treats a settled index as complete", () => {
    expect(isRunIncomplete({ phase: "ready" })).toBe(false);
    expect(isRunIncomplete({ phase: "idle" })).toBe(false);
  });

  it("exempts every phase that means the last attempt did not finish", () => {
    for (const phase of ["listing", "fetching-readmes", "embedding", "paused", "failed"] as const) {
      expect(isRunIncomplete({ phase })).toBe(true);
    }
  });

  it("has no opinion about an account with no row at all", () => {
    expect(isRunIncomplete(null)).toBe(false);
  });
});

describe("shouldTakeOver", () => {
  const now = Date.parse("2026-09-17T12:00:00.000Z");

  const row = (minutesAgo: number) => ({
    phase: "listing" as const,
    updatedAt: new Date(now - minutesAgo * 60_000).toISOString(),
  });

  it("waits out the abandonment window before replacing a missing run", () => {
    // A fresh stamp with no instance means "starting up, or the probe failed".
    expect(shouldTakeOver(row(0), { live: false, status: null }, now)).toBe(false);
    expect(shouldTakeOver(row(6), { live: false, status: null }, now)).toBe(true);
  });

  it("leaves a healthy running instance alone", () => {
    expect(shouldTakeOver(row(1), { live: true, status: "running" }, now)).toBe(false);
  });

  it("takes over a running instance that stopped heartbeating", () => {
    expect(shouldTakeOver(row(30), { live: true, status: "running" }, now)).toBe(true);
  });

  it("lets a queued instance wait for capacity, but not forever", () => {
    // A queued run has not executed a step yet, so a stale stamp is expected —
    // until it stops being plausible that the engine will ever pick it up.
    expect(shouldTakeOver(row(30), { live: true, status: "queued" }, now)).toBe(false);
    expect(shouldTakeOver(row(120), { live: true, status: "queued" }, now)).toBe(true);
    expect(shouldTakeOver(row(120), { live: true, status: "waiting" }, now)).toBe(true);
  });

  it("keeps the queue tolerance well above the stuck window", () => {
    expect(STUCK_QUEUED_RUN_MS).toBeGreaterThan(STUCK_LIVE_RUN_MS);
  });
});

describe("stuck-run threshold vs rate-limit sleeps", () => {
  it("keeps the stuck window above the longest sleep a run may take", () => {
    // A sleeping run publishes `paused` and then writes nothing for the whole
    // wait while the engine still reports `running`; a threshold at or below
    // the wait would terminate a run that is merely waiting.
    expect(STUCK_LIVE_RUN_MS).toBeGreaterThan(MAX_RATE_LIMIT_WAIT_MS);
  });
});
