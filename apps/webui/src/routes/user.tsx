import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoute } from "@tanstack/react-router";
import { MAX_STARS, type DegradedReason, type Group, type SearchHit, type SearchMode, type SyncPhase } from "@starwatch/domain";
import { Avatar } from "../components/Avatar";
import { FilterBar } from "../components/FilterBar";
import { FreshnessChip } from "../components/FreshnessChip";
import { Pagination } from "../components/Pagination";
import { RepoCard } from "../components/RepoCard";
import { RepoDrawer } from "../components/RepoDrawer";
import { SearchBar } from "../components/SearchBar";
import { SkeletonList } from "../components/SkeletonCard";
import { ErrorState, NoResultsState, NotIndexedState, UserNotFoundState } from "../components/StateViews";
import { SyncBanner } from "../components/SyncBanner";
import { useSearch, type SearchQueryState } from "../hooks/useSearch";
import { useToast } from "../hooks/useToasts";
import { useUserIndex } from "../hooks/useUserIndex";
import type { UserPayload } from "../api";
import { coveragePercent, formatNumber } from "../lib/format";
import {
  PAGE_SIZE,
  normalizeUserSearch,
  parseUserSearch,
  toUrlSearch,
  toggleGroup,
  type SearchState
} from "../lib/search-params";
import {
  exceedsStarCap,
  hasIndex,
  isActivePhase,
  isMetadataOnly,
  isStale,
  phaseLabel
} from "../lib/state";
import { rootRoute } from "./__root";

export const userRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/u/$login",
  validateSearch: (search: Record<string, unknown>) => parseUserSearch(search),
  component: UserSearchPage
});

const EMPTY_GROUPS: Group[] = [];
const EMPTY_HITS: SearchHit[] = [];

const DEGRADED_COPY: Record<DegradedReason, string> = {
  "keyword-only": "Semantic search is unavailable right now — showing keyword results.",
  "semantic-window": "Semantic results cover only the newest indexed repos.",
  "rate-limited": "Search is rate-limited right now; some results may be missing."
};

