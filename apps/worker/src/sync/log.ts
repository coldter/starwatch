import type { SyncPhase } from "@starwatch/domain";

/**
 * Minimal run logging for the sync path (docs/08 §2.5).
 *
 * Two levels, deliberately tiny:
 *
 * - `logRun` — informational progress (start, page/batch summaries, finalize).
 *   **Off by default** so a public deployment's Workers Logs carries failures
 *   instead of a line per page and per README batch. `STARWATCH_LOG_RUNS=1`
 *   turns it on for a debugging run.
 * - `logError` — failures: GitHub limits, refused admissions, paused or
 *   crashed runs, partial-batch recoveries. Always emitted on `console.error`,
 *   which Workers Logs captures and `wrangler tail` streams even when the
 *   informational channel is off.
 *
 * One JSON line per event: every line carries the login, the phase, the step
 * name and the counters, so a log search alone can answer "where is this run?"
 * — no sink, no level framework, no allocation beyond the line itself.
 */

let infoEnabled = false;

/** Set once per isolate from the `STARWATCH_LOG_RUNS` binding (worker init). */
export const configureRunLogs = (enabled: boolean): void => {
  infoEnabled = enabled;
};

/** Scalar fields only: anything worth logging is a string, number or boolean. */
export type LogFields = Readonly<Record<string, string | number | boolean | null>>;

type RunFields = LogFields & { readonly login: string; readonly phase: SyncPhase };

const emit = (level: "info" | "error", event: string, fields: RunFields): void => {
  try {
    const line = JSON.stringify({ event, level, at: new Date().toISOString(), ...fields });

    if (level === "error") console.error(line);
    else console.log(line);
  } catch {
    // Logging must never break a run (circular value, huge string, …).
  }
};

/** Informational progress; a no-op unless `STARWATCH_LOG_RUNS=1`. */
export const logRun = (event: string, fields: RunFields): void => {
  if (!infoEnabled) return;

  emit("info", event, fields);
};

/** Failures reach Workers Logs even when informational logs are off. */
export const logError = (event: string, fields: RunFields): void => emit("error", event, fields);

/** Milliseconds since a start stamp, rounded — every line reports its cost. */
export const elapsedMs = (startedAt: number): number => Date.now() - startedAt;
