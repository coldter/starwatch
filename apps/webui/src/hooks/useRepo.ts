import { useCallback, useEffect, useState } from "react";
import { ApiError, asApiError, fetchRepo, isAbortError, type RepoPayload } from "../api";

export interface RepoResult {
  data: RepoPayload | null;
  loading: boolean;
  error: ApiError | null;
  retry: () => void;
}

/** `GET /api/repos/:owner/:name` for the detail drawer. */
export function useRepo(owner: string | null, name: string | null): RepoResult {
  const [data, setData] = useState<RepoPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!owner || !name) {
      setData(null);
      setLoading(false);
      setError(null);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    setData(null);

    fetchRepo(owner, name, controller.signal)
      .then((payload) => {
        if (controller.signal.aborted) return;
        setData(payload);
      })
      .catch((cause) => {
        if (isAbortError(cause)) return;
        setError(asApiError(cause));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => controller.abort();
  }, [owner, name, attempt]);

  const retry = useCallback(() => {
    setAttempt((value) => value + 1);
  }, []);

  return { data, loading, error, retry };
}
