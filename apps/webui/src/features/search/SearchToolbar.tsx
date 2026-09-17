import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { ArrowUpDown, Info, Search, SlidersHorizontal } from "lucide-react";
import type { SearchMode, SearchSort } from "@starwatch/domain";
import { useSemanticSearch } from "@/app/capabilities";
import { NoticeStrip } from "@/components/common/StatePanel";
import { Button } from "@/components/motion/button/base";
import { Input } from "@/components/motion/input";
import { Loader } from "@/components/motion/loader";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/motion/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/motion/tabs";
import { Tooltip } from "@/components/motion/tooltip";
import { SEARCH_MODE_LABELS, SORT_HINTS, SORT_LABELS, SORTS } from "@/lib/search-params";

export interface SearchToolbarProps {
  value: string;
  busy: boolean;
  /** No query yet: hide the retrieval modes, which need text to mean anything. */
  browsing: boolean;
  mode: SearchMode;
  sort: SearchSort;
  filterCount: number;
  filtersOpen: boolean;
  onSubmit: (query: string) => void;
  onMode: (mode: SearchMode) => void;
  onSort: (sort: SearchSort) => void;
  onToggleFilters: () => void;
}

interface ModeOption {
  value: SearchMode;
  hint: string;
}

/** One entry per retrieval mode, with the sentence the tooltip explains it with. */
const MODE_OPTIONS: ReadonlyArray<ModeOption> = [
  {
    value: "auto",
    hint: "Picks the best mode per query.",
  },
  {
    value: "keyword",
    hint: "Matches exact words in names, descriptions, topics and READMEs.",
  },
  {
    value: "hybrid",
    hint: "Keyword matches re-ranked by meaning.",
  },
  {
    value: "semantic",
    hint: "Meaning search over indexed READMEs.",
  },
];

export function SearchToolbar({
  value,
  busy,
  browsing,
  mode,
  sort,
  filterCount,
  filtersOpen,
  onSubmit,
  onMode,
  onSort,
  onToggleFilters,
}: SearchToolbarProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState(value);
  // A keyword-only deployment has no mode to pick, so the whole segment row is
  // removed rather than disabled — the same shape browse mode already ships.
  const semanticSearch = useSemanticSearch();

  // The URL is the committed query; the draft follows it until the user types.
  useEffect(() => {
    setDraft(value);
  }, [value]);

  // The command palette focuses this field through the window event, so no
  // other surface needs to know the input's DOM node.
  useEffect(() => {
    const focusSearch = () => inputRef.current?.focus();

    window.addEventListener("starwatch:focus-search", focusSearch);

    return () => window.removeEventListener("starwatch:focus-search", focusSearch);
  }, []);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    onSubmit(draft.trim());
  };

  const onInputKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Escape") return;

    event.currentTarget.blur();
  };

  const onModeChange = (next: string) => {
    const option = MODE_OPTIONS.find((entry) => entry.value === next);

    if (option !== undefined) onMode(option.value);
  };

  const onSortChange = (next: string) => {
    const option = SORTS.find((entry) => entry === next);

    if (option !== undefined) onSort(option);
  };

  // `relevance` is the search default; without a query the worker reads it as
  // "recently starred", so offering it here would be a no-op that resets the
  // view. The browse rail keeps only the keys that actually order a list.
  const sortOptions = browsing ? SORTS.filter((entry) => entry !== "relevance") : SORTS;

  return (
    <form
      role="search"
      aria-busy={busy}
      onSubmit={submit}
      className="flex flex-col gap-3 rounded-2xl border border-border bg-card p-3 sm:p-4"
    >
      <div className="flex items-center gap-2">
        <Input
          ref={inputRef}
          type="search"
          value={draft}
          onChange={setDraft}
          onKeyDown={onInputKeyDown}
          aria-label="Search starred repositories"
          data-search-input=""
          placeholder="Search descriptions, topics, READMEs…"
          leftIcon={<Search aria-hidden="true" />}
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          className="min-w-0 flex-1"
          classNames={{ field: "bg-background" }}
        />
        <Button type="submit" size="sm" className="shrink-0">
          {busy ? (
            <>
              <Loader
                variant="dots"
                size={12}
                label="Searching"
                className="text-primary-foreground"
              />
              Searching
            </>
          ) : (
            "Search"
          )}
        </Button>
      </div>

      {/* The one place the deployment's retrieval capability is stated. A
          keyword-only deployment has no mode row to explain itself, and this
          is a fact about the whole page, not a footnote to the sort control. */}
      {semanticSearch ? null : (
        <NoticeStrip icon={Info}>
          Semantic search is disabled on this deployment, so results come from names, descriptions,
          topics and READMEs.
        </NoticeStrip>
      )}

      <div className="flex flex-col gap-3 border-t border-border pt-3 sm:flex-row sm:items-center sm:justify-between">
        {browsing || !semanticSearch ? null : (
          <Tabs
            value={mode}
            onValueChange={onModeChange}
            variant="segment"
            className="min-w-0 sm:flex-1"
          >
            <TabsList className="max-w-full overflow-x-auto bg-muted">
              {MODE_OPTIONS.map((option) => (
                <Tooltip key={option.value} content={option.hint} side="bottom">
                  <TabsTrigger value={option.value}>{SEARCH_MODE_LABELS[option.value]}</TabsTrigger>
                </Tooltip>
              ))}
            </TabsList>
          </Tabs>
        )}

        <div className="flex items-center justify-between gap-2 sm:justify-end">
          {/* Sorting is part of the search identity (URL state), not a filter:
              it also works on its own, with no query typed. */}
          <div className="flex items-center gap-1.5">
            <ArrowUpDown className="size-3.5 text-muted-foreground" aria-hidden="true" />
            <Tooltip content={SORT_HINTS[sort]} side="bottom">
              <Select value={sort} onValueChange={onSortChange}>
                <SelectTrigger ariaLabel="Sort results" className="h-8 w-[11.5rem] text-xs">
                  <SelectValue placeholder={SORT_LABELS.relevance} />
                </SelectTrigger>
                <SelectContent>
                  {sortOptions.map((option) => (
                    <SelectItem key={option} value={option}>
                      {SORT_LABELS[option]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Tooltip>
          </div>

          <Button
            variant="ghost"
            size="sm"
            data-filters-trigger=""
            className="shrink-0 lg:hidden"
            aria-expanded={filtersOpen}
            onClick={onToggleFilters}
          >
            <SlidersHorizontal className="size-3.5" aria-hidden="true" />
            Filters{filterCount > 0 ? ` (${filterCount})` : ""}
          </Button>
        </div>
      </div>
    </form>
  );
}
