/**
 * DRAFT — parent-owned. Copied into src/routes/user.tsx once every feature slice
 * lands. Kept outside src/ so the parallel workers' typecheck stays clean.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoute } from "@tanstack/react-router";
import * as Option from "effect/Option";
import { Database, SearchX } from "lucide-react";
import type { Group, SearchHit, SearchMode, SyncPhase } from "@starwatch/domain";
import { Button } from "@/components/motion/button/base";
import { BottomSheet } from "@/components/motion/bottom-sheet";
import { ErrorPanel, NoticeStrip, StatePanel } from "@/components/common/StatePanel";
import { HeroSkeleton, ResultSkeletonList } from "@/components/common/Skeletons";
import { ActiveFilters } from "@/features/search/ActiveFilters";
import { FilterControls } from "@/features/search/FilterControls";
import { ResultList } from "@/features/search/ResultList";
import { ResultSummary } from "@/features/search/ResultSummary";
import { ResultsPager } from "@/features/search/ResultsPager";
import {
  IndexPreparingPanel,
  NoResultsPanel,
  SearchErrorPanel,
} from "@/features/search/SearchStates";
import { SearchToolbar } from "@/features/search/SearchToolbar";
import { RepoDrawer } from "@/features/repo/RepoDrawer";
import { BrowsePanel } from "@/features/user/BrowsePanel";
import { IndexPanel } from "@/features/user/IndexPanel";
import { ProfileHeader } from "@/features/user/ProfileHeader";
import { useSearch, type SearchQueryState } from "@/hooks/useSearch";
import { useDocumentTitle } from "@/hooks/useDocumentTitle";
import { useModalSurface } from "@/hooks/useModalSurface";
import { useSearchShortcut } from "@/hooks/useSearchShortcut";
import { useUserIndex } from "@/hooks/useUserIndex";
import { useToast } from "@/app/toast";
import { formatNumber } from "@/lib/format";
import {
  decodeRawSearchBag,
  DEFAULT_ARCHIVED,
  normalizeUserSearch,
  PAGE_SIZE,
  parseUserSearch,
  toArchivedQuery,
  toUrlSearch,
  toggleGroup,
  type ArchivedFilter,
  type SearchState,
} from "@/lib/search-params";
import { hasIndex, isActivePhase, phaseLabel } from "@/lib/state";
import { rootRoute } from "./__root";

export const userRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/u/$login",
  // The router hands `validateSearch` an untyped bag; decode it into raw search
  // values here (an unreadable bag means no search state) so `parseUserSearch`
  // only ever sees decoded input.
  validateSearch: (search) =>
    parseUserSearch(Option.getOrElse(decodeRawSearchBag(search), () => ({}))),
  component: UserSearchPage,
});

const EMPTY_GROUPS: Group[] = [];

const EMPTY_HITS: SearchHit[] = [];

function UserSearchPage() {
  const { login } = userRoute.useParams();
  const rawSearch = userRoute.useSearch();
  const search = useMemo(() => normalizeUserSearch(rawSearch), [rawSearch]);
  const navigate = userRoute.useNavigate();
  const toast = useToast();
  const [filtersOpen, setFiltersOpen] = useState(false);
  const sheetRef = useRef<HTMLDivElement>(null);

  useSearchShortcut();

  // The portalled sheet marks itself `aria-modal` but neither moves focus nor
  // contains it; the app root goes inert (so Tab cannot reach the page behind)
  // and focus enters the sheet's first control, returning to the Filters button
  // when it closes.
  useModalSurface(filtersOpen);
  useEffect(() => {
    if (!filtersOpen) return;

    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;

    const panel = sheetRef.current?.closest<HTMLElement>('[role="dialog"]') ?? null;

    const first = panel?.querySelector<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
    );

    if (first) first.focus();
    else if (panel) {
      panel.setAttribute("tabindex", "-1");
      panel.focus();
    }

    return () => {
      // The inert attribute is removed in an earlier cleanup, so the opener is
      // focusable again by the time this frame runs. A programmatic open leaves
      // focus on <body>, so fall back to the Filters button itself.
      const fallback = document.querySelector<HTMLElement>("[data-filters-trigger]");

      requestAnimationFrame(() => {
        const target = opener !== null && opener !== document.body ? opener : fallback;

        target?.focus();
      });
    };
  }, [filtersOpen]);

  const { data, loading, refreshing, error, refresh, startSync, syncPending, transport } =
    useUserIndex(login);

  // A 404 from the index means "not indexed yet", not "no such GitHub user";
  // only the sync POST can tell those apart (it reads the profile itself).
  const [missingUser, setMissingUser] = useState(false);

  const query: SearchQueryState = {
    q: search.q,
    mode: search.mode,
    lang: search.lang,
    groups: search.group,
    archived: toArchivedQuery(search.archived),
    minStars: search.minStars,
  };

  const { response, status, error: searchError, retry } = useSearch(login, query);

  // Stable navigation callbacks keep the memoized result cards from re-rendering.
  const searchRef = useRef(search);
  searchRef.current = search;
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;

  // Filter and slider changes replace the current entry: dragging the stars
  // slider would otherwise push a history entry (and a search) per step, and
  // Back would walk the drag instead of leaving the page. A submitted query is
  // a deliberate navigation, so that one pushes.
  const applyPatch = useCallback((patch: Partial<SearchState>, replace: boolean) => {
    const next = { ...searchRef.current, ...patch };
    void navigateRef.current({ search: toUrlSearch(next), replace });
  }, []);

  const applyFilters = useCallback(
    (patch: Partial<SearchState>) => applyPatch({ ...patch, page: 1 }, true),
    [applyPatch],
  );

  const onSubmitQuery = useCallback((q: string) => applyPatch({ q, page: 1 }, false), [applyPatch]);
  const onMode = useCallback((mode: SearchMode) => applyFilters({ mode }), [applyFilters]);

  const onLanguage = useCallback(
    (lang: string | undefined) => applyFilters({ lang }),
    [applyFilters],
  );

  const onToggleGroup = useCallback(
    (slug: string) => applyFilters({ group: toggleGroup(searchRef.current, slug) }),
    [applyFilters],
  );

  const onMinStars = useCallback(
    (minStars: number | undefined) => applyFilters({ minStars }),
    [applyFilters],
  );

  const onArchived = useCallback(
    (archived: ArchivedFilter) => applyFilters({ archived }),
    [applyFilters],
  );

  const onClear = useCallback(
    () =>
      applyFilters({
        lang: undefined,
        group: [],
        archived: DEFAULT_ARCHIVED,
        minStars: undefined,
      }),
    [applyFilters],
  );

  const onPage = useCallback((page: number) => applyPatch({ page }, false), [applyPatch]);

  const onOpen = useCallback(
    (hit: SearchHit) => applyPatch({ repo: `${hit.repo.owner}/${hit.repo.name}` }, false),
    [applyPatch],
  );

  const onCloseRepo = useCallback(() => applyPatch({ repo: undefined }, true), [applyPatch]);

  const handleStartSync = useCallback(
    (options?: { full?: boolean }) => {
      void startSync(options).then((outcome) => {
        if (!outcome.ok) {
          toast.error("Couldn't start indexing", outcome.error.message);
        } else if (!outcome.started) {
          toast.info(
            "Nothing new to index yet",
            `Current phase: ${phaseLabel(outcome.phase)}. Cooldowns protect the shared GitHub budget.`,
          );
        } else {
          toast.success("Indexing started", "Progress shows up right here as it runs.");
        }
      });
    },
    [startSync, toast],
  );

  const state = data?.state ?? null;
  const groups = data?.groups ?? EMPTY_GROUPS;
  const hits = response?.hits ?? EMPTY_HITS;

  useDocumentTitle(
    data
      ? `@${data.profile.login}'s stars — search ${formatNumber(
          data.state.starsTotal || data.state.reposMetadata,
        )} repos · starwatch`
      : `@${login} · starwatch`,
  );

  // Eager-lazy start: only a typed query triggers indexing (docs/08 §2.2) —
  // passive page views never spend the shared GitHub budget.
  const autoStartedRef = useRef(false);
  useEffect(() => {
    autoStartedRef.current = false;
  }, [login]);
  useEffect(() => {
    if (!data || autoStartedRef.current || !search.q.trim()) return;

    const indexState = data.state;

    // A run already in flight owns the index: posting again would be answered
    // with 409 SyncInProgress and surface as a false failure toast.
    if (isActivePhase(indexState.phase)) return;

    const neverIndexed = !hasIndex(indexState);

    const semanticMissing =
      !neverIndexed &&
      indexState.semanticDocs === 0 &&
      (indexState.phase === "idle" || indexState.phase === "ready");

    if (!neverIndexed && !semanticMissing) return;

    autoStartedRef.current = true;
    void startSync({ full: false }).then((outcome) => {
      if (!outcome.ok) {
        toast.error("Couldn't start indexing", outcome.error.message);
      }
    });
  }, [data, search.q, startSync, toast]);

  // One refresh when the listing finishes, so early searchers see the full set.
  const lastPhaseRef = useRef<SyncPhase | null>(null);
  useEffect(() => {
    const phase = data?.state.phase ?? null;
    const previous = lastPhaseRef.current;
    lastPhaseRef.current = phase;

    if (
      previous !== null &&
      phase === "ready" &&
      (previous === "listing" || previous === "fetching-readmes" || previous === "embedding") &&
      search.q.trim()
    ) {
      retry();
      toast.info("Index updated", "Results refreshed with newly indexed repos.");
    }
  }, [data?.state.phase, search.q, retry, toast]);

  const groupNames = useMemo(() => {
    const map: Record<string, string> = {};

    for (const group of groups) map[group.slug] = group.name;

    return map;
  }, [groups]);

  const total = hits.length;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = Math.min(search.page, pageCount);

  const pageHits = useMemo(
    () => hits.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
    [hits, page],
  );

  const shownStart = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const shownEnd = Math.min(page * PAGE_SIZE, total);

  const repoSplit = search.repo?.split("/") ?? [];
  const repoOwner = repoSplit[0] ?? null;
  const repoName = repoSplit[1] ?? null;

  // The drawer keeps the last repo while it slides out, so closing it does not
  // blank the panel mid-animation. Nothing refetches: `useRepo` only reacts to
  // owner/name changes, and these hold the previous values until it is gone.
  const lastRepoRef = useRef<{ owner: string; name: string } | null>(null);

  if (repoOwner !== null && repoName !== null) {
    lastRepoRef.current = { owner: repoOwner, name: repoName };
  }

  const drawerRepo = lastRepoRef.current;

  const semanticDocs = state?.semanticDocs ?? 0;
  const indexPreparing = state !== null && (!hasIndex(state) || isActivePhase(state.phase));
  const searching = search.q.trim() !== "";

  return (
    <div className="page-shell flex flex-col gap-6 py-6 sm:py-8">
      {loading && !data ? (
        <div className="flex flex-col gap-4">
          <HeroSkeleton />
          <ResultSkeletonList count={3} />
        </div>
      ) : null}

      {error && !data ? (
        missingUser ? (
          <StatePanel
            icon={SearchX}
            titleAs="h1"
            title={`No GitHub user named “${login}”`}
            body="Check the spelling — usernames use letters, numbers and single hyphens."
          >
            <Button
              variant="outline"
              size="sm"
              onClick={() => void navigate({ to: "/", search: {} })}
            >
              Search another user
            </Button>
          </StatePanel>
        ) : error.kind === "not-found" ? (
          <StatePanel
            icon={Database}
            titleAs="h1"
            title={`@${login} isn't in the shared index yet`}
            body="Indexing reads the public star list first, so keyword search works within seconds. READMEs and semantic search fill in behind it."
          >
            <Button
              variant="primary"
              size="sm"
              disabled={syncPending}
              onClick={() => {
                void startSync({ full: false }).then((outcome) => {
                  if (outcome.ok) {
                    refresh();
                  } else if (outcome.error.kind === "not-found") {
                    setMissingUser(true);
                  } else {
                    toast.error("Couldn't start indexing", outcome.error.message);
                  }
                });
              }}
            >
              {syncPending ? "Starting…" : "Index this user"}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void navigate({ to: "/", search: {} })}
            >
              Search another user
            </Button>
          </StatePanel>
        ) : (
          <ErrorPanel
            title="Couldn't load this user"
            titleAs="h1"
            error={error}
            onRetry={refresh}
          />
        )
      ) : null}

      {data && state ? (
        <>
          <ProfileHeader
            profile={data.profile}
            state={state}
            busy={syncPending}
            refreshing={refreshing}
            onStartSync={handleStartSync}
            onRefresh={refresh}
          />

          {error ? (
            <NoticeStrip
              tone="error"
              action={
                <Button variant="outline" size="sm" onClick={refresh}>
                  Retry
                </Button>
              }
            >
              Couldn&apos;t refresh this user: {error.message}
            </NoticeStrip>
          ) : null}

          <IndexPanel
            login={login}
            state={state}
            transport={transport}
            busy={syncPending}
            onStartSync={handleStartSync}
          />

          <SearchToolbar
            value={search.q}
            busy={status === "loading" || status === "refreshing"}
            mode={search.mode}
            filterCount={countActiveFilters(search)}
            filtersOpen={filtersOpen}
            onSubmit={onSubmitQuery}
            onMode={onMode}
            onToggleFilters={() => setFiltersOpen((open) => !open)}
          />

          <ActiveFilters
            state={search}
            groups={groups}
            onLanguage={onLanguage}
            onToggleGroup={onToggleGroup}
            onMinStars={onMinStars}
            onArchived={onArchived}
            onClear={onClear}
          />

          {searching ? (
            <div className="hidden lg:block">
              <FilterControls
                state={search}
                groups={groups}
                layout="inline"
                onLanguage={onLanguage}
                onToggleGroup={onToggleGroup}
                onMinStars={onMinStars}
                onArchived={onArchived}
                onClear={onClear}
              />
            </div>
          ) : null}

          <section className="flex min-w-0 flex-col gap-4" aria-labelledby="results-heading">
            {/* The results column names itself for screen readers, so the card
                headings below sit at h3 under a real h2 rather than skipping. */}
            {searching ? (
              <h2 id="results-heading" className="sr-only">
                Search results for {search.q}
              </h2>
            ) : null}

            {response ? (
              <ResultSummary response={response} status={status} semanticDocs={semanticDocs} />
            ) : null}

            {searchError && response ? (
              <NoticeStrip
                tone="error"
                action={
                  <Button variant="outline" size="sm" onClick={retry}>
                    Retry
                  </Button>
                }
              >
                {searchError.message}
              </NoticeStrip>
            ) : null}

            {status === "loading" ? <ResultSkeletonList /> : null}

            {status === "idle" && state ? (
              <BrowsePanel
                login={login}
                state={state}
                groups={groups}
                selected={search.group}
                onPickGroup={onToggleGroup}
              />
            ) : null}

            {status === "error" && !response ? (
              indexPreparing ? (
                <IndexPreparingPanel login={login} />
              ) : searchError ? (
                <SearchErrorPanel
                  error={searchError}
                  canFallbackToKeyword={search.mode === "semantic" || search.mode === "hybrid"}
                  onRetry={retry}
                  onMode={onMode}
                />
              ) : null
            ) : null}

            {status === "ready" && response && response.hits.length === 0 ? (
              <NoResultsPanel
                query={search.q}
                hasLanguageFilter={search.lang !== undefined}
                hasCollectionFilter={search.group.length > 0}
                hasStarFilter={search.minStars !== undefined}
                canTrySemantic={semanticDocs > 0 && search.mode !== "semantic"}
                onClearFilters={onClear}
                onMode={onMode}
              />
            ) : null}

            {pageHits.length > 0 ? (
              <ResultList hits={pageHits} groupNames={groupNames} onOpen={onOpen} />
            ) : null}

            {response ? (
              <ResultsPager
                page={page}
                pageCount={pageCount}
                shownStart={shownStart}
                shownEnd={shownEnd}
                total={total}
                onPage={onPage}
              />
            ) : null}
          </section>
        </>
      ) : null}

      <BottomSheet
        open={filtersOpen}
        onOpenChange={setFiltersOpen}
        title="Filters"
        description="Narrow the results without leaving the list."
        snapPoints={[0.88]}
        defaultSnap={0}
      >
        <div ref={sheetRef}>
          <FilterControls
            state={search}
            groups={groups}
            layout="sheet"
            onLanguage={onLanguage}
            onToggleGroup={onToggleGroup}
            onMinStars={onMinStars}
            onArchived={onArchived}
            onClear={onClear}
          />
        </div>
      </BottomSheet>

      <RepoDrawer
        open={repoOwner !== null && repoName !== null}
        owner={drawerRepo?.owner ?? null}
        name={drawerRepo?.name ?? null}
        onClose={onCloseRepo}
      />
    </div>
  );
}

/** How many filters are narrowing the current result set. */
function countActiveFilters(state: SearchState): number {
  let count = state.group.length;

  if (state.lang !== undefined) count += 1;

  if (state.minStars !== undefined) count += 1;

  if (state.archived) count += 1;

  return count;
}
