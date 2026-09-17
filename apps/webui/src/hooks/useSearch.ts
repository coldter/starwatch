import { useCallback, useEffect, useRef, useState } from "react";
import type { SearchMode, SearchResponse, SearchSort } from "@starwatch/domain";
import { ApiError, asApiError, fetchSearch, isAbortError, type SearchQuery } from "../api";
import { PAGE_SIZE } from "../lib/search-params";

export type SearchStatus = "loading" | "refreshing" | "ready" | "error";

export interface SearchQueryState {
  q: string;
  mode: SearchMode;
  /** Effective ordering: relevance for a query, a browse key when there is none. */
  sort: SearchSort;
  lang?: string;
  groups: string[];
  /** Worker semantics: `false` excludes archived, `true` is only archived. */
  archived?: boolean;
  minStars?: number;
  /** Row offset of the visible page; the worker returns `total` for the pager. */
  offset?: number;
}

export interface SearchResult {
  response: SearchResponse | null;
  status: SearchStatus;
  error: ApiError | null;
  retry: () => void;
}

interface FetchKey {
  login: string;
  query: string;
  mode: SearchMode;
  sort: SearchSort;
  lang: string | undefined;
  groupKey: string;
  archived: boolean | undefined;
  minStars: number | undefined;
  offset: number;
}

/**
 * One request per distinct query/filter/page tuple, always aborting the
 * previous in-flight call.
 *
 * An empty query is the browse state (docs/08 §3.4): the worker answers with
 * the filtered candidates ordered by `sort`, which the page defaults to
 * recently starred. The page owns the offset and pages through `response.total`
 * — browse covers the whole star list, a query covers its fused match set.
 */
export function useSearch(login: string, query: SearchQueryState): SearchResult {
  const { q, mode, sort, lang, archived, minStars } = query;
  const groupKey = query.groups.join(",");
  const offset = query.offset ?? 0;

  const [response, setResponse] = useState<SearchResponse | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [pending, setPending] = useState(true);
  const [lastKey, setLastKey] = useState<FetchKey | null>(null);
  const [attempt, setAttempt] = useState(0);
  const abortRef = useRef<AbortController | null>(null);

  const trimmed = q.trim();

  useEffect(() => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setPending(true);
    setError(null);

    const params: SearchQuery = {
      q: trimmed,
      mode,
      sort,
      lang,
      groups: groupKey ? groupKey.split(",") : [],
      archived,
      minStars,
      offset,
      limit: PAGE_SIZE,
    };

    fetchSearch(login, params, controller.signal)
      .then((next) => {
        if (abortRef.current !== controller) return;
        setResponse(next);
        setLastKey({
          login,
          query: trimmed,
          mode,
          sort,
          lang,
          groupKey,
          archived,
          minStars,
          offset,
        });
      })
      .catch((cause) => {
        if (isAbortError(cause) || abortRef.current !== controller) return;
        setError(asApiError(cause));
      })
      .finally(() => {
        if (abortRef.current === controller) {
          abortRef.current = null;
          setPending(false);
        }
      });

    return () => {
      controller.abort();
    };
  }, [login, trimmed, mode, sort, lang, groupKey, archived, minStars, offset, attempt]);

  // Never show results for a different user, query, filter set or page.
  const keyMatches =
    lastKey !== null &&
    lastKey.login === login &&
    lastKey.query === trimmed &&
    lastKey.mode === mode &&
    lastKey.sort === sort &&
    lastKey.lang === lang &&
    lastKey.groupKey === groupKey &&
    lastKey.archived === archived &&
    lastKey.minStars === minStars &&
    lastKey.offset === offset;

  const fresh = keyMatches ? response : null;

  // The effect that sets `pending` runs after paint, so a changed key is also
  // treated as loading: otherwise one frame renders "ready" with no response
  // and the results area collapses on every submit.
  const status: SearchStatus =
    fresh !== null
      ? pending
        ? "refreshing"
        : error !== null
          ? "error"
          : "ready"
      : !pending && error !== null
        ? "error"
        : "loading";

  const retry = useCallback(() => {
    setAttempt((value) => value + 1);
  }, []);

  return { response: fresh, status, error, retry };
}