function UserSearchPage() {
  const { login } = userRoute.useParams();
  const rawSearch = userRoute.useSearch();
  const search = useMemo(() => normalizeUserSearch(rawSearch), [rawSearch]);
  const navigate = userRoute.useNavigate();
  const toast = useToast();

  const { data, loading, refreshing, error, refresh, startSync, syncPending, transport } = useUserIndex(login);

  // A 404 from the index means "not indexed yet", not "no such GitHub user";
  // only the sync POST can tell those apart (it fetches the profile itself).
  const [missingUser, setMissingUser] = useState(false);

  const query: SearchQueryState = {
    q: search.q,
    mode: search.mode,
    lang: search.lang,
    groups: search.group,
    archived: search.archived,
    minStars: search.minStars
  };
  const { response, status, error: searchError, retry } = useSearch(login, query);

  // Stable navigation callbacks: keep memoized repo cards from re-rendering.
  const searchRef = useRef(search);
  searchRef.current = search;
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;

  const applyPatch = useCallback((patch: Partial<SearchState>) => {
    const next = { ...searchRef.current, ...patch };
    void navigateRef.current({ search: toUrlSearch(next) });
  }, []);
  const applyFilters = useCallback(
    (patch: Partial<SearchState>) => applyPatch({ ...patch, page: 1 }),
    [applyPatch]
  );

  const onSubmitQuery = useCallback((q: string) => applyPatch({ q, page: 1 }), [applyPatch]);
  const onMode = useCallback((mode: SearchMode) => applyFilters({ mode }), [applyFilters]);
  const onLang = useCallback((lang: string | undefined) => applyFilters({ lang }), [applyFilters]);
  const onToggleGroup = useCallback(
    (slug: string) => applyFilters({ group: toggleGroup(searchRef.current, slug) }),
    [applyFilters]
  );
  const onMinStars = useCallback((minStars: number | undefined) => applyFilters({ minStars }), [applyFilters]);
  const onArchived = useCallback((archived: boolean) => applyFilters({ archived }), [applyFilters]);
  const onClear = useCallback(
    () => applyFilters({ lang: undefined, group: [], archived: false, minStars: undefined }),
    [applyFilters]
  );
  const onPage = useCallback((page: number) => applyPatch({ page }), [applyPatch]);
  const openRepo = useCallback(
    (hit: SearchHit) => applyPatch({ repo: `${hit.repo.owner}/${hit.repo.name}` }),
    [applyPatch]
  );
  const closeRepo = useCallback(() => applyPatch({ repo: undefined }), [applyPatch]);

  const handleStartSync = useCallback(
    (options?: { full?: boolean }) => {
      void startSync(options).then((outcome) => {
        if (!outcome.ok) {
          toast({ title: "Couldn't start indexing", body: outcome.error.message, tone: "error" });
        } else if (!outcome.started) {
          toast({
            title: "Nothing new to index yet",
            body: `Current phase: ${phaseLabel(outcome.phase)}. Cooldowns protect the shared GitHub budget.`
          });
        } else {
          toast({ title: "Indexing started", body: "Progress shows up right here as it runs." });
        }
      });
    },
    [startSync, toast]
  );

  const state = data?.state ?? null;
  const groups = data?.groups ?? EMPTY_GROUPS;
  const hits = response?.hits ?? EMPTY_HITS;

  useEffect(() => {
    if (!data) return;
    const count = data.state.reposMetadata || data.state.starsTotal;
    document.title = `${data.profile.login}'s stars — search ${formatNumber(count)} repos · starwatch`;
  }, [data]);

  // Tier 0/1 eager-lazy start: only a typed query triggers indexing
  // (docs/08 §2.2 — passive page views never start work).
  const autoStartedRef = useRef(false);
  useEffect(() => {
    autoStartedRef.current = false;
  }, [login]);
  useEffect(() => {
    if (!data || autoStartedRef.current || !search.q.trim()) return;
    const indexState = data.state;
    const neverIndexed = !hasIndex(indexState);
    const semanticMissing =
      !neverIndexed &&
      indexState.semanticDocs === 0 &&
      (indexState.phase === "idle" || indexState.phase === "ready");
    if (!neverIndexed && !semanticMissing) return;
    autoStartedRef.current = true;
    void startSync({ full: false }).then((outcome) => {
      if (!outcome.ok) {
        toast({ title: "Couldn't start indexing", body: outcome.error.message, tone: "error" });
      }
    });
  }, [data, search.q, startSync, toast]);

  // One refresh when the listing finishes so early searchers see the full set.
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
      toast({ title: "Index updated", body: "Results refreshed with newly indexed repos." });
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
  const pageHits = useMemo(() => hits.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE), [hits, page]);
  const shownStart = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const shownEnd = Math.min(page * PAGE_SIZE, total);

  const repoParts = search.repo?.split("/") ?? [];
  const repoOwner = repoParts[0];
  const repoName = repoParts[1];

  const semanticDocs = state?.semanticDocs ?? 0;
  const indexPreparing = state !== null && (!hasIndex(state) || isActivePhase(state.phase));
  const semanticHint =
    response !== null && semanticDocs > 0 && coveragePercent(response.semanticCoverage) < 100;

  return (
    <div className="container user-page">
      {loading && !data ? <UserPageSkeleton /> : null}

      {error && !data ? (
        missingUser ? (
          <UserNotFoundState login={login} />
        ) : error.kind === "not-found" ? (
          <NotIndexedState
            login={login}
            busy={syncPending}
            onIndex={() => {
              void startSync({ full: false }).then((outcome) => {
                if (outcome.ok) {
                  refresh();
                } else if (outcome.error.kind === "not-found") {
                  setMissingUser(true);
                } else {
                  toast({ title: "Couldn't start indexing", body: outcome.error.message, tone: "error" });
                }
              });
            }}
          />
        ) : (
          <ErrorState title="Couldn't load this user" error={error} onRetry={refresh} />
        )
      ) : null}

      {data && state ? (
        <>
          <ProfileHero
            data={data}
            busy={syncPending}
            refreshing={refreshing}
            onRefresh={refresh}
            onStartSync={handleStartSync}
          />

          {error ? (
            <div className="inline-notice inline-notice--error" role="alert">
              <span>Couldn&apos;t refresh this user: {error.message}</span>
              <button type="button" className="btn btn--small" onClick={refresh}>
                Retry
              </button>
            </div>
          ) : null}

          <SearchBar
            value={search.q}
            onSubmit={onSubmitQuery}
            busy={status === "loading" || status === "refreshing"}
          />

          <SyncBanner state={state} transport={transport} busy={syncPending} onStart={handleStartSync} />

          <FilterBar
            state={search}
            groups={groups}
            disabled={status === "loading"}
            onMode={onMode}
            onLang={onLang}
            onToggleGroup={onToggleGroup}
            onMinStars={onMinStars}
            onArchived={onArchived}
            onClear={onClear}
          />

          <section className="results" aria-busy={status === "loading"}>
            <div className="results__header" aria-live="polite">
              {response ? (
                <p className="results__summary">
                  {formatNumber(total)} results · {response.tookMs}ms · {response.mode}
                  {semanticDocs > 0 ? ` · semantic coverage ${coveragePercent(response.semanticCoverage)}%` : ""}
                </p>
              ) : null}
              {status === "refreshing" ? <span className="results__updating">Searching…</span> : null}
            </div>

            {semanticHint ? (
              <p className="inline-notice" role="status">
                Semantic indexing is {coveragePercent(response?.semanticCoverage ?? 0)}% done — results may improve
                soon.
              </p>
            ) : null}

            {searchError && response ? (
              <div className="inline-notice inline-notice--error" role="alert">
                <span>{searchError.message}</span>
                <button type="button" className="btn btn--small" onClick={retry}>
                  Retry
                </button>
              </div>
            ) : null}

            {response?.degraded ? (
              <p className="inline-notice" role="status">
                {DEGRADED_COPY[response.degraded]}
              </p>
            ) : null}

            {status === "loading" ? <SkeletonList /> : null}

            {status === "idle" ? (
              <BrowseState
                state={state}
                groups={groups}
                selected={search.group}
                onPickGroup={onToggleGroup}
              />
            ) : null}

            {status === "error" && !response ? (
              indexPreparing ? (
                <section className="state-card" role="status">
                  <h2 className="state-card__title">Indexing @{login}…</h2>
                  <p className="state-card__body">
                    Search will refresh automatically when the first results land. This usually takes a few seconds.
                  </p>
                </section>
              ) : searchError ? (
                <ErrorState title="Search hit a snag" error={searchError} onRetry={retry}>
                  {search.mode === "semantic" || search.mode === "hybrid" ? (
                    <button type="button" className="btn btn--ghost btn--small" onClick={() => onMode("keyword")}>
                      Search keyword-only
                    </button>
                  ) : null}
                </ErrorState>
              ) : null
            ) : null}

            {status === "ready" && response && response.hits.length === 0 ? (
              <NoResultsState
                query={search.q}
                suggestions={
                  <>
                    {search.lang ? (
                      <button type="button" className="btn btn--small" onClick={() => onLang(undefined)}>
                        Remove language filter
                      </button>
                    ) : null}
                    {search.group.length > 0 ? (
                      <button type="button" className="btn btn--small" onClick={() => onClear()}>
                        Clear collections
                      </button>
                    ) : null}
                    {semanticDocs > 0 && search.mode !== "semantic" ? (
                      <button type="button" className="btn btn--small" onClick={() => onMode("semantic")}>
                        Try semantic mode
                      </button>
                    ) : null}
                    <a
                      className="btn btn--small btn--ghost"
                      href={`https://github.com/search?q=${encodeURIComponent(search.q)}&type=repositories`}
                      target="_blank"
                      rel="noreferrer noopener"
                    >
                      Search on GitHub ↗
                    </a>
                  </>
                }
              />
            ) : null}

            {pageHits.length > 0 ? (
              <div className="result-list">
                {pageHits.map((hit) => (
                  <RepoCard key={hit.repo.id} hit={hit} groupNames={groupNames} onOpen={openRepo} />
                ))}
              </div>
            ) : null}

            {response ? (
              <Pagination
                page={page}
                pageCount={pageCount}
                total={total}
                shownStart={shownStart}
                shownEnd={shownEnd}
                onPage={onPage}
              />
            ) : null}
          </section>
        </>
      ) : null}

      {repoOwner && repoName ? <RepoDrawer owner={repoOwner} name={repoName} onClose={closeRepo} /> : null}
    </div>
  );
}

