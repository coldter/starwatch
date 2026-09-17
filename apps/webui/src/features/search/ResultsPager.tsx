import { Button } from "@/components/motion/button/base";
import { formatNumber } from "@/lib/format";

export interface ResultsPagerProps {
  page: number;
  pageCount: number;
  shownStart: number;
  shownEnd: number;
  total: number;
  onPage: (page: number) => void;
}

type PageEntry = number | "gap";

const WINDOW_SIZE = 3;

/**
 * First page, last page, and a short window around the current one — at most
 * seven buttons plus ellipses, so the row survives a narrow viewport.
 */
function pageEntries(page: number, pageCount: number): ReadonlyArray<PageEntry> {
  if (pageCount <= 7) {
    return Array.from({ length: pageCount }, (_, index) => index + 1);
  }

  const start = Math.max(2, page - 1);
  const end = Math.min(pageCount - 1, start + WINDOW_SIZE - 1);
  const first = Math.max(2, end - WINDOW_SIZE + 1);
  const entries: PageEntry[] = [1];

  if (first > 2) entries.push("gap");

  for (let number = first; number <= end; number++) {
    entries.push(number);
  }

  if (end < pageCount - 1) entries.push("gap");

  entries.push(pageCount);

  return entries;
}

export function ResultsPager({
  page,
  pageCount,
  shownStart,
  shownEnd,
  total,
  onPage,
}: ResultsPagerProps) {
  if (total === 0) return null;

  const pages = Math.max(1, pageCount);
  const current = Math.min(Math.max(1, page), pages);

  return (
    <nav
      aria-label="Search results pages"
      className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3 text-xs text-muted-foreground"
    >
      <span className="tabular-nums">
        Showing {formatNumber(shownStart)}–{formatNumber(shownEnd)} of {formatNumber(total)}
      </span>

      {pages > 1 ? (
        <span className="flex flex-wrap items-center gap-1">
          <Button
            variant="outline"
            size="sm"
            disabled={current <= 1}
            onClick={() => onPage(current - 1)}
          >
            Prev
          </Button>

          {pageEntries(current, pages).map((entry, position) =>
            entry === "gap" ? (
              <span key={`gap-${position}`} className="px-1" aria-hidden="true">
                …
              </span>
            ) : (
              <Button
                key={entry}
                variant={entry === current ? "secondary" : "ghost"}
                size="sm"
                className={
                  entry === current
                    ? "min-w-8 bg-accent font-semibold tabular-nums"
                    : "min-w-8 tabular-nums"
                }
                aria-label={`Page ${entry}`}
                aria-current={entry === current ? "page" : undefined}
                onClick={() => onPage(entry)}
              >
                {entry}
              </Button>
            ),
          )}

          <Button
            variant="outline"
            size="sm"
            disabled={current >= pages}
            onClick={() => onPage(current + 1)}
          >
            Next
          </Button>
        </span>
      ) : null}
    </nav>
  );
}
