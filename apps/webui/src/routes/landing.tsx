/**
 * DRAFT — parent-owned. Copied into src/routes/landing.tsx once every feature
 * slice lands. Kept outside src/ so the parallel workers' typecheck stays clean.
 */
import { useCallback, useRef, useState } from "react";
import { createRoute, useNavigate } from "@tanstack/react-router";
import { Database } from "lucide-react";
import { MAX_STARS } from "@starwatch/domain";
import {
  asApiError,
  fetchUser,
  isAbortError,
  startUserSync,
  type ApiError,
  type UserPayload,
} from "@/api";
import { useToast } from "@/app/toast";
import { Button } from "@/components/motion/button/base";
import { ErrorPanel, NoticeStrip, StatePanel } from "@/components/common/StatePanel";
import { HeroSkeleton } from "@/components/common/Skeletons";
import { HowItWorks } from "@/features/landing/HowItWorks";
import { LandingHero } from "@/features/landing/LandingHero";
import { RecentUsers } from "@/features/landing/RecentUsers";
import { UserPreviewCard, type PreviewAction } from "@/features/landing/UserPreviewCard";
import { useDocumentTitle } from "@/hooks/useDocumentTitle";
import { useSearchShortcut } from "@/hooks/useSearchShortcut";
import { formatNumber, plural } from "@/lib/format";
import { parseLoginInput, SUGGESTED_USERS } from "@/lib/login";
import { getRecentUsers, rememberUser, type RecentUser } from "@/lib/recent";
import { exceedsStarCap, hasIndex, isActivePhase, isStale } from "@/lib/state";
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

  useDocumentTitle("starwatch — search anyone's GitHub stars");
  useSearchShortcut();

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
        toast.error("Not a GitHub username", "Try alice, @alice, or github.com/alice.");

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
          toast.info("Nothing new to index yet", "GitHub has no newer stars to read.");
        }

        goSearch(login);
      } catch (cause) {
        const error = asApiError(cause);

        if (error.kind === "not-found") {
          // The sync endpoint reads the GitHub profile itself, so a 404 here
          // means the username really does not exist.
          setMissingUser(login);
          toast.error(
            `No GitHub user named @${login}`,
            "Check the spelling — usernames use letters, numbers and single hyphens.",
          );
        } else {
          toast.error("Couldn't start indexing", error.message);
        }
      } finally {
        setStarting(false);
      }
    },
    [goSearch, toast],
  );

  const pickSuggestion = useCallback(
    (login: string) => {
      setQuery(`@${login}`);
      void submit(`@${login}`);
    },
    [submit],
  );

  const previewUser = preview.status === "ready" ? preview.data : null;

  return (
    <div className="page-shell flex flex-col gap-10 py-10 sm:gap-14 sm:py-16">
      <LandingHero
        value={query}
        busy={preview.status === "loading"}
        suggestions={SUGGESTED_USERS}
        onChange={setQuery}
        onSubmit={(value) => {
          setQuery(value);
          void submit(value);
        }}
        onPickSuggestion={pickSuggestion}
      />

      {preview.status === "loading" ? <HeroSkeleton /> : null}

      {preview.status === "error" && preview.error.kind === "not-found" ? (
        missingUser !== null ? (
          <NoticeStrip tone="error" icon={Database}>
            No GitHub user named &ldquo;@{missingUser}&rdquo;. Check the spelling — usernames use
            letters, numbers and single hyphens.
          </NoticeStrip>
        ) : (
          <StatePanel
            icon={Database}
            title={`@${lastLogin ?? query} isn't in the shared index yet`}
            body="Indexing loads the public star list first; keyword search works within seconds."
          >
            <Button
              variant="primary"
              size="sm"
              disabled={starting || lastLogin === null}
              onClick={() => {
                if (lastLogin !== null) void startIndex(lastLogin, false);
              }}
            >
              {starting ? "Starting…" : "Index and search"}
            </Button>
          </StatePanel>
        )
      ) : null}

      {preview.status === "error" && preview.error.kind !== "not-found" ? (
        <ErrorPanel
          title="Couldn't look up that user"
          error={preview.error}
          onRetry={() => {
            void submit(query);
          }}
        />
      ) : null}

      {previewUser ? (
        <UserPreviewCard
          data={previewUser}
          busy={starting}
          primary={primaryAction(previewUser, goSearch, startIndex)}
          secondary={secondaryAction(previewUser, startIndex)}
        />
      ) : null}

      <RecentUsers users={recents} onPick={goSearch} />
      <HowItWorks />
    </div>
  );
}

/** The one action worth taking for the user that was just looked up. */
function primaryAction(
  data: UserPayload,
  onSearch: (login: string) => void,
  onIndex: (login: string, full: boolean) => void,
): PreviewAction {
  const { login } = data.profile;
  const { state } = data;
  const indexed = hasIndex(state);
  const active = isActivePhase(state.phase);
  const stars = state.starsTotal || state.reposMetadata;

  if (active) return { label: "Search what's loaded", onClick: () => onSearch(login) };

  if (indexed)
    return {
      label: `Search ${formatNumber(stars)} ${plural(stars, "star")}`,
      onClick: () => onSearch(login),
    };

  if (exceedsStarCap(state))
    return {
      label: `Index newest ${formatNumber(MAX_STARS)}`,
      onClick: () => onIndex(login, false),
    };

  return { label: "Index and search", onClick: () => onIndex(login, false) };
}

/** Refresh or retry, only when the index state actually asks for it. */
function secondaryAction(
  data: UserPayload,
  onIndex: (login: string, full: boolean) => void,
): PreviewAction | null {
  const { login } = data.profile;
  const { state } = data;

  if (hasIndex(state) && isStale(state))
    return {
      label: "Refresh now",
      onClick: () => onIndex(login, true),
    };

  if (hasIndex(state) && state.phase === "failed")
    return {
      label: "Retry indexing",
      onClick: () => onIndex(login, true),
    };

  return null;
}
