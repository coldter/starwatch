import { memo } from "react";
import { ExternalLink, Star } from "lucide-react";
import type { SearchHit } from "@starwatch/domain";
import { ArchivedBadge, CollectionChip, MatchBadge } from "@/components/common/Badges";
import { LanguageDot } from "@/components/common/LanguageDot";
import { Button, ButtonLink } from "@/components/motion/button/base";
import { formatCompact, formatNumber, relativeTime } from "@/lib/format";

export interface ResultCardProps {
  hit: SearchHit;
  /** slug → display name for `hit.groups`. */
  groupNames: Readonly<Record<string, string>>;
  onOpen: (hit: SearchHit) => void;
  /** Position in the result list; the list owns the reveal pacing built on it. */
  index?: number;
}

interface CollectionLabel {
  slug: string;
  name: string;
}

export function ResultCard({ hit, groupNames, onOpen, index = 0 }: ResultCardProps) {
  const { repo } = hit;
  const collections: CollectionLabel[] = [];

  for (const slug of hit.groups) {
    collections.push({ slug, name: groupNames[slug] ?? slug });
  }

  return (
    <article
      data-index={index}
      className="rounded-2xl border border-border bg-card p-4 transition-colors hover:border-border-strong sm:p-5"
    >
      <div className="flex flex-col gap-2.5">
        <header className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <h3 className="min-w-0 max-w-full text-sm font-semibold tracking-tight sm:text-base">
            <a
              href={repo.htmlUrl}
              target="_blank"
              rel="noreferrer noopener"
              title={repo.fullName}
              className="block truncate text-foreground underline-offset-4 hover:underline focus-visible:underline"
            >
              {repo.fullName}
            </a>
          </h3>
          {repo.archived ? <ArchivedBadge /> : null}
        </header>

        {repo.description ? (
          <p className="line-clamp-2 text-sm leading-relaxed text-muted-foreground">
            {repo.description}
          </p>
        ) : null}

        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          {repo.language ? (
            <span className="inline-flex items-center gap-1.5">
              <LanguageDot language={repo.language} />
              {repo.language}
            </span>
          ) : null}
          <span
            className="inline-flex items-center gap-1 tabular-nums"
            title={`${formatNumber(repo.stars)} stars`}
          >
            <Star className="size-3 text-star" aria-hidden="true" />
            {formatCompact(repo.stars)}
          </span>
          <span className="tabular-nums">pushed {relativeTime(repo.pushedAt)}</span>
          {repo.starredAt ? (
            <span className="tabular-nums">starred {relativeTime(repo.starredAt)}</span>
          ) : null}
        </p>

        {collections.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {collections.map((collection) => (
              <CollectionChip key={collection.slug} name={collection.name} />
            ))}
          </div>
        ) : null}

        {hit.snippet ? (
          <blockquote className="border-l-2 border-border-strong pl-3 text-sm leading-relaxed text-muted-foreground">
            {hit.snippet}
          </blockquote>
        ) : null}

        <footer className="flex flex-wrap items-center justify-between gap-2 pt-0.5">
          <span className="flex flex-wrap items-center gap-1.5">
            {hit.matchedBy.map((source) => (
              <MatchBadge key={source} source={source} />
            ))}
          </span>
          <span className="flex items-center gap-1.5">
            <Button variant="secondary" size="sm" onClick={() => onOpen(hit)}>
              Details
            </Button>
            <ButtonLink
              variant="ghost"
              size="sm"
              href={repo.htmlUrl}
              target="_blank"
              rel="noreferrer noopener"
            >
              GitHub
              <ExternalLink className="size-3.5" aria-hidden="true" />
            </ButtonLink>
          </span>
        </footer>
      </div>
    </article>
  );
}

export const MemoResultCard = memo(ResultCard);
