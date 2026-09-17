import type { SyncPhase } from "@starwatch/domain";

/**
 * Minimal run logging for the sync workflows (docs/08 §2.5).
 *
 * One JSON line per event on `console.log`, which Workers Logs captures and
 * `wrangler tail` streams. The point is to answer "where is this run?" from a
 * log search alone: every line carries the login, the phase, the step name and
 * the counters, and rate-limit waits carry what GitHub told us.
 *
 * Deliberately tiny: no levels, no sinks, no allocation beyond the line itself
 * — the free tier's log budget is real, so call sites stay coarse (start,
 * wait, page/batch summaries, finalize, failure).
 */

/** Scalar fields only: anything worth logging is a string, number or boolean. */
export type LogFields = Readonly<Record<string, string | number | boolean | null>>;

/** Event names are dotted and greppable: `starwatch.sync.page`. */
export const logRun = (
  event: string,
  fields: LogFields & { readonly login: string; readonly phase: SyncPhase },
): void => {
  try {
    console.log(JSON.stringify({ event, at: new Date().toISOString(), ...fields }));
  } catch {
    // Logging must never break a run (circular value, huge string, …).
  }
};

/** Milliseconds since a start stamp, rounded — every line reports its cost. */
export const elapsedMs = (startedAt: number): number => Date.now() - startedAt;
