import {
  MAX_STARS,
  SEMANTIC_WINDOW,
  SYNC_WINDOW_SECONDS,
  type SyncPhase,
  type UserIndexState,
} from "@starwatch/domain";
import { coveragePercent, formatNumber, percent, plural, relativeTime } from "./format";

/** Phases where work is happening and the UI should follow progress. */
export const ACTIVE_PHASES: ReadonlyArray<SyncPhase> = ["listing", "fetching-readmes", "embedding"];

export function isActivePhase(phase: SyncPhase): boolean {
  return ACTIVE_PHASES.includes(phase);
}

/** Phases that end a sync session (SSE may close). `paused` keeps waiting. */
export function isTerminalPhase(phase: SyncPhase): boolean {
  return phase === "idle" || phase === "ready" || phase === "failed";
}

export function hasIndex(state: UserIndexState | null | undefined): boolean {
  if (!state) return false;

  return state.reposMetadata > 0 || state.lastSyncedAt !== null;
}

const STALE_MS = 24 * 60 * 60 * 1000;

/**
 * How long an active phase may go without a state write before the page calls
 * it stalled — and before its "Start again" button can succeed.
 *
 * Mirrors the worker's `STUCK_LIVE_RUN_MS` (20 min), not its shorter
 * abandonment window: the server only takes an account away from a live
 * `running` instance after this long, so a button that appeared earlier would
 * be answered with `SyncInProgress` every time. Every active-phase writer
 * heartbeats (the star list per page, READMEs per batch, a sleep publishes
 * `paused` first), so this much silence means the run stopped.
 */
export const RUN_HEARTBEAT_MS = 20 * 60_000;

export interface RunHeartbeat {
  /** Milliseconds since the last progress write, or `null` when unsynced. */
  readonly ageMs: number | null;
  /** `ageMs` as a duration, e.g. `8 minutes`; empty when unreadable. */
  readonly ageLabel: string;
  /** Active phase with no progress write for `RUN_HEARTBEAT_MS`. */
  readonly stalled: boolean;
}

/**
 * "Is this run still moving?" — measured on `updatedAt`, which every progress
 * write (and only progress writes) advances. `ageLabel` reads as a duration
 * ("8 minutes"), not a point in time, so a sentence about silence stays
 * grammatical.
 */
export function runHeartbeat(
  state: UserIndexState | null | undefined,
  now: number = Date.now(),
): RunHeartbeat {
  if (!state) return { ageMs: null, ageLabel: "", stalled: false };

  const stamp = Date.parse(state.updatedAt);

  if (Number.isNaN(stamp)) return { ageMs: null, ageLabel: "", stalled: false };

  const ageMs = Math.max(0, now - stamp);
  const minutes = Math.max(1, Math.round(ageMs / 60_000));

  return {
    ageMs,
    ageLabel: `${minutes} ${plural(minutes, "minute")}`,
    stalled: isActivePhase(state.phase) && ageMs > RUN_HEARTBEAT_MS,
  };
}

export function isStale(
  state: UserIndexState | null | undefined,
  now: number = Date.now(),
): boolean {
  if (!state || state.lastSyncedAt === null) return true;
  const timestamp = Date.parse(state.lastSyncedAt);

  if (Number.isNaN(timestamp)) return true;

  return now - timestamp > STALE_MS;
}

/** `21h` / `45m` — the remaining part of a window, never `0`. */
const remainingLabel = (ms: number): string => {
  if (ms >= 3_600_000) return `${Math.max(1, Math.round(ms / 3_600_000))}h`;

  return `${Math.max(1, Math.ceil(ms / 60_000))}m`;
};

export interface SyncWindow {
  /** A new run may start now. */
  readonly open: boolean;
  /** When the next run is allowed; `null` while open. */
  readonly nextAt: Date | null;
  /** Short hint for a closed window, e.g. `Next refresh in 21h`. */
  readonly label: string;
}

const openWindow = (): SyncWindow => ({ open: true, nextAt: null, label: "" });

/**
 * The per-account sync window (docs/08 §2.2, `SYNC_WINDOW_SECONDS`): one run per
 * account per day, whichever visitor asks. Mirrors the worker's admission so a
 * control is never disabled where the API would accept it — and vice versa.
 *
 * It closes for a **settled** index only: phase `ready` or `idle` with a
 * `lastSyncedAt` inside the window. Every other phase (`listing`,
 * `fetching-readmes`, `embedding`, `paused`, `failed`) means the last attempt
 * did *not* finish — a GitHub limit, a platform kill, a crash — and the worker
 * exempts exactly those, because blocking them for a day turns one bad run into
 * a day-long outage. So this must not test for an active phase either: a
 * `paused` row can be a run that is alive and waiting out a rate limit, and
 * that phase is what {@link isActivePhase} deliberately excludes.
 *
 * "A run is executing right now" is a different question, answered by
 * {@link isActivePhase} in the header's button state — never by the window.
 */
export function syncWindow(
  state: UserIndexState | null | undefined,
  now: number = Date.now(),
): SyncWindow {
  if (!state || state.lastSyncedAt === null) return openWindow();

  if (state.phase !== "ready" && state.phase !== "idle") return openWindow();

  const syncedAt = Date.parse(state.lastSyncedAt);

  if (Number.isNaN(syncedAt)) return openWindow();

  const nextAt = new Date(syncedAt + SYNC_WINDOW_SECONDS * 1000);

  if (now >= nextAt.getTime()) return openWindow();

  return {
    open: false,
    nextAt,
    label: `Next refresh in ${remainingLabel(nextAt.getTime() - now)}`,
  };
}

