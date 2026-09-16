import { useCallback, useEffect, useRef, useState } from "react";
import { Link, createRoute, useNavigate } from "@tanstack/react-router";
import { MAX_STARS } from "@starwatch/domain";
import {
  asApiError,
  fetchUser,
  isAbortError,
  startUserSync,
  type ApiError,
  type UserPayload,
} from "../api";
import { Avatar } from "../components/Avatar";
import { FreshnessChip } from "../components/FreshnessChip";
import { SearchBar } from "../components/SearchBar";
import { SkeletonCard } from "../components/SkeletonCard";
import { ErrorState } from "../components/StateViews";
import { useToast } from "../hooks/useToasts";
import { formatNumber } from "../lib/format";
import { parseLoginInput, SUGGESTED_USERS } from "../lib/login";
import { getRecentUsers, rememberUser, type RecentUser } from "../lib/recent";
import { exceedsStarCap, hasIndex, isActivePhase, isMetadataOnly, isStale } from "../lib/state";
import { rootRoute } from "./__root";

export const landingRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: LandingPage,
});

type Preview =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; data: UserPayload }
  | { status: "error"; error: ApiError };

function LandingPage() {
  const navigate = useNavigate();
  const toast = useToast();
  const [query, setQuery] = useState("");
  const [preview, setPreview] = useState<Preview>({ status: "idle" });
  const [starting, setStarting] = useState(false);
  const [recents, setRecents] = useState<RecentUser[]>(() => getRecentUsers());
  const [lastLogin, setLastLogin] = useState<string | null>(null);
  const [missingUser, setMissingUser] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    document.title = "starwatch — search any GitHub user's stars";
  }, []);

  const goSearch = useCallback(
    (login: string) => {
      void navigate({ to: "/u/$login", params: { login }, search: {} });
    },
    [navigate],
  );

  const submit = useCallback(
    async (raw: string) => {
      const login = parseLoginInput(raw);

      if (!login) {
        toast({
          title: "That doesn't look like a GitHub username",
          body: "Try alice, @alice, or github.com/alice.",
          tone: "error",
        });

        return;
      }

      setLastLogin(login);
      setMissingUser(null);
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      setPreview({ status: "loading" });

      try {
        const payload = await fetchUser(login, controller.signal);
        setRecents(rememberUser(payload.profile.login, payload.profile.name));
        setPreview({ status: "ready", data: payload });
      } catch (cause) {
        if (isAbortError(cause)) return;
        setPreview({ status: "error", error: asApiError(cause) });
      }
    },
    [toast],
  );

  const startIndex = useCallback(
    async (login: string, full: boolean) => {
      setStarting(true);
      setMissingUser(null);

      try {
        const result = await startUserSync(login, { full });

        if (!result.started) {
          toast({
            title: "Index up to date",
            body: "We checked just now — nothing new to fetch yet.",
          });
        }

        goSearch(login);
      } catch (cause) {
        const error = asApiError(cause);

        if (error.kind === "not-found") {
          // The sync endpoint fetches the GitHub profile itself, so a 404 here
          // means the username really does not exist.
          setMissingUser(login);
          toast({
            title: `No GitHub user named @${login}`,
            body: "Check the spelling — usernames use letters, numbers and single hyphens.",
            tone: "error",
          });
        } else {
          toast({ title: "Couldn't start indexing", body: error.message, tone: "error" });
        }
      } finally {
        setStarting(false);
      }
    },
    [goSearch, toast],
  );

  return (
    <div className="container landing">
      <section className="hero">
        <h1 className="hero__title">Search anyone&apos;s GitHub stars.</h1>
        <p className="hero__subtitle">
          Full-text and semantic search over public starred repos. No account, no GitHub token.
        </p>
        <SearchBar
          value={query}
          onSubmit={(value) => {
            setQuery(value);
            void submit(value);
          }}
          busy={preview.status === "loading"}
          autoFocus
          placeholder="@username, github.com/username, or a profile URL"
        />
        <p className="hero__try">
          Try{" "}
          {SUGGESTED_USERS.map((login, index) => (
            <span key={login}>
              {index > 0 ? " · " : ""}
              <button
                type="button"
                className="link-button"
                onClick={() => {
                  setQuery(`@${login}`);
                  void submit(`@${login}`);
                }}
              >
                @{login}
              </button>
            </span>
          ))}
        </p>
      </section>

      {preview.status === "loading" ? (
        <div className="preview-card preview-card--loading">
          <SkeletonCard />
        </div>
      ) : null}

      {preview.status === "error" && preview.error.kind === "not-found" ? (
        missingUser !== null ? (
          <section className="preview-card" aria-live="polite">
            <div className="preview-card__body">
              <p className="preview-card__name">
                We couldn&apos;t find a GitHub user named “@{missingUser}”
              </p>
              <p className="preview-card__meta">
                Check the spelling — usernames use letters, numbers and single hyphens.
              </p>
            </div>
          </section>
        ) : (
          <section className="preview-card" aria-live="polite">
            <div className="preview-card__body">
              <p className="preview-card__name">@{lastLogin ?? query} isn&apos;t indexed yet</p>
              <p className="preview-card__meta">
                Indexing reads the public star list first (searchable in seconds), then fills in
                READMEs and semantic search in the background.
              </p>
            </div>
            <div className="preview-card__actions">
              <button
                type="button"
                className="btn btn--primary"
                disabled={starting || lastLogin === null}
                onClick={() => {
                  if (lastLogin !== null) void startIndex(lastLogin, false);
                }}
              >
                {starting ? "Starting…" : "Index & search"}
              </button>
            </div>
          </section>
        )
      ) : null}

      {preview.status === "error" && preview.error.kind !== "not-found" ? (
        <ErrorState
          title="Couldn't look up that user"
          error={preview.error}
          onRetry={() => {
            void submit(query);
          }}
        />
      ) : null}

      {preview.status === "ready" ? (
        <PreviewCard
          data={preview.data}
          busy={starting}
          onSearch={() => goSearch(preview.data.profile.login)}
          onIndex={(full) => {
            void startIndex(preview.data.profile.login, full);
          }}
        />
      ) : null}

      {recents.length > 0 ? (
        <section className="recents" aria-label="Recently searched users">
          <h2 className="recents__title">Recent</h2>
          <div className="chip-row">
            {recents.map((user) => (
              <Link
                key={user.login}
                className="chip"
                to="/u/$login"
                params={{ login: user.login }}
                search={{}}
              >
                @{user.login}
              </Link>
            ))}
          </div>
        </section>
      ) : null}

      <section className="explainer">
        <h2 className="explainer__title">How it works</h2>
        <ul className="explainer__list">
          <li>Type any GitHub username — the shared community index is free to search.</li>
          <li>
            Metadata search works in ~10 seconds; semantic search fills in over the next few
            minutes.
          </li>
          <li>
            Collections come from the user&apos;s public GitHub Lists plus auto-generated ones.
          </li>
          <li>Public stars only. Private stars are never fetched or stored.</li>
        </ul>
      </section>
    </div>
  );
}

