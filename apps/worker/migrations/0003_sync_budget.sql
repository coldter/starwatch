-- 0003 — per-IP daily sync-trigger budget (abuse protection).
--
-- The public service has no accounts, so the only identity a burst can be
-- attributed to is the caller's IP (`cf-connecting-ip`). `POST
-- /users/:login/sync` is the one endpoint whose cost lands on GitHub's shared
-- quota, so it gets a counter on top of the per-IP *burst* limit that the
-- runtime rate-limit binding already enforces (5/60 s, docs/14 §4): the burst
-- limiter absorbs double-clicks, this table stops a patient retry loop.
--
-- Shape: one row per (ip, day). `day` is the UTC date, so the window rolls at
-- midnight UTC for every caller at once — a rolling window would need a
-- timestamp history, and a public service only needs "50 attempts today".
-- `count` increments on every attempt *including refused ones*, so the number
-- in the row is what actually happened, not what was allowed.
--
-- Writes are the house idempotent `INSERT ... ON CONFLICT DO UPDATE` (D1 has no
-- transactions) with a RETURNING clause: one statement both counts the attempt
-- and answers whether it is within budget.
--
-- Retention: rows are tiny and never read for past days, so the `day` index
-- exists purely so a janitor can `DELETE FROM sync_budget WHERE day < ?`
-- without scanning. Nothing in the request path depends on old rows.

CREATE TABLE IF NOT EXISTS sync_budget (
  ip         TEXT NOT NULL,
  day        TEXT NOT NULL,
  count      INTEGER NOT NULL DEFAULT 0,
  first_seen TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (ip, day)
);

CREATE INDEX IF NOT EXISTS idx_sync_budget_day ON sync_budget(day);