function ProfileHero({
  data,
  busy,
  refreshing,
  onRefresh,
  onStartSync
}: {
  data: UserPayload;
  busy: boolean;
  refreshing: boolean;
  onRefresh: () => void;
  onStartSync: (options?: { full?: boolean }) => void;
}) {
  const { profile, state } = data;
  const neverIndexed = !hasIndex(state);
  const active = isActivePhase(state.phase);
  const stale = !neverIndexed && isStale(state);
  const stars = state.starsTotal || state.reposMetadata;
  const label = busy
    ? "Starting…"
    : active
      ? "Indexing…"
      : neverIndexed
        ? "Index now"
        : stale
          ? "Refresh now"
          : "Refresh index";
  const prominent = neverIndexed || stale;

  return (
    <header className="profile">
      <Avatar login={profile.login} name={profile.name} src={profile.avatarUrl} size={56} />
      <div className="profile__text">
        <h1 className="profile__title">{profile.name ?? `@${profile.login}`}</h1>
        <p className="profile__subtitle">
          <a href={`https://github.com/${profile.login}`} target="_blank" rel="noreferrer noopener">
            @{profile.login}
          </a>
          {stars > 0 ? <> · {formatNumber(stars)} stars</> : null}
          {profile.bio ? <> · {profile.bio}</> : null}
        </p>
        <p className="profile__chips">
          <FreshnessChip state={state} />
          {isMetadataOnly(state) ? <span className="badge">◦ partial: metadata only</span> : null}
          {exceedsStarCap(state) ? <span className="badge">capped at {formatNumber(MAX_STARS)} stars</span> : null}
        </p>
      </div>
      <div className="profile__actions">
        <button
          type="button"
          className={`btn ${prominent ? "btn--primary" : ""}`}
          onClick={() => onStartSync({ full: stale })}
          disabled={active || busy}
        >
          {label}
        </button>
        <button type="button" className="btn btn--ghost btn--small" onClick={onRefresh} disabled={refreshing}>
          {refreshing ? "Checking…" : "Re-check"}
        </button>
      </div>
    </header>
  );
}

