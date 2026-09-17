/**
 * DRAFT — parent-owned. Copied into src/routes/user.tsx once every feature slice
 * lands. Kept outside src/ so the parallel workers' typecheck stays clean.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoute } from "@tanstack/react-router";
import * as Option from "effect/Option";
import { Database, SearchX } from "lucide-react";
import type { Group, SearchHit, SearchMode, SearchSort, SyncPhase } from "@starwatch/domain";
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
  BrowseEmptyPanel,
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
import { asApiError, refreshUserGroups } from "@/api";
import { useSemanticSearch } from "@/app/capabilities";
import { useDocumentTitle } from "@/hooks/useDocumentTitle";
import { useModalSurface } from "@/hooks/useModalSurface";
import { useSearchShortcut } from "@/hooks/useSearchShortcut";
import { useUserIndex } from "@/hooks/useUserIndex";
import { useToast } from "@/app/toast";
import { formatNumber, plural } from "@/lib/format";
import {
  decodeRawSearchBag,
  DEFAULT_ARCHIVED,
  DEFAULT_MODE,
  DEFAULT_SORT,
  normalizeUserSearch,
  PAGE_SIZE,
  parseUserSearch,
  SORT_LABELS,
  toArchivedQuery,
  toUrlSearch,
  toggleGroup,
  type ArchivedFilter,
  type SearchState,
} from "@/lib/search-params";
import { hasIndex, isActivePhase, runHeartbeat, syncWaitLabel, syncWindow } from "@/lib/state";
import { cn } from "@/lib/utils";
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

/** What the automatic stall probe learned about the run behind an old heartbeat. */
type StallProbe =
  | { key: string; status: "probing" }
  | { key: string; status: "started" | "alive" }
  | { key: string; status: "failed"; message: string };

/** What the panel should say: nothing, restarting, or a manual retry. */
type StallView = "none" | "probing" | "failed";

