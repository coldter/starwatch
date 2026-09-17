import type { Group, ListsInfo, UserIndexState } from "@starwatch/domain";
import { Check, Layers } from "lucide-react";
import { Button } from "@/components/motion/button/base";
import { Loader } from "@/components/motion/loader";
import { NumberTicker } from "@/components/motion/number-ticker";
import { formatNumber, plural } from "@/lib/format";
import { semanticCoverage } from "@/lib/state";
import { cn } from "@/lib/utils";

export interface BrowsePanelProps {
  login: string;
  state: UserIndexState;
  groups: ReadonlyArray<Group>;
  /** Last import outcome, so "no lists" and "couldn't read lists" stay distinct. */
  lists: ListsInfo;
  /** A refresh is in flight (auto on first load, or the rail's own button). */
  refreshingLists: boolean;
  /** Selected collection slugs. */
  selected: ReadonlyArray<string>;
  onPickGroup: (slug: string) => void;
  onRefreshLists: () => void;
}

interface CollectionEntry {
  group: Group;
  count: number;
}

/** The rail's collections, ordered as GitHub orders the user's Lists. */
function toEntries(groups: ReadonlyArray<Group>): ReadonlyArray<CollectionEntry> {
  return groups.map((group) => ({ group, count: group.repoIds.length }));
}

function CollectionCard({
  entry,
  active,
  onToggle,
}: {
  entry: CollectionEntry;
  active: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onToggle}
      title={entry.group.name}
      className={cn(
        "group/card flex w-56 shrink-0 flex-col rounded-xl border p-3 text-left transition-colors lg:w-full",
        active
          ? "border-primary/50 bg-primary/5"
          : "border-border bg-muted/20 hover:border-border-strong hover:bg-muted/50",
      )}
    >
      <span className="flex min-w-0 items-center gap-2.5">
        <span
          className={cn(
            "grid size-8 shrink-0 place-items-center rounded-lg transition-colors",
            active ? "bg-primary/15 text-primary" : "bg-muted text-muted-foreground",
          )}
          aria-hidden="true"
        >
          <Layers className="size-3.5" />
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-sm font-medium text-foreground">{entry.group.name}</span>
          <span className="text-xs tabular-nums text-muted-foreground">
            {formatNumber(entry.count)} {plural(entry.count, "repo")}
          </span>
        </span>
        {active ? <Check className="size-4 shrink-0 text-primary" aria-hidden="true" /> : null}
      </span>
    </button>
  );
}

/**
 * The rail's empty body. The three empty cases must read differently: a
 * successful import with no lists is a fact about the account, `error` is a
 * fact about our attempt, and `never` means we have not tried yet.
 */
