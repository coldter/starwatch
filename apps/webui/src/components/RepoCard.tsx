import { memo } from "react";
import type { SearchHit } from "@starwatch/domain";
import { formatCompact, relativeTime } from "../lib/format";
import { GroupChips } from "./GroupChips";
import { LanguageDot } from "./LanguageDot";
import { MatchedByBadge } from "./MatchedByBadge";

export interface RepoCardProps {
  hit: SearchHit;
  /** slug → display name for the user's collections. */
  groupNames: Readonly<Record<string, string>>;
  onOpen: (hit: SearchHit) => void;
}

function RepoCardBase({ hit, groupNames, onOpen }: RepoCardProps) {
  const { repo } = hit;
  const labels = hit.groups.map((slug) => groupNames[slug] ?? slug);
  const pushed = repo.pushedAt ? `pushed ${relativeTime(repo.pushedAt)}` : null;

  return (
    <article className="card">
      <header className="card__header">
        <a className="card__title" href={repo.htmlUrl} target="_blank" rel="noreferrer noopener">
          {repo.fullName}
        </a>
        {repo.archived ? <span className="badge badge--archived">archived</span> : null}
        {repo.license ? <span className="card__license">{repo.license}</span> : null}
      </header>

      {repo.description ? <p className="card__desc">{repo.description}</p> : null}

      <p className="card__meta">
        {repo.language ? (
          <span className="card__meta-item">
            <LanguageDot language={repo.language} />
            {repo.language}
          </span>
        ) : null}
        <span className="card__meta-item" title={`${repo.stars} stars`}>
          <span aria-hidden="true">★</span> {formatCompact(repo.stars)}
        </span>
        {pushed ? <span className="card__meta-item">{pushed}</span> : null}
        {repo.starredAt ? (
          <span className="card__meta-item">starred {relativeTime(repo.starredAt)}</span>
        ) : null}
      </p>

      {labels.length > 0 ? <GroupChips names={labels} /> : null}

      {hit.snippet ? <p className="card__snippet">{hit.snippet}</p> : null}

      <footer className="card__footer">
        <span className="chip-row">
          {hit.matchedBy.map((source) => (
            <MatchedByBadge key={source} source={source} />
          ))}
        </span>
        <span className="card__actions">
          <button type="button" className="btn btn--small" onClick={() => onOpen(hit)}>
            Details
          </button>
          <a className="btn btn--small btn--ghost" href={repo.htmlUrl} target="_blank" rel="noreferrer noopener">
            GitHub ↗
          </a>
        </span>
      </footer>
    </article>
  );
}

export const RepoCard = memo(RepoCardBase);
