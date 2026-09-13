import { useState } from "react";
import type { Group, SearchMode } from "@starwatch/domain";
import { LANGUAGES } from "../lib/languages";
import { hasActiveFilters, SEARCH_MODES, type SearchState } from "../lib/search-params";

const MODE_LABELS: Record<SearchMode, string> = {
  auto: "Smart",
  keyword: "Keyword",
  hybrid: "Hybrid",
  semantic: "Semantic"
};

const MODE_TITLES: Record<SearchMode, string> = {
  auto: "starwatch picks the best strategy for this query",
  keyword: "Exact words: names, descriptions, topics, READMEs",
  hybrid: "Keyword results re-ranked by meaning",
  semantic: "Meaning-based search over indexed READMEs"
};

export interface FilterBarProps {
  state: SearchState;
  groups: ReadonlyArray<Group>;
  disabled?: boolean;
  onMode: (mode: SearchMode) => void;
  onLang: (lang: string | undefined) => void;
  onToggleGroup: (slug: string) => void;
  onMinStars: (minStars: number | undefined) => void;
  onArchived: (archived: boolean) => void;
  onClear: () => void;
}

/** Mode toggle + language/groups/stars/archived facets (docs/06 §3, mobile-collapsible). */
export function FilterBar({
  state,
  groups,
  disabled = false,
  onMode,
  onLang,
  onToggleGroup,
  onMinStars,
  onArchived,
  onClear
}: FilterBarProps) {
  const [open, setOpen] = useState(false);
  const active = hasActiveFilters(state);

  return (
    <section className="filters" aria-label="Search filters">
      <div className="filters__top">
        <div className="modes" role="group" aria-label="Search mode">
          {SEARCH_MODES.map((mode) => (
            <button
              key={mode}
              type="button"
              className={`mode ${state.mode === mode ? "mode--active" : ""}`}
              aria-pressed={state.mode === mode}
              title={MODE_TITLES[mode]}
              disabled={disabled}
              onClick={() => onMode(mode)}
            >
              {MODE_LABELS[mode]}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="filters__toggle"
          aria-expanded={open}
          aria-controls="filter-panel"
          onClick={() => setOpen((value) => !value)}
        >
          Filters{active ? " •" : ""}
        </button>
      </div>

      <div id="filter-panel" className={`filters__grid ${open ? "filters__grid--open" : ""}`}>
        <div className="field">
          <label className="field__label" htmlFor="filter-language">
            Language
          </label>
          <select
            id="filter-language"
            className="input"
            value={state.lang ?? ""}
            disabled={disabled}
            onChange={(event) => onLang(event.target.value || undefined)}
          >
            <option value="">All languages</option>
            {LANGUAGES.map((language) => (
              <option key={language} value={language}>
                {language}
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <label className="field__label" htmlFor="filter-stars">
            Min stars
          </label>
          <input
            id="filter-stars"
            className="input"
            type="number"
            min={0}
            step={100}
            inputMode="numeric"
            placeholder="0"
            value={state.minStars ?? ""}
            disabled={disabled}
            onChange={(event) => {
              const value = event.target.value === "" ? undefined : Number.parseInt(event.target.value, 10);
              onMinStars(value !== undefined && Number.isFinite(value) && value >= 0 ? value : undefined);
            }}
          />
        </div>

        <div className="field field--check">
          <input
            id="filter-archived"
            type="checkbox"
            checked={state.archived}
            disabled={disabled}
            onChange={(event) => onArchived(event.target.checked)}
          />
          <label htmlFor="filter-archived">Include archived</label>
        </div>

        {groups.length > 0 ? (
          <fieldset className="field field--groups">
            <legend className="field__label">Collections</legend>
            <div className="chip-row">
              {groups.map((group) => {
                const selected = state.group.includes(group.slug);
                return (
                  <button
                    key={group.slug}
                    type="button"
                    className={`chip ${selected ? "chip--active" : ""}`}
                    aria-pressed={selected}
                    disabled={disabled}
                    onClick={() => onToggleGroup(group.slug)}
                  >
                    {group.name}
                  </button>
                );
              })}
            </div>
          </fieldset>
        ) : null}

        {active ? (
          <div className="field field--clear">
            <button type="button" className="btn btn--ghost btn--small" onClick={onClear} disabled={disabled}>
              Clear filters
            </button>
          </div>
        ) : null}
      </div>
    </section>
  );
}
