import type { SearchHit } from "@starwatch/domain";
import { ScrollReveal } from "@/components/motion/scroll-reveal";
import { MemoResultCard } from "./ResultCard";

export interface ResultListProps {
  hits: ReadonlyArray<SearchHit>;
  groupNames: Readonly<Record<string, string>>;
  onOpen: (hit: SearchHit) => void;
}

/** The cap keeps a long page from revealing its last card noticeably late. */
const MAX_STAGGER_SECONDS = 0.24;

export function ResultList({ hits, groupNames, onOpen }: ResultListProps) {
  if (hits.length === 0) return null;

  return (
    <div className="flex flex-col gap-3">
      {hits.map((hit, index) => (
        <ScrollReveal
          key={hit.repo.id}
          y={12}
          amount="some"
          delay={Math.min(index * 0.03, MAX_STAGGER_SECONDS)}
          // The reveal starts hidden; printing must not inherit that, or a
          // printed result page would come out blank below the first screen.
          className="print:opacity-100! print:blur-none!"
        >
          <MemoResultCard hit={hit} groupNames={groupNames} onOpen={onOpen} index={index} />
        </ScrollReveal>
      ))}
    </div>
  );
}