function UserSearchPage() {
  const { login } = userRoute.useParams();
  const rawSearch = userRoute.useSearch();
  const search = useMemo(() => normalizeUserSearch(rawSearch), [rawSearch]);
  const navigate = userRoute.useNavigate();
  const toast = useToast();
  const semanticSearch = useSemanticSearch();
  const [filtersOpen, setFiltersOpen] = useState(false);
  const sheetRef = useRef<HTMLDivElement>(null);
  const resultsRef = useRef<HTMLElement>(null);

  /**
   * Bring the result list into view after the reader asks for results.
   * Submitting from far down a browse list — or paging on a long one —
   * otherwise leaves the viewport on the previous page's tail, with the new
   * first hit off screen.
   *
   * Every caller must navigate with `resetScroll: false`: the router's scroll
   * restoration resets the window to the top after the new route renders,
   * which would silently undo this a frame later.
   */
  const scrollToResults = useCallback(() => {
    const target = resultsRef.current;

    if (target === null) return;

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    target.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "start" });
  }, []);

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

  const { data, loading, error, refresh, startSync, syncPending, transport } = useUserIndex(login);

  // The per-account daily window (docs/08 §2.2): the header, the auto-start and
  // the refusal toasts all read the same derivation. Declared before the
  // handlers because their dependency arrays are evaluated during render.
  const syncGate = useMemo(() => syncWindow(data?.state), [data?.state]);

  // A 404 from the index means "not indexed yet", not "no such GitHub user";
  // only the sync POST can tell those apart (it reads the profile itself).
  const [missingUser, setMissingUser] = useState(false);

  // The default view is the browse path (docs/08 §3.4): with no text there is
  // no relevance to rank by, so `relevance` falls back to the documented browse
  // order — most recently starred first — and the page asks for one real page.
  const searching = search.q.trim() !== "";
  const browseSort: SearchSort = search.sort === DEFAULT_SORT ? "starred" : search.sort;
  const effectiveSort: SearchSort = searching ? search.sort : browseSort;
  const offset = (search.page - 1) * PAGE_SIZE;

  // A bookmarked `?mode=semantic` on a keyword-only deployment is answered with
  // keyword results: the mode is not offered here, and the response's own
  // `mode` field is what the summary line reads.
  const effectiveMode: SearchMode = semanticSearch ? search.mode : "keyword";

  const query: SearchQueryState = {
    q: search.q,
    mode: effectiveMode,
    sort: effectiveSort,
    lang: search.lang,
    groups: search.group,
    archived: toArchivedQuery(search.archived),
    minStars: search.minStars,
    offset,
  };

  const { response, status, error: searchError, retry } = useSearch(login, query);

  // Stable navigation callbacks keep the memoized result cards from re-rendering.
  const searchRef = useRef(search);
  searchRef.current = search;
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;
  const semanticRef = useRef(semanticSearch);
  semanticRef.current = semanticSearch;

  // Filter and slider changes replace the current entry: dragging the stars
  // slider would otherwise push a history entry (and a search) per step, and
  // Back would walk the drag instead of leaving the page. A submitted query is
  // a deliberate navigation, so that one pushes.
  const applyPatch = useCallback(
    (patch: Partial<SearchState>, replace: boolean, options?: { keepScroll?: boolean }) => {
      const next = { ...searchRef.current, ...patch };

      // Landing on a keyword-only deployment drops a stale `?mode=`: the next
      // interaction rewrites the URL without a mode it can no longer honour.
      if (!semanticRef.current) next.mode = DEFAULT_MODE;

      void navigateRef.current({
        search: toUrlSearch(next),
        replace,
        // `keepScroll` is for the actions that scroll the results into view
        // themselves; the router's default reset-to-top would cancel them.
        resetScroll: options?.keepScroll !== true,
      });
    },
    [],
  );

  const applyFilters = useCallback(
    (patch: Partial<SearchState>) => applyPatch({ ...patch, page: 1 }, true),
    [applyPatch],
  );

  const onSubmitQuery = useCallback(
    (q: string) => {
      applyPatch({ q, page: 1 }, false, { keepScroll: true });
      scrollToResults();
    },
    [applyPatch, scrollToResults],
  );

  const onMode = useCallback((mode: SearchMode) => applyFilters({ mode }), [applyFilters]);

  const onSort = useCallback((sort: SearchSort) => applyFilters({ sort }), [applyFilters]);

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

  const onPage = useCallback(
    (page: number) => {
      applyPatch({ page }, false, { keepScroll: true });
      scrollToResults();
    },
    [applyPatch, scrollToResults],
  );

  const onOpen = useCallback(
    (hit: SearchHit) => applyPatch({ repo: `${hit.repo.owner}/${hit.repo.name}` }, false),
    [applyPatch],
  );

  const onCloseRepo = useCallback(() => applyPatch({ repo: undefined }, true), [applyPatch]);

  const handleStartSync = useCallback(
    (options?: { full?: boolean }) => {
      void startSync(options).then((outcome) => {
        if (!outcome.ok) {
          // A run started in another tab answers 409; that is a state, not a failure.
          if (outcome.error.kind === "busy") {
            toast.info("Already indexing", outcome.error.message);
          } else if (outcome.error.kind === "rate-limited") {
            // The only 429 `POST /sync` can return is the per-account window
            // (`SyncCooldown`); a GitHub limit never reaches the client, since a
            // failed profile probe dies as a 500. So the honest copy is always
            // the window, with the server's `retry-after` as the precise answer.
            //
            // Which sentence fits depends on who noticed first: while our own
            // copy of the state already says the window is closed it is simply
            // "today", but an open window here means the server closed it after a
            // run we never saw finish (an older tab, a missed final frame).
            const wait = syncWaitLabel(outcome.error.retryAfterSeconds);

            if (syncGate.open) {
              toast.info(
                "That sync already finished",
                `The next refresh is due ${wait ?? "tomorrow"} — one sync per account per day.`,
              );
            } else {
              toast.info(
                "Already synced today",
                `One sync per account per day. You can refresh ${wait ?? "tomorrow"}.`,
              );
            }
          } else if (outcome.error.kind === "budget") {
            // Visitor, service allowance, or a busy queue: the server's message
            // already names which one and when to come back, so do not put a
            // "daily limit" headline on a queue rejection.
            toast.info("Sync not started", outcome.error.message);
          } else {
            toast.error("Couldn't start indexing", outcome.error.message);
          }
        } else if (!outcome.started) {
          // `started: false` means the request attached to a run that already
          // exists — which is either a fresh one or one sleeping out a GitHub
          // limit. Only a settled index means "there is genuinely nothing to do".
          if (isActivePhase(outcome.phase) || outcome.phase === "paused") {
            toast.info("Already indexing", "This index is being refreshed right now.");
          } else {
            toast.info("Nothing new to index yet", "GitHub has no newer stars to read.");
          }
        } else {
          toast.success("Indexing started");
        }
      });
    },
    [startSync, syncGate, toast],
  );

  /** The header's re-check button: always the cheap metadata re-list. */
  const handleRecheck = useCallback(() => handleStartSync({ full: false }), [handleStartSync]);

  /** A sync control was pressed while the daily window is closed. */
  const handleBlockedSync = useCallback(() => {
    toast.info("Already synced today", `One sync per account per day. ${syncGate.label}.`);
  }, [syncGate, toast]);

  /**
   * Re-read the collections rail. One cheap Lists import (not bound by the
   * per-account daily sync window), then an authoritative payload refresh so
   * the stored groups and the import outcome both land.
   */
  const [listsRefreshing, setListsRefreshing] = useState(false);
  const listsAttemptedRef = useRef<string | null>(null);

  const refreshLists = useCallback(() => {
    setListsRefreshing(true);
    void refreshUserGroups(login)
      .catch((cause) => {
        toast.info("Couldn't refresh collections", asApiError(cause).message);
      })
      .finally(() => {
        setListsRefreshing(false);
        refresh();
      });
  }, [login, refresh, toast]);

  // Collections self-heal on first view: when the rail has nothing to show and
  // the last import did not succeed, try once per visit. `empty` is a real
  // answer (the account has no public Lists), so it never spends a request, and
  // an active index run owns its own Lists step — wait for it to settle.
  useEffect(() => {
    if (data === null) return;

    if (data.groups.length > 0 || data.lists.state === "empty") return;

    if (isActivePhase(data.state.phase)) return;

    if (listsAttemptedRef.current === login) return;

    listsAttemptedRef.current = login;
    refreshLists();
  }, [data, login, refreshLists]);

  const state = data?.state ?? null;
  const groups = data?.groups ?? EMPTY_GROUPS;
  const hits = response?.hits ?? EMPTY_HITS;

  // Stalled-run recovery. An active phase with no heartbeat for 20 minutes is
  // either dead (killed at a platform limit) or sleeping where the state row
  // cannot show it. The server owns the distinction — it probes the workflow
  // engine and takes over only a run that provably stopped — so this is a
  // *probe*, not a blind restart: it either recovers the run, learns the run
  // is alive, or surfaces a manual retry. One probe per silence stamp, and
  // only while the page is open; a passive view never starts an index.
  const beat = runHeartbeat(data?.state);
  const stallKey = data !== null && beat.stalled ? `${login}:${data.state.updatedAt}` : null;
  const [stallProbe, setStallProbe] = useState<StallProbe | null>(null);

  useEffect(() => {
    if (stallKey === null) return;

    if (stallProbe?.key === stallKey) return;

    setStallProbe({ key: stallKey, status: "probing" });
    void startSync({ full: true }).then((outcome) => {
      setStallProbe((current) => {
        if (current?.key !== stallKey) return current;

        if (outcome.ok) {
          return { key: stallKey, status: outcome.started ? "started" : "alive" };
        }

        // A 409 means another request created or already owns the run between
        // the probe and the post — that is the run being alive, not a failure.
        if (outcome.error.kind === "busy") return { key: stallKey, status: "alive" };

        return { key: stallKey, status: "failed", message: outcome.error.message };
      });
    });
  }, [stallKey, stallProbe, startSync]);

  let stall: StallView = "none";

  if (stallKey !== null) {
    if (stallProbe?.key !== stallKey || stallProbe.status === "probing") stall = "probing";
    else if (stallProbe.status === "failed") stall = "failed";
  }

  const stallMessage =
    stallProbe?.key === stallKey && stallProbe.status === "failed" ? stallProbe.message : null;

  const pageStars = data ? data.state.starsTotal || data.state.reposMetadata : 0;

  useDocumentTitle(
    data
      ? `@${data.profile.login}'s stars — search ${formatNumber(pageStars)} ${plural(pageStars, "repo")} · starwatch`
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

    // Only a deployment that builds vectors can be missing them; a keyword-only
    // one would otherwise start a full pass on every query.
    const semanticMissing =
      semanticSearch &&
      !neverIndexed &&
      indexState.semanticDocs === 0 &&
      (indexState.phase === "idle" || indexState.phase === "ready");

    if (!neverIndexed && !semanticMissing) return;

    // Inside the daily window nothing will start (the API refuses), so do not
    // spend a request that can only come back as a refusal.
    if (!syncGate.open) return;

    // A start request is already in flight: posting again would only attach to
    // the run it is creating and toast about it.
    if (syncPending) return;

    autoStartedRef.current = true;
    // A first index only needs metadata (search works in seconds, docs/08 tier
    // 0); an existing metadata-only index needs the full pass, or the auto-start
    // would re-list and re-close the daily window without ever building vectors.
    handleStartSync({ full: semanticMissing });
  }, [data, search.q, semanticSearch, syncGate, syncPending, handleStartSync]);

  // One refresh when the listing finishes, so early browsers and searchers see
  // the full set. Keyed by login: navigating between two users must not read the
  // previous account's phase as this one's progress.
  const lastPhaseRef = useRef<{ login: string; phase: SyncPhase } | null>(null);
  useEffect(() => {
    const phase = data?.state.phase ?? null;
    const previous = lastPhaseRef.current;

    if (phase !== null) lastPhaseRef.current = { login, phase };

    if (
      previous !== null &&
      previous.login === login &&
      phase === "ready" &&
      (previous.phase === "listing" ||
        previous.phase === "fetching-readmes" ||
        previous.phase === "embedding")
    ) {
      // Covers the default browse list too: it was fetched against a partial
      // (or empty) index, so it must be re-read once the run settles.
      retry();
      toast.info("Index updated");
    }
  }, [data?.state.phase, login, retry, toast]);

  const groupNames = useMemo(() => {
    const map: Record<string, string> = {};

    for (const group of groups) map[group.slug] = group.name;

    return map;
  }, [groups]);

  const total = response?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = Math.min(search.page, pageCount);
  // A bookmarked page can outlive its results (stars get unstarred). The
  // response still carries the real total, so fold the page back instead of
  // showing an empty list; until the corrected fetch lands, keep the skeleton.
  const outOfRange = response !== null && search.page > pageCount;

  useEffect(() => {
    if (response === null || search.page <= pageCount) return;

    applyPatch({ page: pageCount }, true);
  }, [response, search.page, pageCount, applyPatch]);

  const pageHits = hits;
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

  // The server already reports 0 when the deployment has no vectors; gating
  // here as well keeps every downstream affordance honest even against a
  // worker that still sends the stored count.
  const semanticDocs = semanticSearch ? (state?.semanticDocs ?? 0) : 0;
  const indexPreparing = state !== null && (!hasIndex(state) || isActivePhase(state.phase));
  // No query is the default browse view; the collections rail rides beside it.
  const browsing = !searching;

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
            body="Indexing loads the public star list first; keyword search works within seconds."
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
            onStartSync={handleStartSync}
            onRecheck={handleRecheck}
            syncWindow={syncGate}
            onBlockedSync={handleBlockedSync}
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
            onRefresh={refresh}
            stall={stall}
            stallMessage={stallMessage}
          />

          <SearchToolbar
            value={search.q}
            busy={status === "loading" || status === "refreshing"}
            browsing={browsing}
            mode={effectiveMode}
            sort={effectiveSort}
            filterCount={countActiveFilters(search)}
            filtersOpen={filtersOpen}
            onSubmit={onSubmitQuery}
            onMode={onMode}
            onSort={onSort}
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

          <div
            className={cn(
              "grid min-w-0 items-start gap-6",
              browsing && "lg:grid-cols-[minmax(0,1fr)_18rem]",
            )}
          >
            <section
              ref={resultsRef}
              className={cn(
                "flex min-w-0 scroll-mt-20 flex-col gap-4",
                browsing && "order-2 lg:order-1",
              )}
              aria-labelledby="results-heading"
            >
              {/* The results column names itself, so the card headings below
                  sit at h3 under a real h2 rather than skipping. */}
              {browsing ? (
                <header className="flex flex-col gap-1">
                  <h2
                    id="results-heading"
                    className="text-lg font-semibold tracking-tight text-balance-pretty"
                  >
                    {browseHeading(search, groups, effectiveSort)}
                  </h2>
                  <p aria-live="polite" className="text-xs text-muted-foreground tabular-nums">
                    {formatNumber(total)} {plural(total, "repo")} · sorted by{" "}
                    {SORT_LABELS[effectiveSort].toLowerCase()}
                    {status === "refreshing" ? " · updating…" : ""}
                  </p>
                </header>
              ) : (
                <h2 id="results-heading" className="sr-only">
                  Search results for {search.q}
                </h2>
              )}

              {searching && response ? (
                <ResultSummary
                  response={response}
                  status={status}
                  semanticDocs={semanticDocs}
                  sort={search.sort}
                />
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

              {status === "error" && !response ? (
                searching ? (
                  indexPreparing ? (
                    <IndexPreparingPanel login={login} />
                  ) : searchError ? (
                    <SearchErrorPanel
                      error={searchError}
                      canFallbackToKeyword={
                        semanticSearch && (search.mode === "semantic" || search.mode === "hybrid")
                      }
                      onRetry={retry}
                      onMode={onMode}
                    />
                  ) : null
                ) : (
                  <ErrorPanel
                    title="Couldn't load these repositories"
                    error={searchError ?? { message: "The request did not complete." }}
                    onRetry={retry}
                  />
                )
              ) : null}

              {searching && status === "ready" && response && pageHits.length === 0 ? (
                <NoResultsPanel
                  query={search.q}
                  hasLanguageFilter={search.lang !== undefined}
                  hasCollectionFilter={search.group.length > 0}
                  hasStarFilter={search.minStars !== undefined}
                  canTrySemantic={semanticSearch && semanticDocs > 0 && search.mode !== "semantic"}
                  onClearFilters={onClear}
                  onMode={onMode}
                />
              ) : null}

              {browsing &&
              status === "ready" &&
              !outOfRange &&
              response &&
              pageHits.length === 0 ? (
                indexPreparing ? (
                  <IndexPreparingPanel login={login} />
                ) : (
                  <BrowseEmptyPanel
                    filterCount={countActiveFilters(search)}
                    onClearFilters={onClear}
                  />
                )
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

            {browsing ? (
              <aside
                aria-label="Collections and index status"
                className="order-1 min-w-0 lg:order-2 lg:sticky lg:top-20 lg:max-h-[calc(100dvh-6rem)] lg:self-start lg:overflow-y-auto lg:overscroll-contain lg:pr-1"
              >
                <BrowsePanel
                  login={login}
                  state={state}
                  groups={groups}
                  lists={data.lists}
                  refreshingLists={listsRefreshing}
                  selected={search.group}
                  onPickGroup={onToggleGroup}
                  onRefreshLists={refreshLists}
                />
              </aside>
            ) : null}
          </div>
        </>
      ) : null}

      <BottomSheet
        open={filtersOpen}
        onOpenChange={setFiltersOpen}
        title="Filters"
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

  // `hide` is the default, not an active narrowing — treating it as one made
  // every default view claim "Filters (1)".
  if (state.archived !== DEFAULT_ARCHIVED) count += 1;

  return count;
}

/** The default view's heading: the collection in view, or the ordering in words. */
function browseHeading(state: SearchState, groups: ReadonlyArray<Group>, sort: SearchSort): string {
  if (state.group.length === 1) {
    const slug = state.group[0];

    for (const group of groups) {
      if (group.slug === slug) return `Starred in ${group.name}`;
    }

    return "Starred in this collection";
  }

  if (state.group.length > 1) return `Starred in ${state.group.length} collections`;

  switch (sort) {
    case "stars":
      return "Most starred";
    case "pushed":
      return "Recently pushed";
    default:
      return "Recently starred";
  }
}
