import { Building2, MapPin, RefreshCw, Star, type LucideIcon } from "lucide-react";
import { MAX_STARS, type UserIndexState, type UserProfile } from "@starwatch/domain";
import { useSemanticSearch } from "@/app/capabilities";
import { AnimatedBadge } from "@/components/motion/animated-badge";
import { AnimatedNumber } from "@/components/motion/animated-number";
import { Button } from "@/components/motion/button/base";
import { Tooltip } from "@/components/motion/tooltip";
import { Avatar } from "@/components/common/Avatar";
import { FreshnessBadge } from "@/components/common/Badges";
import { formatCompact, formatNumber, plural } from "@/lib/format";
import {
  exceedsStarCap,
  hasIndex,
  isActivePhase,
  isMetadataOnly,
  isStale,
  type SyncWindow,
} from "@/lib/state";

export interface ProfileHeaderProps {
  profile: UserProfile;
  state: UserIndexState;
  /** A start-sync request is in flight. */
  busy: boolean;
  onStartSync: (options?: { full?: boolean }) => void;
  /** Cheap metadata re-list: ask GitHub for the star list again. */
  onRecheck: () => void;
  /** Per-account daily window (`lib/state.syncWindow`). */
  syncWindow: SyncWindow;
  /**
   * A sync was attempted while the daily window is closed. The controls are
   * `aria-disabled` rather than `disabled`, so the click still lands here and
   * the page can explain *why* instead of leaving a dead button.
   */
  onBlockedSync: () => void;
}

/** Why both sync controls can be unavailable, in one sentence. */
const WINDOW_EXPLAINER =
  "This account was synced less than 24 hours ago — one sync per account per day keeps GitHub's limits fair.";

/**
 * Primary sync action label. An active run always reads as indexing, even when
 * the first listing has not produced metadata yet; otherwise the label follows
 * whether an index exists and how old it is.
 */
function primaryActionLabel(indexed: boolean, active: boolean, stale: boolean): string {
  if (active) return "Indexing…";

  if (!indexed) return "Index now";

  if (stale) return "Refresh now";

  return "Refresh index";
}

/** One headline number with its unit. */
function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-center gap-1.5">
      <AnimatedNumber value={value} format={formatNumber} className="font-medium text-foreground" />
      <span className="text-muted-foreground">{label}</span>
    </div>
  );
}

/** A non-numeric profile fact (location, company). */
function Meta({ icon: Icon, text }: { icon: LucideIcon; text: string }) {
  return (
    <span className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
      <Icon className="size-3.5 shrink-0" aria-hidden="true" />
      <span className="truncate">{text}</span>
    </span>
  );
}

/**
 * The user page identity block: avatar, name, GitHub link, bio, headline stats
 * and the two sync controls. It is the one place that says whether this index
 * is live, stale, capped or metadata-only.
 */
export function ProfileHeader({
  profile,
  state,
  busy,
  onStartSync,
  onRecheck,
  syncWindow,
  onBlockedSync,
}: ProfileHeaderProps) {
  const indexed = hasIndex(state);
  const active = isActivePhase(state.phase);
  const stale = isStale(state);
  const stars = state.starsTotal || state.reposMetadata;
  // "Metadata only" is a gap only where vectors are expected; on a keyword-only
  // deployment it is simply what the index is, so the badge never renders.
  const semanticSearch = useSemanticSearch();

  // A run already in flight outranks the window: the buttons belong to it.
  const running = busy || active;
  const blocked = !syncWindow.open && !running;
  const windowHint = `${WINDOW_EXPLAINER} ${syncWindow.label}.`;

  const primaryHint = blocked
    ? windowHint
    : semanticSearch
      ? "Read this account's stars again. A stale index also refetches READMEs and rebuilds the semantic index."
      : "Read this account's stars again. A stale index also refetches READMEs.";

  return (
    <header className="flex flex-col gap-4">
      <div className="flex items-start gap-4">
        <Avatar login={profile.login} name={profile.name} src={profile.avatarUrl} size={64} />
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
            <h1 className="text-2xl font-semibold tracking-tight text-balance-pretty sm:text-3xl">
              {profile.name ?? `@${profile.login}`}
            </h1>
            <FreshnessBadge state={state} />
            {semanticSearch && isMetadataOnly(state) ? (
              <AnimatedBadge status="info" size="sm" contentKey="metadata-only">
                metadata only
              </AnimatedBadge>
            ) : null}
            {exceedsStarCap(state) ? (
              <AnimatedBadge status="warning" size="sm" contentKey="star-cap">
                capped at {formatCompact(MAX_STARS)} stars
              </AnimatedBadge>
            ) : null}
          </div>

          <a
            href={`https://github.com/${profile.login}`}
            target="_blank"
            rel="noreferrer noopener"
            className="w-fit text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
          >
            @{profile.login}
          </a>

          {profile.bio ? (
            <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground text-balance-pretty">
              {profile.bio}
            </p>
          ) : null}

          <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-sm">
            <div className="flex items-center gap-1.5">
              <Star className="size-3.5 fill-star text-star" aria-hidden="true" />
              <AnimatedNumber
                value={stars}
                format={formatNumber}
                className="font-medium text-foreground"
              />
              <span className="text-muted-foreground">{plural(stars, "star")}</span>
            </div>
            <Stat label={plural(profile.followers, "follower")} value={profile.followers} />
            <Stat label={plural(profile.publicRepos, "public repo")} value={profile.publicRepos} />
            {profile.location ? <Meta icon={MapPin} text={profile.location} /> : null}
            {profile.company ? <Meta icon={Building2} text={profile.company} /> : null}
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Tooltip content={primaryHint} side="bottom">
          <Button
            variant="primary"
            size="md"
            disabled={running}
            aria-disabled={blocked}
            className={blocked ? "opacity-60" : undefined}
            onClick={() => (blocked ? onBlockedSync() : onStartSync({ full: stale }))}
          >
            {primaryActionLabel(indexed, running, stale)}
          </Button>
        </Tooltip>
        <Tooltip
          content={
            blocked
              ? windowHint
              : "List your starred repos again — metadata only, no READMEs. GitHub is asked once per account per day."
          }
          side="bottom"
        >
          <Button
            variant="ghost"
            size="md"
            disabled={running}
            aria-disabled={blocked}
            className={blocked ? "opacity-60" : undefined}
            onClick={onRecheck}
          >
            <RefreshCw className="size-3.5" aria-hidden="true" />
            Re-check GitHub
          </Button>
        </Tooltip>
      </div>

      {/* Sighted and screen-reader users both need the reason without hovering. */}
      {blocked ? <p className="text-xs text-muted-foreground">{syncWindow.label}</p> : null}
    </header>
  );
}
