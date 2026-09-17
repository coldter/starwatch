import type { DegradedReason, SearchResponse } from "@starwatch/domain";
import { NoticeStrip } from "@/components/common/StatePanel";
import { Loader } from "@/components/motion/loader";
import { coveragePercent, formatNumber } from "@/lib/format";
import { SEARCH_MODE_LABELS } from "@/lib/search-params";

export interface ResultSummaryProps {
  response: SearchResponse;
  status: "idle" | "loading" | "refreshing" | "ready" | "error";
  semanticDocs: number;
}

/** What the response's degraded flag means for the reader, in one sentence. */
const DEGRADED_COPY: Record<DegradedReason, string> = {
  "keyword-only": "Semantic search is unavailable right now, so these are keyword results.",
  "semantic-window": "Semantic results cover only the newest indexed repos.",
  "rate-limited": "Results may be incomplete while GitHub rate limits are in effect.",
};

export function ResultSummary({ response, status, semanticDocs }: ResultSummaryProps) {
  return (
    <div className="flex flex-col gap-2">
      <p
        aria-live="polite"
        className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground tabular-nums"
      >
        <span>{formatNumber(response.hits.length)} results</span>
        <span aria-hidden="true">·</span>
        <span>{formatNumber(response.tookMs)} ms</span>
        <span aria-hidden="true">·</span>
        <span>{SEARCH_MODE_LABELS[response.mode]} mode</span>
        {semanticDocs > 0 ? (
          <>
            <span aria-hidden="true">·</span>
            <span>semantic coverage {coveragePercent(response.semanticCoverage)}%</span>
          </>
        ) : null}
        {status === "refreshing" ? (
          <span className="inline-flex items-center gap-1.5 text-foreground">
            <Loader variant="dots" size={12} label="Searching" />
            Searching
          </span>
        ) : null}
      </p>

      {response.degraded ? <NoticeStrip>{DEGRADED_COPY[response.degraded]}</NoticeStrip> : null}
    </div>
  );
}
