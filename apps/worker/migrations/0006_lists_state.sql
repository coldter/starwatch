-- 0006 — last public-Lists import outcome per account.
--
-- `groups`/`group_repos` hold the imported lists, but an empty set is
-- ambiguous: it means either "this account has no public Lists" or "the last
-- import could not read them" (no token, GitHub rate limit, upstream error).
-- The collections rail must not claim the former when the latter is true, so
-- the outcome is recorded here. `replaceGroups` only runs on a successful
-- fetch, and a failed fetch leaves the stored lists (and this failure state)
-- intact — the source of truth for "did we ever really read the lists?".

CREATE TABLE IF NOT EXISTS user_lists_state (
  login      TEXT PRIMARY KEY,
  state      TEXT NOT NULL DEFAULT 'never',
  error      TEXT,
  checked_at TEXT
);