function PreviewCard({
  data,
  busy,
  onSearch,
  onIndex,
}: {
  data: UserPayload;
  busy: boolean;
  onSearch: () => void;
  onIndex: (full: boolean) => void;
}) {
  const { profile, state } = data;
  const indexed = hasIndex(state);
  const active = isActivePhase(state.phase);
  const stale = indexed && isStale(state);
  const capped = exceedsStarCap(state);
  const stars = state.starsTotal || state.reposMetadata;

  const primary = active
    ? { label: "Search what's loaded", run: onSearch }
    : indexed
      ? { label: `Search ${formatNumber(stars)} stars`, run: onSearch }
      : {
          label: capped ? `Index newest ${formatNumber(MAX_STARS)}` : "Index & search",
          run: () => onIndex(false),
        };

  const secondary = stale
    ? { label: "Refresh now", run: () => onIndex(true) }
    : state.phase === "failed" && indexed
      ? { label: "Retry indexing", run: () => onIndex(true) }
      : null;

  return (
    <section className="preview-card" aria-live="polite">
      <Avatar login={profile.login} name={profile.name} src={profile.avatarUrl} size={48} />
      <div className="preview-card__body">
        <p className="preview-card__name">{profile.name ?? `@${profile.login}`}</p>
        <p className="preview-card__meta">
          @{profile.login}
          {stars > 0 ? ` · ${formatNumber(stars)} public stars` : ""}
          {profile.bio ? ` · ${profile.bio}` : ""}
        </p>
        <p className="preview-card__state">
          <FreshnessChip state={state} />
          {isMetadataOnly(state) ? <span className="badge">◦ metadata only</span> : null}
        </p>
      </div>
      <div className="preview-card__actions">
        <button type="button" className="btn btn--primary" onClick={primary.run} disabled={busy}>
          {busy ? "Starting…" : primary.label}
        </button>
        {secondary ? (
          <button type="button" className="btn" onClick={secondary.run} disabled={busy}>
            {secondary.label}
          </button>
        ) : null}
      </div>
    </section>
  );
}
