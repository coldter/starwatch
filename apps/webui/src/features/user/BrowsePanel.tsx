import type { Group, UserIndexState } from "@starwatch/domain";
import { Button } from "@/components/motion/button/base";
import { NumberTicker } from "@/components/motion/number-ticker";
import { Tooltip } from "@/components/motion/tooltip";
import { formatNumber, plural } from "@/lib/format";
import { semanticCoverage } from "@/lib/state";

export interface BrowsePanelProps {
  login: string;
  state: UserIndexState;
  groups: ReadonlyArray<Group>;
  /** Selected collection slugs. */
  selected: ReadonlyArray<string>;
  onPickGroup: (slug: string) => void;
}

const VISIBLE_GROUPS = 12;

interface StatTile {
  label: string;
  value: number;
  hint: string;
  suffix?: string;
}

/** The empty-query surface: what is searchable, how complete it is, and the
 *  collections a query can be narrowed to. */
export function BrowsePanel({ login, state, groups, selected, onPickGroup }: BrowsePanelProps) {
  const selectedNames: string[] = [];

  for (const group of groups) {
    if (selected.includes(group.slug)) selectedNames.push(group.name);
  }

  const firstSelected = selectedNames[0];
  const hasSelection = selectedNames.length > 0;

  const heading = !hasSelection
    ? `Browse ${formatNumber(state.reposMetadata)} indexed ${plural(state.reposMetadata, "repo")}`
    : selectedNames.length === 1
      ? `Search in ${firstSelected}`
      : `Search in ${selectedNames.length} collections`;

  const body = !hasSelection
    ? "Search names, descriptions, topics and READMEs."
    : selectedNames.length === 1
      ? `Search inside ${firstSelected}.`
      : "Search inside the selected collections.";

  const tiles: StatTile[] = [
    {
      label: plural(state.reposMetadata, "repo indexed", "repos indexed"),
      value: state.reposMetadata,
      hint: "Repos with metadata indexed.",
    },
    {
      label: plural(state.readmesFetched, "README fetched", "READMEs fetched"),
      value: state.readmesFetched,
      hint: "Repos with READMEs fetched.",
    },
    {
      label: plural(state.semanticDocs, "vector embedded", "vectors embedded"),
      value: state.semanticDocs,
      hint: "Repos with vectors embedded.",
    },
    {
      label: "semantic coverage",
      value: semanticCoverage(state),
      hint: "Share of the newest repos that have vectors.",
      suffix: "%",
    },
  ];

  return (
    <section
      aria-label={`Browse ${login}'s index`}
      className="flex flex-col gap-5 rounded-2xl border border-border bg-card p-4 sm:p-6"
    >
      <div className="flex flex-col gap-1.5">
        <h2 className="text-lg font-semibold tracking-tight text-balance-pretty">{heading}</h2>
        <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">{body}</p>
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {tiles.map((tile) => (
          <Tooltip key={tile.label} content={tile.hint} wrapperClassName="w-full min-w-0">
            <div
              tabIndex={0}
              className="flex w-full min-w-0 flex-col gap-1 rounded-xl border border-border bg-muted/30 px-3 py-2.5"
            >
              <span className="text-lg font-semibold tabular-nums text-foreground">
                <NumberTicker value={tile.value} locale suffix={tile.suffix} />
              </span>
              <span className="text-xs text-muted-foreground">{tile.label}</span>
            </div>
          </Tooltip>
        ))}
      </div>

      {groups.length > 0 ? (
        <div className="flex flex-col gap-2.5">
          <h3 className="text-sm font-semibold tracking-tight">Collections</h3>
          <p className="text-xs leading-relaxed text-muted-foreground">
            Imported from this user's public GitHub Lists.
          </p>
          <div className="flex flex-wrap gap-1.5">
            {groups.slice(0, VISIBLE_GROUPS).map((group) => {
              const active = selected.includes(group.slug);

              return (
                <Button
                  key={group.id}
                  size="sm"
                  variant={active ? "primary" : "outline"}
                  aria-pressed={active}
                  onClick={() => onPickGroup(group.slug)}
                >
                  {group.name}
                </Button>
              );
            })}
            {groups.length > VISIBLE_GROUPS ? (
              <span className="inline-flex h-8 items-center text-xs text-muted-foreground">
                +{groups.length - VISIBLE_GROUPS} more
              </span>
            ) : null}
          </div>
        </div>
      ) : null}
    </section>
  );
}
