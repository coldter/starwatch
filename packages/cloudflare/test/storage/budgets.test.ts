import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { budgetDay, DAILY_SYNC_TRIGGERS_PER_IP, SyncBudget } from "../../src/storage/budgets.ts";
import { applyMigration, makeSqliteLayer } from "./support.ts";

const IP = "203.0.113.7";

const testLive = () => SyncBudget.layer.pipe(Layer.provideMerge(makeSqliteLayer()));

const seeded = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    yield* applyMigration;

    return yield* effect;
  });

/** Attempts in order, for the `allowed`/`used` sequences asserted below. */
const attempts = (
  ip: string,
  day: string,
  limit: number,
  times: number,
): Effect.Effect<
  ReadonlyArray<{ readonly allowed: boolean; readonly used: number }>,
  SqlError,
  SyncBudget
> =>
  Effect.gen(function* () {
    const budget = yield* SyncBudget;
    const out: Array<{ allowed: boolean; used: number }> = [];

    for (let index = 0; index < times; index++) {
      const result = yield* budget.consume(ip, day, limit);

      out.push({ allowed: result.allowed, used: result.used });
    }

    return out;
  });

describe("SyncBudget", () => {
  it.effect("allows exactly `limit` attempts, then refuses while still counting", () =>
    seeded(attempts(IP, "2026-09-17", 2, 4)).pipe(
      Effect.tap((results) =>
        Effect.sync(() => {
          expect(results).toEqual([
            { allowed: true, used: 1 },
            { allowed: true, used: 2 },
            { allowed: false, used: 3 },
            { allowed: false, used: 4 },
          ]);
        }),
      ),
      Effect.provide(testLive()),
    ),
  );

  it.effect("isolates counters per ip and per day", () =>
    seeded(
      Effect.gen(function* () {
        const budget = yield* SyncBudget;

        expect(yield* budget.consume(IP, "2026-09-17", 1)).toEqual({
          allowed: true,
          used: 1,
          limit: 1,
        });

        // Same day, other caller: unaffected.
        expect(yield* budget.consume("198.51.100.4", "2026-09-17", 1)).toEqual({
          allowed: true,
          used: 1,
          limit: 1,
        });

        // Same caller, next UTC day: a fresh window.
        expect(yield* budget.consume(IP, "2026-09-18", 1)).toEqual({
          allowed: true,
          used: 1,
          limit: 1,
        });

        // The first caller is still spent for the first day.
        expect((yield* budget.consume(IP, "2026-09-17", 1)).allowed).toBe(false);
      }),
    ).pipe(Effect.provide(testLive())),
  );

  it.effect("keeps counting monotonically across the refusal boundary", () =>
    seeded(
      attempts(IP, "2026-09-17", DAILY_SYNC_TRIGGERS_PER_IP, DAILY_SYNC_TRIGGERS_PER_IP + 3),
    ).pipe(
      Effect.tap((results) =>
        Effect.sync(() => {
          const used = results.map((result) => result.used);

          expect(used[0]).toBe(1);
          expect(used.at(-1)).toBe(DAILY_SYNC_TRIGGERS_PER_IP + 3);
          expect(
            used.every((value, index) => index === 0 || value === (used[index - 1] ?? 0) + 1),
          ).toBe(true);
          expect(
            results.slice(0, DAILY_SYNC_TRIGGERS_PER_IP).every((result) => result.allowed),
          ).toBe(true);
          expect(results.slice(DAILY_SYNC_TRIGGERS_PER_IP).every((result) => !result.allowed)).toBe(
            true,
          );
        }),
      ),
      Effect.provide(testLive()),
    ),
  );

  it.effect("refuses everything for a non-positive limit but still records the attempt", () =>
    seeded(
      Effect.gen(function* () {
        const budget = yield* SyncBudget;

        expect(yield* budget.consume(IP, "2026-09-17", 0)).toEqual({
          allowed: false,
          used: 1,
          limit: 0,
        });
        expect(yield* budget.consume(IP, "2026-09-17", 0)).toEqual({
          allowed: false,
          used: 2,
          limit: 0,
        });
      }),
    ).pipe(Effect.provide(testLive())),
  );

  it.effect("reports the budget it decided against", () =>
    seeded(
      Effect.gen(function* () {
        const budget = yield* SyncBudget;

        expect(yield* budget.consume(IP, "2026-09-17", 25)).toEqual({
          allowed: true,
          used: 1,
          limit: 25,
        });
      }),
    ).pipe(Effect.provide(testLive())),
  );
});

describe("budgetDay", () => {
  it.effect("keys the window by UTC date", () =>
    Effect.sync(() => {
      expect(budgetDay(new Date("2026-09-17T23:59:59.999Z"))).toBe("2026-09-17");
      expect(budgetDay(new Date("2026-09-18T00:00:00.000Z"))).toBe("2026-09-18");
      // Local midnight is not the boundary: the window is shared by all callers.
      expect(budgetDay(new Date("2026-09-17T00:00:00.000Z"))).toBe("2026-09-17");
    }),
  );
});
