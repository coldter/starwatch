import { Inbox, LoaderCircle, SearchX } from "lucide-react";
import type { SearchMode } from "@starwatch/domain";
import type { ApiError } from "@/api";
import { useSemanticSearch } from "@/app/capabilities";
import { ThinkingShimmer } from "@/components/agents/loading-states/thinking-shimmer";
import { ErrorPanel, StatePanel } from "@/components/common/StatePanel";
import { Button, ButtonLink } from "@/components/motion/button/base";

/** GitHub's own repository search, for when this index has nothing to offer. */
function githubSearchUrl(query: string): string {
  return `https://github.com/search?type=repositories&q=${encodeURIComponent(query)}`;
}

/**
 * The index is still being read. Keyword results land with the first batch, so
 * this panel promises speed rather than making the reader wait on a spinner.
 */
export function IndexPreparingPanel({ login }: { login: string }) {
  return (
    <div role="status">
      <StatePanel
        icon={LoaderCircle}
        title={`Reading @${login}'s stars…`}
        body="Indexing starts with the star list; READMEs follow."
      >
        <ThinkingShimmer>Results appear as the index loads.</ThinkingShimmer>
      </StatePanel>
    </div>
  );
}

export interface BrowseEmptyPanelProps {
  /** Active filter count; zero means the star list itself is empty. */
  filterCount: number;
  onClearFilters: () => void;
}

/** The browse view matched nothing — either no stars, or filters too narrow. */
export function BrowseEmptyPanel({ filterCount, onClearFilters }: BrowseEmptyPanelProps) {
  const filtered = filterCount > 0;

  return (
    <StatePanel
      icon={Inbox}
      title={filtered ? "No repos match this view" : "No starred repositories yet"}
      body={
        filtered
          ? "The active filters — including an empty collection — are narrowing the list."
          : "Nothing to browse here yet. Re-check GitHub, or search another user."
      }
    >
      {filtered ? (
        <Button variant="outline" size="sm" onClick={onClearFilters}>
          Clear filters
        </Button>
      ) : null}
    </StatePanel>
  );
}

export interface NoResultsPanelProps {
  query: string;
  hasLanguageFilter: boolean;
  hasCollectionFilter: boolean;
  hasStarFilter: boolean;
  canTrySemantic: boolean;
  onClearFilters: () => void;
  onMode: (mode: SearchMode) => void;
}

export function NoResultsPanel({
  query,
  hasLanguageFilter,
  hasCollectionFilter,
  hasStarFilter,
  canTrySemantic,
  onClearFilters,
  onMode,
}: NoResultsPanelProps) {
  const filterActive = hasLanguageFilter || hasCollectionFilter || hasStarFilter;
  // Naming "another search mode" is only advice where a mode choice exists.
  const semanticSearch = useSemanticSearch();

  return (
    <StatePanel
      icon={SearchX}
      title={`No matches for “${query}”`}
      body={
        filterActive
          ? "Filters are narrowing these results."
          : semanticSearch
            ? "Try fewer or shorter words, or another search mode."
            : "Try fewer or shorter words."
      }
    >
      {filterActive ? (
        <Button variant="outline" size="sm" onClick={onClearFilters}>
          Clear filters
        </Button>
      ) : null}
      {canTrySemantic ? (
        <Button variant="outline" size="sm" onClick={() => onMode("semantic")}>
          Try semantic search
        </Button>
      ) : null}
      <ButtonLink
        variant="outline"
        size="sm"
        href={githubSearchUrl(query)}
        target="_blank"
        rel="noreferrer noopener"
      >
        Search GitHub instead
      </ButtonLink>
    </StatePanel>
  );
}

export interface SearchErrorPanelProps {
  error: ApiError;
  canFallbackToKeyword: boolean;
  onRetry: () => void;
  onMode: (mode: SearchMode) => void;
}

export function SearchErrorPanel({
  error,
  canFallbackToKeyword,
  onRetry,
  onMode,
}: SearchErrorPanelProps) {
  return (
    <ErrorPanel title="Search didn't complete" error={error} onRetry={onRetry}>
      {canFallbackToKeyword ? (
        <Button variant="ghost" size="sm" onClick={() => onMode("keyword")}>
          Search keyword-only
        </Button>
      ) : null}
    </ErrorPanel>
  );
}
