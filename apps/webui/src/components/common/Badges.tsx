import { Archive, CircleSlash, Equal, Sparkles, Type } from "lucide-react";
import type { MatchSource } from "@starwatch/domain";
import { AnimatedBadge, type AnimatedBadgeStatus } from "@/components/motion/animated-badge";
import { freshness, type FreshnessTone } from "@/lib/state";
import { cn } from "@/lib/utils";

/**
 * AnimatedBadge ships raw palette pairs for its statuses; these classNames
 * re-point them at the design system's status tokens (twMerge keeps the last
 * value for each utility group), so light/dark tuning lives in styles.css.
 */
const TOKEN_TINT: Record<AnimatedBadgeStatus, string> = {
  neutral: "border-border bg-muted/60 text-muted-foreground",
  info: "border-info/30 bg-info/10 text-info",
  success: "border-live/30 bg-live/10 text-live",
  warning: "border-warn/30 bg-warn/10 text-warn",
  danger: "border-destructive/30 bg-destructive/10 text-destructive",
  loading: "border-info/30 bg-info/10 text-info",
};

const FRESHNESS_STATUS: Record<FreshnessTone, AnimatedBadgeStatus> = {
  none: "neutral",
  active: "loading",
  fresh: "success",
  stale: "warning",
  paused: "warning",
  failed: "danger",
};

/**
 * Index freshness for a user. One badge owns the whole vocabulary — indexing
 * in progress, freshly synced, stale, paused on a rate limit, failed — so the
 * same state never reads two different ways in two places.
 */
export function FreshnessBadge({
  state,
  now,
  className,
}: {
  state: Parameters<typeof freshness>[0];
  now?: number;
  className?: string;
}) {
  const info = freshness(state, now);

  return (
    <AnimatedBadge
      status={FRESHNESS_STATUS[info.tone]}
      size="sm"
      contentKey={info.label}
      className={cn(TOKEN_TINT[FRESHNESS_STATUS[info.tone]], className)}
      title={info.detail}
    >
      {info.label}
    </AnimatedBadge>
  );
}

const MATCH_COPY: Record<
  MatchSource,
  { label: string; title: string; status: AnimatedBadgeStatus; Icon: typeof Type }
> = {
  name: {
    label: "name",
    title: "Matched the repository name",
    status: "info",
    Icon: Type,
  },
  keyword: {
    label: "keyword",
    title: "Matched repo text: description, topics or README",
    status: "neutral",
    Icon: Equal,
  },
  expanded: {
    label: "related",
    title: "Matched through a related term the index expanded to",
    status: "warning",
    Icon: Sparkles,
  },
  semantic: {
    label: "meaning",
    title: "Matched by meaning rather than exact words",
    status: "success",
    Icon: Sparkles,
  },
};

/** Explains why a result is in the list, from the search response's `matchedBy`. */
export function MatchBadge({ source }: { source: MatchSource }) {
  const { label, title, status, Icon } = MATCH_COPY[source];

  return (
    <AnimatedBadge
      status={status}
      size="sm"
      icon={<Icon className="size-3" />}
      title={title}
      className={cn("text-[0.6875rem] tracking-wide", TOKEN_TINT[status])}
    >
      {label}
    </AnimatedBadge>
  );
}

/** Archived repos stay visible, but never look like a live project. */
export function ArchivedBadge({ className }: { className?: string }) {
  return (
    <AnimatedBadge
      status="warning"
      size="sm"
      icon={<Archive className="size-3" />}
      title="The owner archived this repository on GitHub"
      className={cn("text-[0.6875rem]", TOKEN_TINT.warning, className)}
    >
      archived
    </AnimatedBadge>
  );
}

/** A read-only collection (GitHub List) name. */
export function CollectionChip({ name, className }: { name: string; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full bg-accent px-2 py-0.5 text-[0.6875rem] font-medium text-accent-foreground",
        className,
      )}
      title={name}
    >
      <CircleSlash className="size-3 shrink-0 opacity-60" aria-hidden="true" />
      {name}
    </span>
  );
}

/** A plain topic tag. */
export function TopicChip({ children, className }: { children: string; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border border-border px-2 py-0.5 font-mono text-[0.6875rem] text-muted-foreground",
        className,
      )}
    >
      {children}
    </span>
  );
}
