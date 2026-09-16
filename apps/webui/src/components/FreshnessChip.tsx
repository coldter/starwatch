import type { UserIndexState } from "@starwatch/domain";
import { freshness, freshnessGlyph } from "../lib/state";

export interface FreshnessChipProps {
  state: UserIndexState | null | undefined;
  now?: number;
}

/** Header chip: `● Indexed 2h ago` / `◐ Loading stars…` / `⚠ stale` (docs/08 §3.4). */
export function FreshnessChip({ state, now }: FreshnessChipProps) {
  const info = freshness(state, now);

  return (
    <span className={`freshness freshness--${info.tone}`} title={info.detail}>
      <span className="freshness__glyph" aria-hidden="true">
        {freshnessGlyph(info.tone)}
      </span>
      <span>{info.label}</span>
    </span>
  );
}
