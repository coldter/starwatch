import type { MatchSource } from "@starwatch/domain";

const LABELS: Record<MatchSource, string> = {
  keyword: "keyword",
  expanded: "expanded",
  semantic: "semantic",
  name: "name",
};

const TITLES: Record<MatchSource, string> = {
  keyword: "Matched from repo text (name, description, topics, README)",
  expanded: "Matched through a related concept",
  semantic: "Matched by meaning, not exact words",
  name: "Matched the repository name",
};

export function MatchedByBadge({ source }: { source: MatchSource }) {
  return (
    <span className={`badge badge--match badge--match-${source}`} title={TITLES[source]}>
      {LABELS[source]}
    </span>
  );
}
