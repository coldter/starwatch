import { MAX_STARS, SEMANTIC_WINDOW, type SyncPhase, type UserIndexState } from "@starwatch/domain";
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

export function isStale(
  state: UserIndexState | null | undefined,
  now: number = Date.now(),
): boolean {
  if (!state || state.lastSyncedAt === null) return true;
  const timestamp = Date.parse(state.lastSyncedAt);

  if (Number.isNaN(timestamp)) return true;

  return now - timestamp > STALE_MS;
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

export function phaseLabel(phase: SyncPhase): string {
  return PHASE_LABEL[phase];
}

/** The header freshness chip (docs/08 §3.4). */
export function freshness(
  state: UserIndexState | null | undefined,
  now: number = Date.now(),
): Freshness {
  if (!state) {
    return {
      tone: "none",
      label: "Not indexed yet",
      detail: "Indexing takes about 10 seconds for metadata; semantic search fills in after.",
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
      return {
        tone: "active",
        label: `Indexing ${semanticCoverage(state)}%`,
        detail: `Semantic covers ${formatNumber(state.semanticDocs)}/${formatNumber(semanticWindow(state))} repos (newest first).`,
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
        detail: state.lastError ?? "We'll retry automatically. Metadata search still works.",
      };
    case "ready":
    case "idle":
    default: {
      if (!hasIndex(state)) {
        return {
          tone: "none",
          label: "Not indexed yet",
          detail:
            "Metadata search in ~10 seconds. Semantic search fills in over the next few minutes.",
        };
      }

      const stale = isStale(state, now);

      return {
        tone: stale ? "stale" : "fresh",
        label: `Indexed ${relativeTime(state.lastSyncedAt, now)}`,
        detail: `${formatNumber(state.starsTotal)} ${plural(state.starsTotal, "star")} · semantic ${coveragePercent(semanticCoverage(state))}%${stale ? " — may be missing recent stars" : ""}`,
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