function BrowseState({
  state,
  groups,
  selected,
  onPickGroup
}: {
  state: UserPayload["state"];
  groups: ReadonlyArray<Group>;
  selected: ReadonlyArray<string>;
  onPickGroup: (slug: string) => void;
}) {
  const selectedNames = groups.filter((group) => selected.includes(group.slug)).map((group) => group.name);
  return (
    <section className="state-card">
      <h2 className="state-card__title">
        {selectedNames.length > 0
          ? `${selectedNames.join(", ")} selected`
          : `Browse ${formatNumber(state.reposMetadata)} indexed repos`}
      </h2>
      <p className="state-card__body">
        {selectedNames.length > 0
          ? "Add a search term to search inside this collection."
          : "Type a few words — descriptions, topics and READMEs are all searchable."}
      </p>
      {groups.length > 0 ? (
        <div className="browse-collections">
          <h3 className="browse-collections__title">Collections</h3>
          <div className="chip-row">
            {groups.slice(0, 12).map((group) => {
              const isSelected = selected.includes(group.slug);
              return (
                <button
                  key={group.slug}
                  type="button"
                  className={`chip ${isSelected ? "chip--active" : ""}`}
                  aria-pressed={isSelected}
                  onClick={() => onPickGroup(group.slug)}
                >
                  {group.name}
                </button>
              );
            })}
          </div>
        </div>
      ) : null}
      <p className="state-card__detail">
        {formatNumber(state.reposMetadata)} repos · {formatNumber(state.readmesFetched)} READMEs ·{" "}
        {formatNumber(state.semanticDocs)} embedded
      </p>
    </section>
  );
}

function UserPageSkeleton() {
  return (
    <div className="user-page__skeleton" role="status" aria-label="Loading user index">
      <div className="skeleton skeleton--hero" />
      <div className="skeleton skeleton--searchbar" />
      <SkeletonList count={3} />
    </div>
  );
}
