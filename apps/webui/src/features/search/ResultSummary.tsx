import type { DegradedReason, SearchResponse, SearchSort } from "@starwatch/domain";
import { NoticeStrip } from "@/components/common/StatePanel";
import { Loader } from "@/components/motion/loader";
import { coveragePercent, formatNumber, plural } from "@/lib/format";
import { SEARCH_MODE_LABELS, SORT_LABELS } from "@/lib/search-params";

export interface ResultSummaryProps {
  response: SearchResponse;
  status: "loading" | "refreshing" | "ready" | "error";
  semanticDocs: number;
  /** Active ordering, so a query-less browse line can name it. */
  sort: SearchSort;
}

/** What the response's degraded flag means for the reader, in one sentence. */
const DEGRADED_COPY: Record<DegradedReason, string> = {
  "keyword-only": "Semantic search is unavailable right now, so these are keyword results.",
  "semantic-window": "Semantic results cover only the newest indexed repos.",
  "rate-limited": "Results may be incomplete while GitHub rate limits are in effect.",
};

export function ResultSummary({ response, status, semanticDocs, sort }: ResultSummaryProps) {
  // An empty response query is the browse path: there is no retrieval mode and
  // no semantic coverage to report, only the ordering the reader picked.
  const browse = response.query.length === 0;

  return (
    <div className="flex flex-col gap-2">
      <p
        aria-live="polite"
        className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground tabular-nums"
      >
        <span>
          {formatNumber(response.total)} {plural(response.total, "result")}
        </span>
        <span aria-hidden="true">·</span>
        <span>{formatNumber(response.tookMs)} ms</span>
        {browse ? (
          <>
            <span aria-hidden="true">·</span>
            <span>sorted by {SORT_LABELS[sort].toLowerCase()}</span>
          </>
        ) : (
          <>
            <span aria-hidden="true">·</span>
            <span>{SEARCH_MODE_LABELS[response.mode]} mode</span>
            {semanticDocs > 0 ? (
              <>
                <span aria-hidden="true">·</span>
                <span>semantic coverage {coveragePercent(response.semanticCoverage)}%</span>
              </>
            ) : null}
          </>
        )}
        {status === "refreshing" ? (
          <span className="inline-flex items-center gap-1.5 text-foreground">
            <Loader variant="dots" size={12} label="Searching" />
            Searching
          </span>
        ) : null}
      </p>

      {response.degraded && !browse ? (
        <NoticeStrip>{DEGRADED_COPY[response.degraded]}</NoticeStrip>
      ) : null}
    </div>
  );
}
