import { formatNumber } from "../lib/format";

export interface PaginationProps {
  page: number;
  pageCount: number;
  total: number;
  shownStart: number;
  shownEnd: number;
  onPage: (page: number) => void;
}

/** Client-side pagination over the returned hit list (limit 50, 20/page). */
export function Pagination({
  page,
  pageCount,
  total,
  shownStart,
  shownEnd,
  onPage,
}: PaginationProps) {
  if (total === 0) return null;

  return (
    <nav className="pagination" aria-label="Search results pages">
      <span className="pagination__summary">
        Showing {formatNumber(shownStart)}–{formatNumber(shownEnd)} of{" "}
        {formatNumber(total)}
      </span>
      {pageCount > 1 ? (
        <span className="pagination__controls">
          <button
            type="button"
            className="btn btn--small"
            disabled={page <= 1}
            onClick={() => onPage(page - 1)}
          >
            ← Prev
          </button>
          <span className="pagination__page" aria-current="page">
            Page {page} of {pageCount}
          </span>
          <button
            type="button"
            className="btn btn--small"
            disabled={page >= pageCount}
            onClick={() => onPage(page + 1)}
          >
            Next →
          </button>
        </span>
      ) : null}
    </nav>
  );
}
