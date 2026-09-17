import { useCallback, useEffect, useRef, useState } from "react";
import type { SearchMode, SearchResponse, SearchSort } from "@starwatch/domain";
import { ApiError, asApiError, fetchSearch, isAbortError, type SearchQuery } from "../api";
import { DEFAULT_SORT, SEARCH_LIMIT } from "../lib/search-params";

export type SearchStatus = "idle" | "loading" | "refreshing" | "ready" | "error";

export interface SearchQueryState {
  q: string;
  mode: SearchMode;
  /** Explicit result ordering; `relevance` is the default and the browse gate. */
  sort: SearchSort;
  lang?: string;
  groups: string[];
  /** Worker semantics: `false` excludes archived, `true` is only archived. */
  archived?: boolean;
  minStars?: number;
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
}

/**
 * One request per distinct query/filter tuple, always aborting the previous
 * in-flight call. An empty query is the browse state, except when an explicit
 * sort is active: the worker then answers with the filtered candidates ordered
 * by that key (docs/07 §Q6), which is how "recently pushed" works without text.
 */
export function useSearch(login: string, query: SearchQueryState): SearchResult {
  const { q, mode, sort, lang, archived, minStars } = query;
  const groupKey = query.groups.join(",");

  const [response, setResponse] = useState<SearchResponse | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [pending, setPending] = useState(false);
  const [lastKey, setLastKey] = useState<FetchKey | null>(null);
  const [attempt, setAttempt] = useState(0);
  const abortRef = useRef<AbortController | null>(null);

  const trimmed = q.trim();
  const browsing = trimmed === "" && sort !== DEFAULT_SORT;
  const active = trimmed !== "" || browsing;

  useEffect(() => {
    if (!active) {
      abortRef.current?.abort();
      abortRef.current = null;
      setPending(false);
      setError(null);

      return;
    }

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
      limit: SEARCH_LIMIT,
    };

    fetchSearch(login, params, controller.signal)
      .then((next) => {
        if (abortRef.current !== controller) return;
        setResponse(next);
        setLastKey({ login, query: trimmed, mode, sort, lang, groupKey, archived, minStars });
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
  }, [login, trimmed, mode, sort, lang, groupKey, archived, minStars, attempt, active]);

  // Never show results for a different user, query, or filter set.
  const keyMatches =
    lastKey !== null &&
    lastKey.login === login &&
    lastKey.query === trimmed &&
    lastKey.mode === mode &&
    lastKey.sort === sort &&
    lastKey.lang === lang &&
    lastKey.groupKey === groupKey &&
    lastKey.archived === archived &&
    lastKey.minStars === minStars;

  const fresh = keyMatches ? response : null;

  // The effect that sets `pending` runs after paint, so a changed key is also
  // treated as loading: otherwise one frame renders "ready" with no response
  // and the results area collapses on every submit.
  const status: SearchStatus = !active
    ? "idle"
    : fresh !== null
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
