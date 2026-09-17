import { Building2, MapPin, Star, type LucideIcon } from "lucide-react";
import { MAX_STARS, type UserIndexState, type UserProfile } from "@starwatch/domain";
import { AnimatedBadge } from "@/components/motion/animated-badge";
import { AnimatedNumber } from "@/components/motion/animated-number";
import { Button } from "@/components/motion/button/base";
import { Avatar } from "@/components/common/Avatar";
import { FreshnessBadge } from "@/components/common/Badges";
import { formatCompact, formatNumber, plural } from "@/lib/format";
import { exceedsStarCap, hasIndex, isActivePhase, isMetadataOnly, isStale } from "@/lib/state";

export interface ProfileHeaderProps {
  profile: UserProfile;
  state: UserIndexState;
  /** A start-sync request is in flight. */
  busy: boolean;
  /** A background re-check is in flight. */
  refreshing: boolean;
  onStartSync: (options?: { full?: boolean }) => void;
  onRefresh: () => void;
}

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
  refreshing,
  onStartSync,
  onRefresh,
}: ProfileHeaderProps) {
  const indexed = hasIndex(state);
  const active = isActivePhase(state.phase);
  const stale = isStale(state);
  const stars = state.starsTotal || state.reposMetadata;

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
            {isMetadataOnly(state) ? (
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
        <Button
          variant="primary"
          size="md"
          disabled={busy || active}
          onClick={() => onStartSync({ full: stale })}
        >
          {primaryActionLabel(indexed, active, stale)}
        </Button>
        <Button variant="ghost" size="md" disabled={refreshing} onClick={onRefresh}>
          {refreshing ? "Checking…" : "Re-check"}
        </Button>
      </div>
    </header>
  );
}
