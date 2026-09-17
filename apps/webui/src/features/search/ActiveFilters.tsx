import type { ReactNode } from "react";
import { X } from "lucide-react";
import type { Group } from "@starwatch/domain";
import { LanguageDot } from "@/components/common/LanguageDot";
import { Button } from "@/components/motion/button/base";
import { formatCompact } from "@/lib/format";
import {
  DEFAULT_ARCHIVED,
  hasActiveFilters,
  type ArchivedFilter,
  type SearchState,
} from "@/lib/search-params";

export interface ActiveFiltersProps {
  state: SearchState;
  groups: ReadonlyArray<Group>;
  onLanguage: (language: string | undefined) => void;
  onToggleGroup: (slug: string) => void;
  onMinStars: (minStars: number | undefined) => void;
  onArchived: (archived: ArchivedFilter) => void;
  onClear: () => void;
}

interface FilterChipProps {
  label: string;
  removeLabel: string;
  leading?: ReactNode;
  onRemove: () => void;
}

/** A selected filter with its own remove control — the only way out of it. */
function FilterChip({ label, removeLabel, leading, onRemove }: FilterChipProps) {
  return (
    <span className="inline-flex max-w-full items-center gap-1 rounded-full border border-border bg-card py-1 pl-2.5 pr-1 text-xs text-foreground">
      {leading}
      <span className="truncate" title={label}>
        {label}
      </span>
      <button
        type="button"
        onClick={onRemove}
        aria-label={removeLabel}
        className="grid size-6 shrink-0 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
      >
        <X className="size-3.5" aria-hidden="true" />
      </button>
    </span>
  );
}

function groupName(groups: ReadonlyArray<Group>, slug: string): string {
  for (const group of groups) {
    if (group.slug === slug) return group.name;
  }

  return slug;
}

export function ActiveFilters({
  state,
  groups,
  onLanguage,
  onToggleGroup,
  onMinStars,
  onArchived,
  onClear,
}: ActiveFiltersProps) {
  if (!hasActiveFilters(state)) return null;

  return (
    <div role="group" aria-label="Active filters" className="flex flex-wrap items-center gap-2">
      {state.lang !== undefined ? (
        <FilterChip
          label={state.lang}
          leading={<LanguageDot language={state.lang} />}
          removeLabel={`Remove language filter ${state.lang}`}
          onRemove={() => onLanguage(undefined)}
        />
      ) : null}

      {state.group.map((slug) => (
        <FilterChip
          key={slug}
          label={groupName(groups, slug)}
          removeLabel={`Remove collection filter ${groupName(groups, slug)}`}
          onRemove={() => onToggleGroup(slug)}
        />
      ))}

      {state.minStars !== undefined ? (
        <FilterChip
          label={`${formatCompact(state.minStars)} stars`}
          removeLabel="Remove minimum stars filter"
          onRemove={() => onMinStars(undefined)}
        />
      ) : null}

      {state.archived !== DEFAULT_ARCHIVED ? (
        <FilterChip
          label={state.archived === "only" ? "Only archived" : "Including archived"}
          removeLabel="Remove archived filter"
          onRemove={() => onArchived(DEFAULT_ARCHIVED)}
        />
      ) : null}

      <Button variant="ghost" size="sm" onClick={onClear}>
        Clear all
      </Button>
    </div>
  );
}
