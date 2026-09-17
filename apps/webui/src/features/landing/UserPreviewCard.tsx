import { MAX_STARS } from "@starwatch/domain";
import type { UserPayload } from "@/api";
import { Avatar } from "@/components/common/Avatar";
import { FreshnessBadge } from "@/components/common/Badges";
import { AnimatedBadge } from "@/components/motion/animated-badge";
import { AnimatedNumber } from "@/components/motion/animated-number";
import { Button } from "@/components/motion/button/base";
import { formatNumber, plural } from "@/lib/format";
import { exceedsStarCap, isMetadataOnly } from "@/lib/state";

export interface PreviewAction {
  label: string;
  onClick: () => void;
  disabled?: boolean;
}

export interface UserPreviewCardProps {
  data: UserPayload;
  busy: boolean;
  primary: PreviewAction;
  secondary?: PreviewAction | null;
}

/**
 * A user resolved from GitHub, before and while their stars are indexed: who
 * they are, how much is searchable, and the one action that moves forward.
 * `aria-live` announces the card as it appears under the search form.
 */
export function UserPreviewCard({ data, busy, primary, secondary }: UserPreviewCardProps) {
  const { profile, state } = data;
  const displayName = profile.name ?? `@${profile.login}`;
  const stars = state.starsTotal || state.reposMetadata;
  const metadataOnly = isMetadataOnly(state);
  const capped = exceedsStarCap(state);

  return (
    <section
      className="mx-auto flex w-full max-w-3xl flex-col gap-4 rounded-2xl border border-border bg-card p-5 sm:flex-row sm:items-start"
      aria-live="polite"
    >
      <Avatar login={profile.login} name={profile.name} src={profile.avatarUrl} size={56} />

      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
          <h2 className="min-w-0 truncate text-base font-semibold tracking-tight">{displayName}</h2>
          <FreshnessBadge state={state} />
          {metadataOnly ? (
            <AnimatedBadge status="neutral" size="sm" showIcon={false}>
              metadata only
            </AnimatedBadge>
          ) : null}
          {capped ? (
            <AnimatedBadge status="warning" size="sm" showIcon={false}>
              capped at {formatNumber(MAX_STARS)} stars
            </AnimatedBadge>
          ) : null}
        </div>

        <p className="text-sm text-muted-foreground">
          <span className="text-foreground">@{profile.login}</span>
          <span aria-hidden="true"> · </span>
          <AnimatedNumber value={stars} className="text-foreground" /> public{" "}
          {plural(stars, "star")}
        </p>

        {profile.bio ? (
          <p className="max-w-prose text-sm leading-relaxed text-muted-foreground">{profile.bio}</p>
        ) : null}

        <div className="flex flex-wrap items-center gap-2 pt-0.5">
          <Button size="sm" disabled={busy || primary.disabled} onClick={primary.onClick}>
            {busy ? "Starting…" : primary.label}
          </Button>
          {secondary ? (
            <Button
              variant="outline"
              size="sm"
              disabled={busy || secondary.disabled}
              onClick={secondary.onClick}
            >
              {secondary.label}
            </Button>
          ) : null}
        </div>
      </div>
    </section>
  );
}
