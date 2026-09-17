import { describe, expect, it } from "@effect/vitest";
import { RepoStore } from "@starwatch/cloudflare/storage";
import { Effect, Layer } from "effect";
import {
  applyMigration,
  makeSqliteLayer,
  makeUser,
} from "../../packages/cloudflare/test/storage/support.ts";
import { patchState } from "../src/sync/state.ts";

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
