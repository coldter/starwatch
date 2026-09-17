import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { Search, SlidersHorizontal } from "lucide-react";
import type { SearchMode } from "@starwatch/domain";
import { Button } from "@/components/motion/button/base";
import { Input } from "@/components/motion/input";
import { Loader } from "@/components/motion/loader";
import { Tabs, TabsList, TabsTrigger } from "@/components/motion/tabs";
import { Tooltip } from "@/components/motion/tooltip";
import { SEARCH_MODE_LABELS } from "@/lib/search-params";

export interface SearchToolbarProps {
  value: string;
  busy: boolean;
  mode: SearchMode;
  filterCount: number;
  filtersOpen: boolean;
  onSubmit: (query: string) => void;
  onMode: (mode: SearchMode) => void;
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
    hint: "starwatch picks the strategy for this query.",
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
    hint: "Searches meaning over the READMEs indexed for this user.",
  },
];

export function SearchToolbar({
  value,
  busy,
  mode,
  filterCount,
  filtersOpen,
  onSubmit,
  onMode,
  onToggleFilters,
}: SearchToolbarProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState(value);

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

      <div className="flex items-center justify-between gap-2 border-t border-border pt-3">
        <Tabs
          value={mode}
          onValueChange={onModeChange}
          variant="segment"
          className="min-w-0 flex-1"
        >
          <TabsList className="max-w-full overflow-x-auto bg-muted">
            {MODE_OPTIONS.map((option) => (
              <Tooltip key={option.value} content={option.hint} side="bottom">
                <TabsTrigger value={option.value}>{SEARCH_MODE_LABELS[option.value]}</TabsTrigger>
              </Tooltip>
            ))}
          </TabsList>
        </Tabs>

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
    </form>
  );
}
