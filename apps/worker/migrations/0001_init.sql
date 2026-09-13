-- starwatch — free-tier pilot schema (canonical, single D1 database).
--
-- Topology: ONE D1 database for the $0 launch (docs/10 §1.1, docs/13 §4.1).
-- The paid multi-shard layout (sw_core / sw_corpus / sw_users_N) collapses
-- into this file; the shard-router facade stays in application code so the
-- split remains a config change, not a rewrite.
--
-- Per-user lexical index is RUNTIME DDL, not part of this migration:
--   * `fts_u_<sanitized(login)>`        — porter/unicode61 over (full_name, description, topics, readme)
--   * `fts_u_<sanitized(login)>_tri`    — trigram over (full_name, description, topics)
-- They are created lazily by packages/cloudflare/src/storage/fts.ts
-- (`ensureUserFts`) so a user index can be evicted/rebuilt without a
-- migration and so the tables do not exist for users that were never
-- indexed. There is deliberately NO shared `users_fts_all` table: a shared
-- FTS table needs a post-MATCH user filter, which burns the 5M rows/day D1
-- read budget at pilot scale (docs/13 §2c, §4.1). Per-user tables keep every
-- scan user-scoped.
--
-- Free-tier caps enforced by the storage layer (docs/14 §3.6, docs/15 §2):
--   * Semantic window: newest SEMANTIC_WINDOW = 1,500 stars get a vector blob
--     (R2 key `vectors/{login}.bin`; `vector_blobs` is only the pointer row).
--   * README text in D1: at most 64 KB per repo (`repos.readme_text` is
--     truncated; full bytes belong in R2, not this DB).
--   * Per-user FTS text: at most 20 MB across porter rows; docs beyond the
--     budget fall back to metadata-only rows.
--   * `MAX_STARS = 10,000` is an application admission cap, not a CHECK here.
--
-- Operational constraints baked into the code that reads/writes this schema:
--   * D1 has NO transactions (and `db.batch` is D1-only); every write here is
--     an idempotent `INSERT ... ON CONFLICT DO UPDATE` so a partial failure can
--     be retried safely.
--   * D1 allows at most 100 bound parameters per statement; multi-row reads and
--     deletes are chunked in the storage layer.
--   * SQL drivers do NOT camelize result columns; the SqlClient must be built
--     with `transformResultNames: camelize` (storage/sql.ts).

CREATE TABLE IF NOT EXISTS users (
  login        TEXT PRIMARY KEY,
  id           INTEGER,
  name         TEXT,
  avatar_url   TEXT,
  bio          TEXT,
  company      TEXT,
  location     TEXT,
  followers    INTEGER,
  public_repos INTEGER,
  created_at_gh TEXT,
  fetched_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS user_index_state (
  login           TEXT PRIMARY KEY,
  phase           TEXT NOT NULL,
  stars_total     INTEGER NOT NULL DEFAULT 0,
  repos_metadata  INTEGER NOT NULL DEFAULT 0,
  readmes_fetched INTEGER NOT NULL DEFAULT 0,
  semantic_docs   INTEGER NOT NULL DEFAULT 0,
  last_synced_at  TEXT,
  last_error      TEXT,
  updated_at      TEXT NOT NULL
);

-- Shared repository corpus, deduped by GitHub's stable numeric repo id.
-- README state lives on the repo row (one README per repo, shared by every
-- starrer) and is refreshed only when `pushed_at > readme_checked_at`.
CREATE TABLE IF NOT EXISTS repos (
  id                INTEGER PRIMARY KEY,
  full_name         TEXT NOT NULL,
  owner             TEXT NOT NULL,
  name              TEXT NOT NULL,
  description       TEXT,
  language          TEXT,
  topics_json       TEXT NOT NULL DEFAULT '[]',
  stars             INTEGER NOT NULL DEFAULT 0,
  forks             INTEGER NOT NULL DEFAULT 0,
  archived          INTEGER NOT NULL DEFAULT 0,
  license           TEXT,
  homepage          TEXT,
  pushed_at         TEXT,
  html_url          TEXT NOT NULL,
  readme_text       TEXT,
  readme_hash       TEXT,
  readme_state      TEXT NOT NULL DEFAULT 'unknown',
  readme_checked_at TEXT,
  first_seen_at     TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS repos_full_name ON repos(full_name);
CREATE INDEX IF NOT EXISTS repos_language ON repos(language);

-- Per-user star join. `starred_at` is GitHub's star timestamp (ISO-8601) and
-- drives the browse ordering and the starredAfter/starredBefore filters.
CREATE TABLE IF NOT EXISTS user_stars (
  login      TEXT NOT NULL,
  repo_id    INTEGER NOT NULL,
  starred_at TEXT,
  PRIMARY KEY (login, repo_id)
);

CREATE INDEX IF NOT EXISTS user_stars_repo ON user_stars(repo_id);

-- Listing ETags per page (docs/03): a 304 re-list costs one request and zero
-- row writes, so this table is the main lever on the GitHub budget.
CREATE TABLE IF NOT EXISTS star_etags (
  login      TEXT NOT NULL,
  page       INTEGER NOT NULL,
  etag       TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (login, page)
);

-- User-authored groups (v1 is import-only; docs/04). `id` is the GitHub node
-- id for imported lists, or a local id. `slug` is the stable filter key.
CREATE TABLE IF NOT EXISTS groups (
  id         TEXT PRIMARY KEY,
  login      TEXT NOT NULL,
  name       TEXT NOT NULL,
  slug       TEXT NOT NULL,
  position   INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS groups_login ON groups(login);

CREATE TABLE IF NOT EXISTS group_repos (
  group_id TEXT NOT NULL,
  repo_id  INTEGER NOT NULL,
  PRIMARY KEY (group_id, repo_id)
);

-- Pointer row for the per-user vector blob in R2. The vectors themselves are
-- NEVER stored in D1 (a 1.77 MB BLOB reads as a JS number[] in ~82 ms —
-- docs/15 §2.3); D1 keeps only dims + byte length + freshness so the read path
-- can decide whether to fetch `vectors/{login}.bin`. Below 1,500 vectors
-- (docs/15 §2.1) the blob sits well under the 10 ms CPU scan budget.
CREATE TABLE IF NOT EXISTS vector_blobs (
  login      TEXT PRIMARY KEY,
  dims       INTEGER NOT NULL,
  bytes_len  INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);
