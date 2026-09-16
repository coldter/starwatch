import type { UserIndexState } from "@starwatch/domain";
import type { SyncTransport } from "../hooks/useUserIndex";
import { formatDateTime, formatNumber } from "../lib/format";
import { isActivePhase, isMetadataOnly, phaseLabel, phaseProgress, semanticWindow } from "../lib/state";

export interface SyncBannerProps {
  state: UserIndexState | null | undefined;
  transport: SyncTransport;
  busy: boolean;
  onStart: (options?: { full?: boolean }) => void;
}

interface ActiveCounts {
  done: number;
  total: number;
}

function activeCounts(state: UserIndexState): ActiveCounts {
  switch (state.phase) {
    case "listing":
      return { done: state.reposMetadata, total: state.starsTotal };
    case "fetching-readmes":
      return { done: state.readmesFetched, total: state.starsTotal };
    case "embedding":
      return { done: state.semanticDocs, total: semanticWindow(state) };
    default:
      return { done: 0, total: 0 };
  }
}

/**
 * In-page sync banner (docs/08 §2.4). Announced via aria-live so screen
 * readers hear phase changes without the page stealing focus.
 */
export function SyncBanner({ state, transport, busy, onStart }: SyncBannerProps) {
  if (!state) return null;

  const active = isActivePhase(state.phase);
  const metadataOnly = isMetadataOnly(state);
  const show = active || state.phase === "paused" || state.phase === "failed" || metadataOnly;

  if (!show) return null;

  const { done, total } = activeCounts(state);
  const progress = phaseProgress(state);

  return (
    <section className={`sync-banner sync-banner--${state.phase}`} aria-live="polite" aria-busy={active}>
      {active ? (
        <>
          <div className="sync-banner__line">
            <span className="sync-banner__label">
              <span aria-hidden="true">◐</span> {phaseLabel(state.phase)} · {formatNumber(done)}/
              {formatNumber(total)}
            </span>
            {transport === "polling" ? (
              <span className="sync-banner__transport">live updates paused — checking every 5s</span>
            ) : (
              <span className="sync-banner__transport">{progress}%</span>
            )}
          </div>
          <div
            className="progress"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={progress}
            aria-label={`${phaseLabel(state.phase)} progress`}
          >
            <div className="progress__bar" style={{ width: `${progress}%` }} />
          </div>
          <p className="sync-banner__hint">
            {state.phase === "fetching-readmes" || state.phase === "embedding"
              ? "Search stays fully usable — results get better as we finish."
              : "Search works as soon as the list is in."}
          </p>
        </>
      ) : null}

      {state.phase === "paused" ? (
        <div className="sync-banner__line">
          <span className="sync-banner__label">
            <span aria-hidden="true">⏸</span> Waiting on GitHub&apos;s rate limit
          </span>
          {state.lastError ? <span className="sync-banner__transport">{state.lastError}</span> : null}
        </div>
      ) : null}

      {state.phase === "failed" ? (
        <div className="sync-banner__line">
          <span className="sync-banner__label">
            <span aria-hidden="true">⚠</span> Indexing hit a snag
          </span>
          <button type="button" className="btn btn--small" onClick={() => onStart({ full: true })} disabled={busy}>
            {busy ? "Retrying…" : "Retry now"}
          </button>
        </div>
      ) : null}

      {metadataOnly && !active ? (
        <div className="sync-banner__line">
          <span className="sync-banner__label">
            <span aria-hidden="true">◦</span> Metadata search only
          </span>
          <button type="button" className="btn btn--small" onClick={() => onStart({ full: false })} disabled={busy}>
            {busy ? "Starting…" : "Enable semantic indexing"}
          </button>
        </div>
      ) : null}

      {state.lastError && !active && state.phase !== "paused" && state.phase !== "failed" ? (
        <p className="sync-banner__hint">
          Last attempt: {state.lastError}
          {state.lastSyncedAt ? ` · last success ${formatDateTime(state.lastSyncedAt)}` : ""}
        </p>
      ) : null}
    </section>
  );
}
