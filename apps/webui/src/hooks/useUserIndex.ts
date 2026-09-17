import { useCallback, useEffect, useRef, useState } from "react";
import * as Schema from "effect/Schema";
import { UserIndexState, type SyncPhase } from "@starwatch/domain";
import {
  ApiError,
  asApiError,
  fetchSyncState,
  fetchUser,
  isAbortError,
  startUserSync,
  userSyncEventsUrl,
  type UserPayload,
} from "../api";
import { isActivePhase, isTerminalPhase } from "../lib/state";
import { rememberUser } from "../lib/recent";

export type SyncTransport = "off" | "sse" | "polling";

export type StartSyncOutcome =
  | { ok: true; started: boolean; phase: SyncPhase }
  | { ok: false; error: ApiError };

export interface UserIndexResult {
  data: UserPayload | null;
  /** First page load (skeletons). */
  loading: boolean;
  /** Background refetch with content still on screen. */
  refreshing: boolean;
  error: ApiError | null;
  refresh: () => void;
  startSync: (options?: { full?: boolean }) => Promise<StartSyncOutcome>;
  syncPending: boolean;
  /** How live updates are flowing: SSE, 5s polling fallback, or off. */
  transport: SyncTransport;
}

/**
 * Owns `GET /api/users/:login` plus the sync lifecycle:
 * POST to start, SSE for progress, and a never-faster-than-5s polling
 * fallback when the stream fails (docs/13 §2(f): no fast polling on free).
 */
export function useUserIndex(login: string): UserIndexResult {
  const [data, setData] = useState<UserPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [syncPending, setSyncPending] = useState(false);
  const [forceWatch, setForceWatch] = useState(false);
  const [transport, setTransport] = useState<SyncTransport>("off");
  const fetchRef = useRef<AbortController | null>(null);

  const load = useCallback(
    async (background: boolean) => {
      fetchRef.current?.abort();
      const controller = new AbortController();
      fetchRef.current = controller;

      if (background) setRefreshing(true);
      else {
        setLoading(true);
        setError(null);
      }

      try {
        const payload = await fetchUser(login, controller.signal);
        rememberUser(payload.profile.login, payload.profile.name);
        setData(payload);
        setError(null);
      } catch (cause) {
        if (isAbortError(cause)) return;
        setError(asApiError(cause));
      } finally {
        if (fetchRef.current === controller) {
          fetchRef.current = null;
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [login],
  );

  useEffect(() => {
    setData(null);
    setError(null);
    setTransport("off");
    setForceWatch(false);
    void load(false);

    return () => {
      fetchRef.current?.abort();
      fetchRef.current = null;
    };
  }, [load]);

  const refresh = useCallback(() => {
    void load(true);
  }, [load]);

  const startSync = useCallback(
    async (options: { full?: boolean } = {}): Promise<StartSyncOutcome> => {
      setSyncPending(true);

      try {
        const result = await startUserSync(login, options);
        setData((prev) =>
          prev === null
            ? prev
            : {
                ...prev,
                // Only the phase is optimistic: `updatedAt` is the worker's
                // heartbeat, and inventing one here would hide a real stall
                // (see the ui-contract note on optimistic patches).
                state: { ...prev.state, phase: result.phase },
              },
        );

        if (result.started || isActivePhase(result.phase)) setForceWatch(true);
        setError(null);

        return { ok: true, started: result.started, phase: result.phase };
      } catch (cause) {
        if (isAbortError(cause)) {
          return { ok: false, error: new ApiError("network", "The sync request was cancelled.") };
        }

        return { ok: false, error: asApiError(cause) };
      } finally {
        setSyncPending(false);
      }
    },
    [login],
  );

  const phase = data?.state.phase;
  const active = phase !== undefined && isActivePhase(phase);
  const shouldWatch = forceWatch || active;

  // SSE first (docs/08 §2.5); EventSource reconnects once, then we fall back.
  useEffect(() => {
    if (!shouldWatch) {
      setTransport("off");

      return;
    }

    let closed = false;
    let errors = 0;
    const source = new EventSource(userSyncEventsUrl(login));

    source.onopen = () => {
      errors = 0;
      setTransport("sse");
    };

    source.onmessage = (event: MessageEvent<string>) => {
      let next: UserIndexState;

      try {
        next = Schema.decodeUnknownSync(UserIndexState)(JSON.parse(event.data));
      } catch {
        return; // Malformed frame — ignore without breaking the stream.
      }

      setData((prev) => (prev === null ? prev : { ...prev, state: next }));

      if (isTerminalPhase(next.phase)) {
        closed = true;
        source.close();
        setForceWatch(false);
        setTransport("off");

        // One authoritative read when the watch ends: the state stream carries
        // only `UserIndexState`, so a run that re-listed public Lists (group
        // membership) or moved the headline counters still needs the user
        // payload. Also covers a stream that closed before the last frame.
        void load(true);
      }
    };

    source.onerror = () => {
      if (closed) return;
      errors += 1;

      if (errors >= 2) {
        closed = true;
        source.close();
        setTransport("polling");
        setForceWatch(true);
      }
    };

    return () => {
      closed = true;
      source.close();
    };
  }, [shouldWatch, login, load]);

  // Polling fallback: every 5 seconds, never faster (free-tier request budget).
  useEffect(() => {
    if (transport !== "polling") return;
    let stopped = false;
    let controller: AbortController | null = null;

    const poll = async () => {
      controller?.abort();
      controller = new AbortController();

      try {
        const next = await fetchSyncState(login, controller.signal);

        if (stopped) return;
        setData((prev) => (prev === null ? prev : { ...prev, state: next }));

        if (isTerminalPhase(next.phase)) {
          setTransport("off");
          setForceWatch(false);
        }
      } catch (cause) {
        if (!isAbortError(cause) && !stopped) {
          // Transient failure: keep the fallback alive; the next tick retries.
        }
      }
    };

    void poll();

    const timer = window.setInterval(() => {
      void poll();
    }, 5000);

    return () => {
      stopped = true;
      controller?.abort();
      window.clearInterval(timer);
    };
  }, [transport, login]);

  return { data, loading, refreshing, error, refresh, startSync, syncPending, transport };
}