/**
 * Sentence tail for a refusal the server answered with `retry-after`, e.g.
 * `in 21h`. `null` when the server sent no wait, so callers keep their own copy.
 */
export function syncWaitLabel(retryAfterSeconds: number | null): string | null {
  if (retryAfterSeconds === null || retryAfterSeconds <= 0) return null;

  return `in ${remainingLabel(retryAfterSeconds * 1000)}`;
}

/** Metadata is searchable but no vectors exist yet. */
export function isMetadataOnly(state: UserIndexState | null | undefined): boolean {
  if (!state) return false;

  return hasIndex(state) && state.semanticDocs === 0;
}

/** Repos that belong in the semantic window (docs/14: newest 1,500). */
export function semanticWindow(state: UserIndexState): number {
  if (state.starsTotal <= 0) return SEMANTIC_WINDOW;

  return Math.min(state.starsTotal, SEMANTIC_WINDOW);
}

/** 0..100 semantic coverage for this user's index. */
export function semanticCoverage(state: UserIndexState | null | undefined): number {
  if (!state || !hasIndex(state)) return 0;

  return percent(state.semanticDocs, semanticWindow(state));
}

/** 0..100 progress for the currently active phase. */
export function phaseProgress(state: UserIndexState | null | undefined): number {
  if (!state) return 0;

  switch (state.phase) {
    case "listing":
      return percent(state.reposMetadata, state.starsTotal);
    case "fetching-readmes":
      return percent(state.readmesFetched, state.starsTotal);
    case "embedding":
      return percent(state.semanticDocs, semanticWindow(state));
    default:
      return state.phase === "ready" ? 100 : 0;
  }
}

export type FreshnessTone = "none" | "active" | "fresh" | "stale" | "paused" | "failed";

export interface Freshness {
  tone: FreshnessTone;
  /** Short chip label, e.g. `Indexed 2h ago`. */
  label: string;
  /** Sentence used in the sync panel / tooltip. */
  detail: string;
}

const PHASE_LABEL: Record<SyncPhase, string> = {
  idle: "Idle",
  listing: "Loading stars",
  "fetching-readmes": "Fetching READMEs",
  embedding: "Semantic indexing",
  ready: "Ready",
  failed: "Indexing failed",
  paused: "Paused",
};

export function phaseLabel(phase: SyncPhase, semanticSearch = true): string {
  // A stored `embedding` row can outlive a flag flip: with semantic search off
  // the run is simply finishing the README pass, not embedding anything.
  if (!semanticSearch && phase === "embedding") return "Finishing indexing";

  return PHASE_LABEL[phase];
}

/** The header freshness chip (docs/08 §3.4). */
export function freshness(
  state: UserIndexState | null | undefined,
  now: number = Date.now(),
  semanticSearch = true,
): Freshness {
  if (!state) {
    return {
      tone: "none",
      label: "Not indexed yet",
      detail: semanticSearch
        ? "Indexing takes about 10 seconds for metadata; semantic search fills in after."
        : "Indexing reads the public star list first; search works as soon as it lands.",
    };
  }

  switch (state.phase) {
    case "listing":
      return {
        tone: "active",
        label: `Loading stars ${formatNumber(state.reposMetadata)}/${formatNumber(state.starsTotal)}`,
        detail: "Search works as soon as the list is in.",
      };
    case "fetching-readmes":
      return {
        tone: "active",
        label: `Fetching READMEs ${formatNumber(state.readmesFetched)}/${formatNumber(state.starsTotal)}`,
        detail: "Metadata search already works; results get better as READMEs land.",
      };
    case "embedding":
      return semanticSearch
        ? {
            tone: "active",
            label: `Indexing ${semanticCoverage(state)}%`,
            detail: `Semantic covers ${formatNumber(state.semanticDocs)}/${formatNumber(semanticWindow(state))} repos (newest first).`,
          }
        : {
            tone: "active",
            label: "Finishing indexing",
            detail: "Wrapping up the run that was already in flight.",
          };
    case "paused":
      return {
        tone: "paused",
        label: "Paused",
        detail:
          state.lastError ?? "Waiting on GitHub's rate limit. Indexing resumes automatically.",
      };
    case "failed":
      return {
        tone: "failed",
        label: "Indexing failed",
        detail: state.lastError ?? "Retrying automatically. Metadata search still works.",
      };
    case "ready":
    case "idle":
    default: {
      if (!hasIndex(state)) {
        return {
          tone: "none",
          label: "Not indexed yet",
          detail: semanticSearch
            ? "Metadata search in ~10 seconds. Semantic search fills in over the next few minutes."
            : "Indexing reads the public star list first; search works as soon as it lands.",
        };
      }

      const stale = isStale(state, now);
      const stars = `${formatNumber(state.starsTotal)} ${plural(state.starsTotal, "star")}`;

      return {
        tone: stale ? "stale" : "fresh",
        label: `Indexed ${relativeTime(state.lastSyncedAt, now)}`,
        detail: semanticSearch
          ? `${stars} · semantic ${coveragePercent(semanticCoverage(state))}%${stale ? " — may be missing recent stars" : ""}`
          : `${stars}${stale ? " — may be missing recent stars" : ""}`,
      };
    }
  }
}

export function freshnessGlyph(tone: FreshnessTone): string {
  switch (tone) {
    case "active":
      return "◐";
    case "paused":
      return "⏸";
    case "failed":
      return "⚠";
    case "stale":
      return "⚠";
    case "fresh":
      return "●";
    default:
      return "◦";
  }
}

/** Are we above the docs/14 star cap for a full listing? */
export function exceedsStarCap(state: UserIndexState | null | undefined): boolean {
  return state !== null && state !== undefined && state.starsTotal > MAX_STARS;
}
