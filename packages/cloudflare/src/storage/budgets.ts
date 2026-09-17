import { Context, Effect, Layer, Schema } from "effect";
import type { SqlError } from "effect/unstable/sql/SqlError";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { nowIso } from "./sql.ts";

/**
 * Per-IP daily budget for sync triggers (migration 0003, docs/14 §4).
 *
 * The burst limiter in front of `POST /users/:login/sync` is a runtime
 * rate-limit binding: it absorbs double-clicks and refresh-hammering for a
 * minute. It cannot express "this caller gets 50 attempts today", because each
 * attempt costs GitHub quota indirectly and the free tier is shared by every
 * anonymous visitor. This service is that second, coarser gate.
 *
 * One statement per attempt: `INSERT ... ON CONFLICT DO UPDATE ... RETURNING
 * count` both records the attempt and answers whether it is within budget. D1
 * has no transactions, so the counter is the only shared truth; because the
 * increment happens before the decision, the stored count is what actually
 * happened rather than what was allowed (the caller can then log refusals).
 */

/** Sync triggers allowed per IP per UTC day (docs/14 §4). */
export const DAILY_SYNC_TRIGGERS_PER_IP = 50;

/**
 * New accounts indexed per UTC day, across every caller (docs/14 §4: "≤10
 * weighted new users/day"). A per-IP counter cannot express this: fifty
 * callers can each stay inside their own budget while together exceeding the
 * free tier's GitHub and Workers AI allowances. Consumed only when the account
 * has no index yet — re-checks of known accounts are covered by that account's
 * own window.
 */
export const DAILY_NEW_USERS = 10;

/**
 * Counter key for budgets that are global rather than per caller. IPs are
 * validated upstream (`cf-connecting-ip`), so a reserved word cannot collide
 * with a real caller.
 */
export const GLOBAL_BUDGET_KEY = "__global__";

/** UTC date key for the budget window; the same function defines the boundary. */
export const budgetDay = (now: Date): string => now.toISOString().slice(0, 10);

/** Post-increment outcome of one attempt. */
export interface SyncBudgetResult {
  /** Whether this attempt is within `limit` (`used <= limit`). */
  readonly allowed: boolean;
  /** Attempts recorded for this ip/day, *including* this one. */
  readonly used: number;
  /** Budget the decision was made against. */
  readonly limit: number;
}

/** Row shape of the `RETURNING` clause, post-`camelize`. */
export const SyncBudgetRow = Schema.Struct({ count: Schema.Number });

export type SyncBudgetRow = typeof SyncBudgetRow.Type;

export interface SyncBudgetService {
  /**
   * Count one attempt and answer whether it is within budget.
   *
   * `ip` must already be normalized (the handler passes `clientIp`, whose
   * fallback is the literal `"unknown"`, so all unattributable callers share
   * one bucket). A non-positive `limit` refuses every attempt — a kill switch
   * that still counts, which is what an operator wants during an incident.
   */
  readonly consume: (
    ip: string,
    day: string,
    limit: number,
  ) => Effect.Effect<SyncBudgetResult, SqlError>;
}

export class SyncBudget extends Context.Service<SyncBudget, SyncBudgetService>()("SyncBudget") {
  static readonly layer = Layer.effect(
    SyncBudget,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      const consume = Effect.fn("SyncBudget.consume")(function* (
        ip: string,
        day: string,
        limit: number,
      ) {
        const effectiveLimit = Math.max(0, Math.floor(limit));

        const rows = yield* sql<SyncBudgetRow>`
          INSERT INTO sync_budget (ip, day, count, first_seen, updated_at)
          VALUES (${ip}, ${day}, 1, ${nowIso()}, ${nowIso()})
          ON CONFLICT(ip, day) DO UPDATE SET
            count = count + 1,
            updated_at = excluded.updated_at
          RETURNING count
        `;

        const row = rows[0];
        const used = row === undefined ? 0 : Schema.decodeUnknownSync(SyncBudgetRow)(row).count;

        return {
          allowed: used <= effectiveLimit,
          used,
          limit: effectiveLimit,
        } satisfies SyncBudgetResult;
      });

      return SyncBudget.of({ consume });
    }),
  );
}