function ListsEmptyState({
  lists,
  refreshing,
  onRefresh,
}: {
  lists: ListsInfo;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  if (refreshing) {
    return (
      <div
        role="status"
        className="flex items-center gap-2 rounded-xl border border-border px-3 py-4 text-xs text-muted-foreground"
      >
        <Loader variant="dots" size={12} label="Loading collections" />
        Loading collections…
      </div>
    );
  }

  if (lists.state === "error") {
    return (
      <div className="flex flex-col items-start gap-2.5 rounded-xl border border-dashed border-border px-3 py-4">
        <p className="text-xs leading-relaxed text-muted-foreground">
          Couldn&apos;t load collections{lists.error !== null ? `: ${lists.error}` : "."}
        </p>
        <Button variant="outline" size="sm" onClick={onRefresh}>
          Try again
        </Button>
      </div>
    );
  }

  if (lists.state === "never") {
    return (
      <div className="flex flex-col items-start gap-2.5 rounded-xl border border-dashed border-border px-3 py-4">
        <p className="text-xs leading-relaxed text-muted-foreground">
          Collections haven&apos;t been imported for this account yet.
        </p>
        <Button variant="outline" size="sm" onClick={onRefresh}>
          Load collections
        </Button>
      </div>
    );
  }

  return (
    <p className="rounded-xl border border-dashed border-border px-3 py-4 text-xs leading-relaxed text-muted-foreground">
      No public Lists on this account. Search a name, topic or idea to dig through the stars
      instead.
    </p>
  );
}

function IndexStat({ label, value, hint }: { label: string; value: number; hint: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-medium text-foreground tabular-nums" title={hint}>
        <NumberTicker value={value} locale startOnView={false} />
      </dd>
    </div>
  );
}

/**
 * The default view's companion rail (docs/08 §3.4): the public GitHub Lists
 * this user created, then how complete the index behind them is. Selecting a
 * collection narrows the starred list beside it; the cards stay buttons, so a
 * click, Enter and Space all behave the same.
 */
export function BrowsePanel({
  login,
  state,
  groups,
  lists,
  refreshingLists,
  selected,
  onPickGroup,
  onRefreshLists,
}: BrowsePanelProps) {
  const entries = toEntries(groups);
  const coverage = semanticCoverage(state);

  return (
    <div className="flex flex-col gap-4">
      <section
        aria-labelledby="collections-heading"
        className="flex flex-col gap-3.5 rounded-2xl border border-border bg-card p-4"
      >
        <div className="flex flex-col gap-1">
          <h2 id="collections-heading" className="text-sm font-semibold tracking-tight">
            Collections
          </h2>
          <p className="text-xs leading-relaxed text-muted-foreground">
            Public GitHub Lists from @{login}.
          </p>
        </div>

        {entries.length === 0 ? (
          <ListsEmptyState lists={lists} refreshing={refreshingLists} onRefresh={onRefreshLists} />
        ) : (
          // Phones get a swipeable strip; from `lg` the cards stack into the
          // sticky rail column beside the starred list.
          <div className="-mx-1 flex gap-2 overflow-x-auto px-1 py-1 lg:mx-0 lg:flex-col lg:overflow-visible lg:px-0">
            {entries.map((entry) => (
              <CollectionCard
                key={entry.group.id}
                entry={entry}
                active={selected.includes(entry.group.slug)}
                onToggle={() => onPickGroup(entry.group.slug)}
              />
            ))}
          </div>
        )}

        {/* Imported lists stay usable when a later refresh fails; say so
            quietly instead of replacing them with an error panel. */}
        {entries.length > 0 && lists.state === "error" ? (
          <div className="flex items-start justify-between gap-2">
            <p className="text-xs leading-relaxed text-muted-foreground">
              Couldn&apos;t refresh{lists.error !== null ? `: ${lists.error}` : "."}
            </p>
            <Button
              variant="ghost"
              size="sm"
              disabled={refreshingLists}
              onClick={onRefreshLists}
              className="shrink-0"
            >
              {refreshingLists ? "Refreshing…" : "Retry"}
            </Button>
          </div>
        ) : null}
      </section>

      <section
        aria-labelledby="index-stats-heading"
        className="hidden flex-col gap-3.5 rounded-2xl border border-border bg-card p-4 lg:flex"
      >
        <div className="flex flex-col gap-1">
          <h2 id="index-stats-heading" className="text-sm font-semibold tracking-tight">
            Index
          </h2>
          <p className="text-xs leading-relaxed text-muted-foreground">
            What search can see for this account.
          </p>
        </div>

        <dl className="flex flex-col gap-2 text-xs">
          <IndexStat
            label="Repos"
            value={state.reposMetadata}
            hint="Repos with metadata indexed."
          />
          <IndexStat
            label="READMEs"
            value={state.readmesFetched}
            hint="Repos whose README has been fetched."
          />
          <IndexStat
            label="Embedded"
            value={state.semanticDocs}
            hint="Repos with a semantic vector."
          />
        </dl>

        <div className="flex flex-col gap-1.5">
          <div className="flex items-baseline justify-between text-xs">
            <span className="text-muted-foreground">Semantic coverage</span>
            <span className="font-medium text-foreground tabular-nums">{coverage}%</span>
          </div>
          <div
            role="progressbar"
            aria-label="Semantic coverage"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={coverage}
            className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
          >
            <span
              className="block h-full rounded-full bg-live/80"
              style={{ width: `${coverage}%` }}
            />
          </div>
        </div>
      </section>
    </div>
  );
}
