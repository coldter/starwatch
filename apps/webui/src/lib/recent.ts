/**
 * Recent users, localStorage-only (docs/08 §3.2): login + freshness hints,
 * nothing personal ever leaves the browser.
 */

const STORAGE_KEY = "starwatch.recentUsers.v1";
const MAX_RECENTS = 8;

export interface RecentUser {
  login: string;
  /** ISO timestamp of the last successful lookup. */
  at: string;
  name?: string;
}

function isRecentUser(value: unknown): value is RecentUser {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.login === "string" && typeof candidate.at === "string";
}

export function getRecentUsers(): RecentUser[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isRecentUser).slice(0, MAX_RECENTS);
  } catch {
    return [];
  }
}

/** Promote `login` to the top of the recents list; returns the new list. */
export function rememberUser(login: string, name?: string | null): RecentUser[] {
  const entry: RecentUser = { login, at: new Date().toISOString() };
  if (name) entry.name = name;
  const next = [entry, ...getRecentUsers().filter((user) => user.login.toLowerCase() !== login.toLowerCase())].slice(
    0,
    MAX_RECENTS
  );
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Storage disabled (private mode) — recents simply don't persist.
  }
  return next;
}

export function clearRecentUsers(): RecentUser[] {
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
  return [];
}
