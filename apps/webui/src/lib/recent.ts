import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/**
 * Recent users, localStorage-only (docs/08 §3.2): login + freshness hints,
 * nothing personal ever leaves the browser. Stored entries are decoded with
 * `RecentUser` before they reach the UI, so one corrupted entry never drops
 * the rest of the list.
 */

const STORAGE_KEY = "starwatch.recentUsers.v1";

const MAX_RECENTS = 8;

const RecentUser = Schema.Struct({
  login: Schema.String,
  /** ISO timestamp of the last successful lookup. */
  at: Schema.String,
  name: Schema.optional(Schema.String),
});

export type RecentUser = typeof RecentUser.Type;

/** The stored envelope: a JSON array whose entries are decoded one by one. */
const StoredRecents = Schema.fromJsonString(Schema.Array(Schema.Unknown));

export function getRecentUsers(): RecentUser[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);

    if (!raw) return [];
    const stored = Option.getOrElse(
      Schema.decodeUnknownOption(StoredRecents)(raw),
      () => [],
    );
    const users: RecentUser[] = [];

    for (const entry of stored) {
      const decoded = Schema.decodeUnknownOption(RecentUser)(entry);

      if (Option.isSome(decoded) && users.length < MAX_RECENTS)
        users.push(decoded.value);
    }

    return users;
  } catch {
    return [];
  }
}

/** Promote `login` to the top of the recents list; returns the new list. */
export function rememberUser(
  login: string,
  name?: string | null,
): RecentUser[] {
  const at = new Date().toISOString();
  const entry: RecentUser = name ? { login, at, name } : { login, at };

  const next = [
    entry,
    ...getRecentUsers().filter(
      (user) => user.login.toLowerCase() !== login.toLowerCase(),
    ),
  ].slice(0, MAX_RECENTS);

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
