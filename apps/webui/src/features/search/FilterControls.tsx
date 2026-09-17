import { X } from "lucide-react";
import { MAX_STARS, type Group } from "@starwatch/domain";
import { LanguageDot } from "@/components/common/LanguageDot";
import { Button } from "@/components/motion/button/base";
import {
  MultiSelect,
  MultiSelectContent,
  MultiSelectEmpty,
  MultiSelectInput,
  MultiSelectItem,
  MultiSelectList,
  MultiSelectTrigger,
  MultiSelectValue,
} from "@/components/motion/multi-select";
import { RangeSlider } from "@/components/motion/range-slider";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/motion/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/motion/tabs";
import { formatCompact } from "@/lib/format";
import { LANGUAGES } from "@/lib/languages";
import {
  hasActiveFilters,
  toArchivedFilter,
  type ArchivedFilter,
  type SearchState,
} from "@/lib/search-params";
import { cn } from "@/lib/utils";

export interface FilterControlsProps {
  state: SearchState;
  groups: ReadonlyArray<Group>;
  disabled?: boolean;
  layout?: "inline" | "sheet";
  onLanguage: (language: string | undefined) => void;
  onToggleGroup: (slug: string) => void;
  onMinStars: (minStars: number | undefined) => void;
  onArchived: (archived: ArchivedFilter) => void;
  onClear: () => void;
}

const LAYOUT_CLASS: Record<"inline" | "sheet", string> = {
  inline:
    "grid grid-cols-1 gap-4 rounded-2xl border border-border bg-card p-4 sm:grid-cols-2 xl:grid-cols-3",
  sheet: "grid grid-cols-1 gap-4",
};

/** The slider announces this instead of a bare number. */
function formatStars(value: number): string {
  if (value === 0) return "Any number of stars";

  return `${formatCompact(value)} stars`;
}

export function FilterControls({
  state,
  groups,
  disabled = false,
  layout = "inline",
  onLanguage,
  onToggleGroup,
  onMinStars,
  onArchived,
  onClear,
}: FilterControlsProps) {
  const stars = state.minStars ?? 0;

  const onLanguageChange = (next: string) => {
    onLanguage(next === "" ? undefined : next);
  };

  const onStarsChange = (next: number) => {
    onMinStars(next > 0 ? next : undefined);
  };

  // MultiSelect reports the whole selection; the page owns one-slug toggling,
  // so hand it the single slug that changed.
  const onGroupsChange = (next: string[]) => {
    for (const slug of next) {
      if (!state.group.includes(slug)) {
        onToggleGroup(slug);

        return;
      }
    }

    for (const slug of state.group) {
      if (!next.includes(slug)) {
        onToggleGroup(slug);

        return;
      }
    }
  };

  return (
    <div className={cn(LAYOUT_CLASS[layout])}>
      <div role="group" aria-label="Language" className="flex min-w-0 flex-col gap-1.5">
        <span className="px-1 text-sm font-medium text-foreground">Language</span>
        <Select value={state.lang ?? ""} onValueChange={onLanguageChange} disabled={disabled}>
          <SelectTrigger>
            <SelectValue placeholder="Any language" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="">Any language</SelectItem>
            {LANGUAGES.map((language) => (
              <SelectItem key={language} value={language}>
                <span className="flex items-center gap-2">
                  <LanguageDot language={language} />
                  {language}
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {groups.length > 0 ? (
        <div role="group" aria-label="Collections" className="flex min-w-0 flex-col gap-1.5">
          <span className="px-1 text-sm font-medium text-foreground">Collections</span>
          <MultiSelect value={state.group} onValueChange={onGroupsChange} disabled={disabled}>
            <MultiSelectTrigger>
              <MultiSelectValue placeholder="Any collection" />
              <MultiSelectInput
                aria-label="Search collections"
                placeholder="Filter collections…"
                showIcon
              />
            </MultiSelectTrigger>
            <MultiSelectContent>
              <MultiSelectList ariaLabel="Collections">
                <MultiSelectEmpty>No collections found.</MultiSelectEmpty>
                {groups.map((group) => (
                  <MultiSelectItem key={group.slug} value={group.slug} textValue={group.name}>
                    {group.name}
                  </MultiSelectItem>
                ))}
              </MultiSelectList>
            </MultiSelectContent>
          </MultiSelect>
        </div>
      ) : null}

      <div className="flex min-w-0 flex-col gap-1.5">
        <div className="flex items-center justify-between gap-2">
          <span className="px-1 text-sm font-medium text-foreground">Minimum stars</span>
          <span className="flex items-center gap-0.5 text-xs text-muted-foreground tabular-nums">
            {stars === 0 ? "Any" : `${formatCompact(stars)} stars`}
            {stars > 0 ? (
              <Button
                variant="ghost"
                size="icon"
                className="size-6"
                disabled={disabled}
                aria-label="Clear minimum stars"
                onClick={() => onMinStars(undefined)}
              >
                <X className="size-3.5" aria-hidden="true" />
              </Button>
            ) : null}
          </span>
        </div>
        <RangeSlider
          value={stars}
          onValueChange={onStarsChange}
          min={0}
          max={MAX_STARS}
          step={50}
          disabled={disabled}
          aria-label="Minimum stars"
          formatValueText={formatStars}
        />
      </div>

      <div
        className="flex min-w-0 flex-col gap-1.5"
        role="group"
        aria-labelledby="archived-filter-label"
      >
        <span className="px-1 text-sm font-medium text-foreground" id="archived-filter-label">
          Archived repos
        </span>
        <Tabs
          value={state.archived}
          onValueChange={(next) => onArchived(toArchivedFilter(next))}
          variant="segment"
          className="px-1"
        >
          <TabsList className="bg-muted">
            <TabsTrigger value="hide">Hide</TabsTrigger>
            <TabsTrigger value="include">Include</TabsTrigger>
            <TabsTrigger value="only">Only</TabsTrigger>
          </TabsList>
        </Tabs>
        <p className="px-1 text-xs leading-relaxed text-muted-foreground">
          Hidden by default: archived repositories are read-only on GitHub, so they rarely change.
          Include them to find an old project you starred.
        </p>
      </div>

      {hasActiveFilters(state) ? (
        <div className="flex items-start">
          <Button variant="ghost" size="sm" disabled={disabled} onClick={onClear}>
            Clear filters
          </Button>
        </div>
      ) : null}
    </div>
  );
}
