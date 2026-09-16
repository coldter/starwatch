# 10 — Multi-Tenant Architecture

> ⚠️ **Free-tier override (2026-09-13):** the zero-budget launch topology changes here — Vectorize is replaced by repo-level embeddings + in-Worker kNN, and D1 sharding becomes "single DB for the pilot". See [13-free-tier-feasibility.md](13-free-tier-feasibility.md) and [15-free-semantic-search.md](15-free-semantic-search.md).

> Status: **draft for discussion** · 2026-09-13
> Pivot: starwatch becomes a **public service** — anyone enters any GitHub username; we index that account's **public stars** (metadata + READMEs) with one service token and expose public lexical + semantic search. No per-user GitHub auth.
> Companions: [00](00-requirements.md) · [01](01-search-and-index.md) (search engine) · [02](02-stack-and-pipeline.md) (pipeline) · [03](03-sync-and-limits.md) (GitHub quota) · [04](04-groups.md) · [07](07-search-contract.md)/[15](15-free-semantic-search.md) (search quality; docs 16–18 pending) · [08](08-public-service-ux.md) (UX states) · [09](09-public-data-and-limits.md) (public data) · [13](13-free-tier-feasibility.md) (free quotas) · [14](14-abuse-protection.md) (abuse/admission). This doc owns: sharing model, multi-tenant storage, sharding, eviction, fairness, and cost; §1.1 marks the $0 launch deltas. ⚠️ marks items to re-verify at implementation time.
>
> **Updated 2026-09-13 (free-tier pivot):** the $0 launch collapses the topology to a single D1 DB, per-user FTS tables, and repo-level R2 vector blobs + in-Worker kNN; Vectorize and D1 sharding below describe the **paid scale path**. See §1.1.

## 1. Recommendation at a glance

| Question             | Decision                                                                                                                                                                          |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Repo-level sharing   | **Global `repos` + `repo_chunks` corpus**, deduped by GitHub `repo_id` and content hash; READMEs and embeddings fetched/embedded **once ever**                                    |
| Per-user data        | `users`/`user_stars` join + per-user FTS rows + per-user Vectorize namespace + groups                                                                                             |
| Lexical              | **One FTS5 table per D1 user shard** with a `user_id` UNINDEXED column; ~150–250 users/shard                                                                                      |
| Semantic             | **Vector sharding first**: one Vectorize namespace per user (≈23k vectors), one query per search, no fan-out; ~700 users/index (20M vector cap)                                   |
| Sync                 | Global cron dispatcher → **per-user Workflow** instances; a single **`GithubGovernor` Durable Object** owns the shared 5,000 req/h token bucket, concurrency leases, and fairness |
| Freshness / eviction | **Tiered TTL/LRU**: hot = daily + full index, warm = weekly + lite namespace, cold = sync-on-visit with FTS/vectors evicted; refresh only when `pushed_at > readme_checked_at`    |
| Scale ceiling in v1  | 1 core DB + 1 corpus DB + 1 user shard + 1 Vectorize index; all four have a documented sharding path before they fill                                                             |
| Marginal cost        | ≈ **$0.06/user/mo** steady state, dominated by D1 storage; one-time embed ≈ **$0.07/user**, largely absorbed by the 10k neurons/day free pool                                     |

### 1.1 Free-tier deltas applied

The **$0 launch** ([13 §4.2](13-free-tier-feasibility.md), [14 §3.6](14-abuse-protection.md), [15](15-free-semantic-search.md)) changes the topology; everything else in this doc is the paid scale path:

- **Storage:** one D1 database — `sw_core` + `sw_corpus` + `sw_users_0` in a single DB (free: 500 MB/DB, 10 DBs/account); sharding (§2) resumes after the paid upgrade. Per-user FTS tables are acceptable for the ≤50-user pilot ([13 §4.1](13-free-tier-feasibility.md)).
- **Semantic:** Vectorize is out of the critical path. One **repo-level** 512d f32 vector per (user, repo), stored in a per-user R2 blob and scanned in-Worker ([15 §2](15-free-semantic-search.md)); the free semantic window is the newest **1,500** repos and listing is capped at `MAX_STARS = 10,000` ([14 §3.6](14-abuse-protection.md)). Per-user Vectorize namespaces (§3) remain the paid path.
- **FTS budget:** 64 KB of README text per repo and 20 MB/user in D1 on free ([14 §3.6](14-abuse-protection.md)); §4.3's 35–65 MB/user sizing is the paid path.
- **Sync:** admission is driven by CF free-quota headroom (D1 rows written, Workflow steps, AI neurons) before GitHub windows ([13 §2(b)](13-free-tier-feasibility.md)); a full backfill must chain ≤250-repo Workflow instances (1,024-step cap, [15 §2.5](15-free-semantic-search.md)).
- **Cost:** §5 is the paid-phase model; the free launch is $0 within caps, with an indexed-user soft cap of 50 full/warm and LRU eviction (§6).

## 2. Repo-level sharing across users

### 2.1 Shared vs per-user artifacts

| Artifact                                               | Home                                                                                               | Duplicated per user?                           |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| Repo metadata + README state (`repos`, `repo_readmes`) | corpus DB                                                                                          | no                                             |
| README bytes + embedding values (content-addressed)    | R2, GC on last reference                                                                           | no (reused to fill namespaces)                 |
| Chunk text + hashes (`repo_chunks`)                    | corpus DB                                                                                          | no                                             |
| Vectors                                                | per-user R2 blob on free ([15 §2.3](15-free-semantic-search.md)); Vectorize namespace on paid (§3) | **yes** (one copy per indexed user; evictable) |
| FTS5 index rows                                        | user shard DB                                                                                      | **yes** (FTS stores indexed text; evictable)   |
| `user_stars` + `starred_at` + filter snapshot          | user shard DB                                                                                      | n/a (~1 MB/user, refreshed on sync)            |
| Groups / memberships / listing ETags                   | user shard DB                                                                                      | n/a                                            |

Two intentional duplications remain: **Vectorize storage** (§3) and **FTS text** (§4). Both buy exact per-user recall with a single scoped query; both are evictable caches, which keeps them bounded (§6).

### 2.2 Topology

```
sw_core (control)          sw_corpus (shared)          sw_users_0..N (user shards)
├─ users                   ├─ repos                    ├─ user_stars
├─ user_index_state        ├─ repo_readmes             ├─ user_repo_fts (porter)
├─ sync_jobs / sync_runs   ├─ repo_chunks              ├─ user_repo_tri (trigram)
├─ vectorize_shards        ├─ embedding_cache          ├─ user_fts_rows
└─ (admission in config)   └─ repo_events              ├─ star_pages (listing ETags)
                                                       ├─ groups / group_members
                                                       └─ user_dirty (refresh queue)
```

- **Control DB** stays small (< 1 GB for 100k users); it is the scheduler's single read point.
- **Corpus DB** holds one row per unique repo (~1 KB metadata + ~7 KB chunk text). Fits ~800k–1M unique repos under the 10 GB cap; split by `repo_id` range into `sw_corpus_0..k` when needed (lookups are by id, so range shards never rebalance).
- **User shards** hold only per-user data; `shard_id = fnv1a(github_id) % n_shards` (or least-loaded at admission). Move a user between shards with export/import by `user_id` (rare, offline).
- **Free launch:** the three stores above collapse into one D1 DB (`sw_core` + `sw_corpus` + `sw_users_0`); the shard-router facade stays, so the split is a config change rather than a rewrite (§1.1).

### 2.3 DDL — control DB (`0003_multitenant_core.sql`)

```sql
CREATE TABLE users (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  login           TEXT    NOT NULL,                 -- canonical GitHub login
  login_ci        TEXT    NOT NULL UNIQUE,          -- lower(login); lookup key
  github_id       INTEGER UNIQUE,
  avatar_url      TEXT,
  star_count      INTEGER,                          -- last observed public count
  state           TEXT    NOT NULL DEFAULT 'requested'
                  CHECK (state IN ('requested','listing','indexing','ready','degraded','failed','evicted')),
  origin          TEXT    NOT NULL DEFAULT 'manual',-- manual|visit|schedule
  requested_by_ip TEXT,                             -- abuse forensics
  created_at      INTEGER NOT NULL,
  last_visited_at INTEGER,
  last_synced_at  INTEGER, next_sync_at INTEGER,
  shard_id        INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX users_due ON users(next_sync_at) WHERE state NOT IN ('evicted','failed');
CREATE TABLE user_index_state (
  user_id         INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  lexical_state   TEXT NOT NULL DEFAULT 'absent'
                  CHECK (lexical_state IN ('absent','building','ready','stale','error')),
  semantic_state  TEXT NOT NULL DEFAULT 'absent'
                  CHECK (semantic_state IN ('absent','building','ready','stale','error')),
  semantic_tier   TEXT NOT NULL DEFAULT 'none' CHECK (semantic_tier IN ('none','lite','full')),
  vectorize_index TEXT,                             -- shard index name
  vectorize_ns    TEXT,                             -- 'u' || user_id, stable
  repos_indexed   INTEGER NOT NULL DEFAULT 0,
  chunks_indexed  INTEGER NOT NULL DEFAULT 0,
  vectors_indexed INTEGER NOT NULL DEFAULT 0,
  index_version   INTEGER NOT NULL DEFAULT 0,       -- monotonic; bumped per sync
  dirty_repos     INTEGER NOT NULL DEFAULT 0,       -- corpus README changed since last refresh
  lex_built_at    INTEGER, sem_built_at INTEGER,
  last_error      TEXT
);
CREATE TABLE vectorize_shards (
  index_name    TEXT PRIMARY KEY,
  dims          INTEGER NOT NULL,
  metric        TEXT NOT NULL DEFAULT 'cosine',
  capacity      INTEGER NOT NULL DEFAULT 700,       -- users @ 23k vectors, 20M cap
  users_count   INTEGER NOT NULL DEFAULT 0,
  vectors_count INTEGER NOT NULL DEFAULT 0,
  state         TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open','draining','retired')),
  created_at    INTEGER NOT NULL
);
CREATE TABLE sync_jobs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL CHECK (kind IN ('backfill','incremental','readme_refresh','evict')),
  priority     INTEGER NOT NULL DEFAULT 100,        -- lower = more urgent
  state        TEXT NOT NULL DEFAULT 'queued'
               CHECK (state IN ('queued','leased','running','done','failed','cancelled')),
  run_id       INTEGER,
  enqueued_at  INTEGER NOT NULL,
  available_at INTEGER NOT NULL,                    -- backoff / fairness gate
  attempts     INTEGER NOT NULL DEFAULT 0,
  lease_owner  TEXT, lease_until INTEGER
);
CREATE UNIQUE INDEX sync_jobs_active ON sync_jobs(user_id, kind)
  WHERE state IN ('queued','leased','running');     -- dedupe; ⚠️ partial unique index on D1
CREATE TABLE sync_runs (                             -- docs/03 §4.4 + user_id
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, instance_id TEXT UNIQUE,
  kind TEXT NOT NULL, state TEXT NOT NULL,
  started_at INTEGER NOT NULL, finished_at INTEGER, heartbeat_at INTEGER,
  pages_done INTEGER DEFAULT 0, pages_total INTEGER, repos_total INTEGER, repos_done INTEGER DEFAULT 0,
  readme_200 INTEGER DEFAULT 0, readme_304 INTEGER DEFAULT 0, readme_404 INTEGER DEFAULT 0,
  chunks_total INTEGER DEFAULT 0, chunks_embedded INTEGER DEFAULT 0, vectors_upserted INTEGER DEFAULT 0,
  api_used INTEGER DEFAULT 0, rate_remaining INTEGER, rate_reset_at INTEGER, resume_at INTEGER,
  error_step TEXT, error_code TEXT, error_message TEXT, summary_json TEXT
);
```

> **Free-tier delta:** on $0, `vectorize_shards` and the `vectorize_*`/`semantic_tier` columns are replaced by `vector_blobs` + `user_semantic` ([15 §2.6](15-free-semantic-search.md)); this DDL remains the paid scale path.

### 2.4 DDL — corpus DB (`0004_corpus.sql`)

```sql
CREATE TABLE repos (
  id                INTEGER PRIMARY KEY,             -- GitHub repo id (stable)
  node_id           TEXT,
  full_name         TEXT NOT NULL,
  owner_login       TEXT NOT NULL,
  description       TEXT, language TEXT, topics_json TEXT,
  stars INTEGER, forks INTEGER, license TEXT,
  archived INTEGER NOT NULL DEFAULT 0, fork INTEGER NOT NULL DEFAULT 0,
  size_kb INTEGER, default_branch TEXT, pushed_at INTEGER,
  chunk_count       INTEGER NOT NULL DEFAULT 0,
  chunker_version   TEXT, embed_model TEXT,
  fetched_at        INTEGER, refreshed_at INTEGER
);
CREATE INDEX repos_full_name ON repos(full_name);
CREATE INDEX repos_owner ON repos(owner_login);
CREATE TABLE repo_readmes (
  repo_id       INTEGER PRIMARY KEY REFERENCES repos(id) ON DELETE CASCADE,
  etag          TEXT,                                -- If-None-Match source of truth
  sha256        TEXT NOT NULL,                       -- raw README content hash
  size          INTEGER NOT NULL,
  r2_key        TEXT,                                -- readmes/{sha256}.md
  state         TEXT NOT NULL DEFAULT 'present'
                CHECK (state IN ('present','missing','too_big','error')),
  fetched_at    INTEGER NOT NULL, checked_at INTEGER NOT NULL, next_check_at INTEGER
);
CREATE TABLE repo_chunks (
  repo_id      INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  idx          INTEGER NOT NULL,                     -- 0 = summary, 1..n = body chunks
  kind         TEXT NOT NULL DEFAULT 'chunk' CHECK (kind IN ('chunk','summary')),
  heading      TEXT, text TEXT NOT NULL,
  sha256       TEXT NOT NULL,                        -- per-chunk hash; stable chunk ids
  embedded_at  INTEGER,
  PRIMARY KEY (repo_id, idx)
);
CREATE INDEX repo_chunks_sha ON repo_chunks(sha256);
CREATE INDEX repo_chunks_queue ON repo_chunks(embedded_at) WHERE embedded_at IS NULL;
CREATE TABLE embedding_cache (                       -- content-addressed; "embed once, ever"
  sha256   TEXT NOT NULL, model TEXT NOT NULL, dims INTEGER NOT NULL,
  r2_key   TEXT NOT NULL,                            -- embeddings/{model}/{repo_id}/{hash}.bin
  bytes    INTEGER NOT NULL, refs INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL,
  PRIMARY KEY (sha256, model)
);
CREATE TABLE repo_events (                           -- fan-out: which users must refresh
  id INTEGER PRIMARY KEY AUTOINCREMENT, repo_id INTEGER NOT NULL,
  kind TEXT NOT NULL, at INTEGER NOT NULL, processed_at INTEGER
);
CREATE INDEX repo_events_pending ON repo_events(processed_at) WHERE processed_at IS NULL;
```

### 2.5 DDL — user shard DB (`0005_user_shard.sql`)

```sql
CREATE TABLE user_stars (
  user_id       INTEGER NOT NULL,
  repo_id       INTEGER NOT NULL,
  starred_at    INTEGER,
  is_starred    INTEGER NOT NULL DEFAULT 1,
  unstarred_at  INTEGER,
  first_seen_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL,
  -- denormalized filter snapshot, refreshed when repos.refreshed_at > meta_updated_at
  full_name TEXT, description TEXT, language TEXT, topics_json TEXT,
  stars INTEGER, license TEXT, archived INTEGER NOT NULL DEFAULT 0,
  fork INTEGER NOT NULL DEFAULT 0, pushed_at INTEGER, meta_updated_at INTEGER,
  PRIMARY KEY (user_id, repo_id)
);
CREATE INDEX user_stars_recent ON user_stars(user_id, starred_at DESC, repo_id DESC);
CREATE INDEX user_stars_repo   ON user_stars(repo_id);          -- "who starred X" fan-out
-- One FTS table per shard; user_id is stored (UNINDEXED) and used as a pre-filter.
CREATE VIRTUAL TABLE user_repo_fts USING fts5(
  full_name, description, topics, readme,
  user_id UNINDEXED, repo_id UNINDEXED,
  tokenize = 'porter unicode61'
);
CREATE VIRTUAL TABLE user_repo_tri USING fts5(   -- identifiers only; keeps trigram small
  full_name, description, topics,
  user_id UNINDEXED, repo_id UNINDEXED,
  tokenize = 'trigram'
);
CREATE TABLE user_fts_rows (                      -- delete by rowid, never scan the vtab
  user_id INTEGER NOT NULL, repo_id INTEGER NOT NULL, rowid INTEGER NOT NULL,
  PRIMARY KEY (user_id, repo_id)
);
-- star_pages (listing ETags) moves here verbatim from docs/03 §2(g), plus user_id.
CREATE TABLE groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL,
  slug TEXT NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'manual' CHECK (kind IN ('manual','smart')),
  rules_json TEXT, color TEXT NOT NULL DEFAULT 'slate', icon TEXT NOT NULL DEFAULT '',
  position INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  UNIQUE(user_id, slug)
);
CREATE TABLE group_members (
  group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  repo_id  INTEGER NOT NULL,                      -- FK across DBs not possible; corpus owns repos
  source   TEXT NOT NULL DEFAULT 'manual', added_at INTEGER NOT NULL,
  PRIMARY KEY (group_id, repo_id)
);
CREATE TABLE user_dirty (
  user_id INTEGER NOT NULL, repo_id INTEGER NOT NULL, kind TEXT NOT NULL, at INTEGER NOT NULL,
  PRIMARY KEY (user_id, repo_id)
);
```

Notes: FTS5 `user_id` scoping is the standard multi-tenant pattern; `WHERE user_id = ? AND user_repo_fts MATCH ? ORDER BY bm25(...)` applies the equality post-MATCH. Its storage cost is compared to alternatives in §4. Contentless FTS (`contentless_delete=1`, ⚠️ SQLite ≥ 3.43 in D1; `contentless_unindexed=1` for scoping) would cut text storage but is deferred until verified.

### 2.6 R2 layout

```
starwatch-readmes/
  readmes/{sha256}.md                          # raw README, content-addressed, immutable
  embeddings/{model}/{repo_id}/{chunkhash}.bin # packed f32 vectors, one object per repo
  exports/{YYYY-MM}/core.sql                   # optional operational dumps (Time Travel is primary)
```

- Content-addressing dedupes boilerplate READMEs across repos and makes objects immutable; a reference-count GC (nightly Workflow) deletes an object only when no `repo_readmes`/`embedding_cache` row points at it (deletes are free on R2), and packing embeddings per repo keeps Class A ops at ~1 object/repo instead of ~6. Lifecycle rules apply only to `exports/`.

### 2.7 Shared-repo lifecycle

| Event                                          | Shared work (once)                                               | Per-user work                                                              |
| ---------------------------------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------- |
| New repo enters corpus                         | metadata upsert; README fetch → chunk → hash → embedding cache   | FTS row + vectors for each starrer                                         |
| README changed (`pushed_at > checked_at`, 200) | refetch/chunk; re-embed only changed hashes; `refreshed_at` bump | FTS refresh (hot eager, others `user_dirty`); vector upsert changed chunks |
| Repo renamed/moved (301)                       | update `full_name` by stable `id`                                | snapshot update on next sync                                               |
| Repo unstarred by user                         | nothing                                                          | `is_starred=0`, FTS delete, vector `deleteByIds`, keep row 90 d            |
| Repo deleted upstream                          | soft-delete + retention, then GC                                 | rows drop after user retention window                                      |

## 3. Vectorize multi-tenancy — the core trade-off

> **Free-tier delta:** Vectorize cannot host the launch ([15 §1](15-free-semantic-search.md)): free allowances are a prototype budget, so the $0 semantic path is repo-level R2 blobs + in-Worker kNN (§1.1). The analysis below is the **paid path**; option (d) is the free fallback shape.

**Verified constraints (2026-09-13):** 20M vectors/index; 50,000 namespaces/index (Paid); namespace names ≤ 64 B; `topK ≤ 50` with metadata/values, ≤ 100 without; 10 metadata indexes/index; compact filter JSON **< 2,048 bytes**; namespace is applied **before** metadata filters; queries target exactly one namespace. Stored dims $0.05/100M after 10M included; queried dims $0.01/M after 50M included.

**Per-user sizing:** ~19.7k chunks + ~3.3k summaries ≈ **23k vectors × 1024d = 23.55M dims** ([01 §5](01-search-and-index.md)).

### 3.1 Options

|                     | (a) Namespace per user                                                     | (b) Global index + post-filter membership                                                              | (c) Global index + `repo_id $in` pre-filter                                        | (d) D1-only candidates + semantic re-rank                                                      |
| ------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Recall              | **exact** (namespace = user corpus)                                        | collapses: expected hits in top-50 ≈ `50 × user_vectors / global_vectors` → **usually 0** at ≥1k users | exact _within the filter set_, but the set is capped                               | only re-ranks what D1 found; pure-paraphrase queries lose semantic reach                       |
| Query count/search  | **1**                                                                      | 1                                                                                                      | `ceil(k/≈200)` (2,048 B filter ≈ 200 nine-digit ids; 3.4k stars → **~17 queries**) | 1 (over ≤200 lexical candidates)                                                               |
| Storage / isolation | vectors duplicated per user; per-user delete by deterministic ids          | one copy, no vector-layer isolation                                                                    | one copy                                                                           | one copy                                                                                       |
| Verdict             | ✅ **paid primary** (not free-viable, [15 §1](15-free-semantic-search.md)) | ❌                                                                                                     | ❌ as a primary; useful as the paid `lite` tier                                    | ✅ **free-tier primary** ([15 §2](15-free-semantic-search.md)); fallback/degraded tier on paid |

The recall math is the decider: a niche user's 23k vectors are a rounding error in a shared 3.5M+ vector index; global top-50 post-filtering returns near-zero semantic hits for exactly the users who need the service. The `$in` route buys recall back but turns every search into ~17 Vectorize queries, breaks the §7 latency budget (legs must run in parallel), and multiplies query billing ambiguously. Namespaces keep one query, one namespace, exact scoping, and trivial per-user deletion. **On free this entire section is moot:** no namespaces are created ([15 §1](15-free-semantic-search.md)); `vector_blobs` replaces `vectorize_shards` and R2 bytes + 10 ms CPU replace stored/queried dims as the binding walls.

### 3.2 Duplication cost and sharding path

Stored dims `= users × 23.55M` (1024d, full tier) at $0.05 per 100M dims/mo after the 10M free allocation:

| Users  | Vectors | Stored dims | Vectorize $/mo | One global copy for reference         |
| ------ | ------- | ----------- | -------------- | ------------------------------------- |
| 10     | 230k    | 235.5M      | **$0.11**      | ~3.5M vectors ≈ 3.58B dims ≈ $1.79/mo |
| 100    | 2.3M    | 2.36B       | **$1.17**      | same                                  |
| 1,000  | 23M     | 23.6B       | **$11.77**     | same                                  |
| 10,000 | 230M    | 236B        | **$117.75**    | same                                  |

- Duplication is **cheaper than a global index below ~150 users** (given a ~500k-repo union corpus) and stays linear thereafter. MRL-shrunk dims (qwen3 at 512/256d) halve/quarter all columns; the `lite` tier (summary + top 2 chunks/repo ≈ 10k vectors) cuts the vector count ~2.3×.
- **Sharding + metadata:** soft cap **700 users/index** (16M vectors at 80% of the 20M limit); 10k users → ~15 indexes, 1M → ~1,430. `vectorize_shards` tracks utilization; new namespaces go to the least-loaded `open` index. Rebalancing is by user: fill the new namespace from the R2 embedding cache (`getByIds` can also copy values out of an old index ⚠️ verify batch limits), flip `user_index_state.vectorize_index`, then `deleteByIds` the old namespace. Every shard index carries the same 10 metadata indexes, declared before first insert ([07 §4.3](07-search-contract.md)): language, stars, archived, starred_at, license, fork, has_readme, pushed_at, `repo_id`, +1 spare. Namespace names are opaque (`u123`), never logins.
- **⚠️ Query-billing ambiguity:** Cloudflare's formula example reads `(queries + stored vectors) × dims`, implying queries are negligible; if billing is instead per scanned vector inside the namespace, one query ≈ 24M dims and only ~2 searches/month are free. Instrument the first deployed week and cap semantic searches per user/day if the pessimistic reading holds.

## 4. Lexical multi-tenancy

### 4.1 Options

|         | Single FTS5 table + `user_id` column/shards ✅                                                                          | Per-user virtual tables                                           | Global FTS + join `user_stars`                           |
| ------- | ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | -------------------------------------------------------- |
| Recall  | exact, one query (storage duplicates text)                                                                              | exact, plus schema bloat                                          | post-filter after global BM25 → same collapse as §3.1(b) |
| Ops     | one DDL per shard; delete by rowid via `user_fts_rows`                                                                  | ~2×10⁴ virtual tables/shard at 10k users; migration/DDL nightmare | trivial DDL                                              |
| Verdict | ✅ paid v1; per-user virtual tables are acceptable for the ≤50-user free pilot ([13 §4.1](13-free-tier-feasibility.md)) | ❌                                                                | only as a cold-tier "lite lexical" fallback (v2)         |

### 4.2 Query patterns

```sql
-- lexical leg (porter) + filters, all in the user's shard
SELECT f.repo_id, bm25(user_repo_fts) AS score, s.starred_at AS starred_at
FROM user_repo_fts f JOIN user_stars s USING (user_id, repo_id)
WHERE f MATCH ? AND f.user_id = ?
  AND s.is_starred = 1 AND s.language = ? AND s.stars >= ? AND s.archived = 0
ORDER BY bm25(user_repo_fts) LIMIT 50;
-- trigram leg only when the parsed query is identifier-like ([07 §7.4](07-search-contract.md))
SELECT repo_id, bm25(user_repo_tri) FROM user_repo_tri
WHERE user_repo_tri MATCH ? AND user_repo_tri.user_id = ? ORDER BY bm25(user_repo_tri) LIMIT 50;
```

Browse (no text) is the same snapshot SQL keyset-paginated by `(starred_at, repo_id)`. Snippets come from the corpus (`repo_chunks`) rather than FTS `snippet()`, so FTS can later go contentless without changing the read path.

### 4.3 Size math and sharding

| Component                                | Per user      | Notes                                                                                                                                                     |
| ---------------------------------------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| porter FTS (name/desc/topics/README)     | **30–60 MB**  | docs/01 §5; ~26 MB source text, FTS ≈ 1.3–2.3×                                                                                                            |
| trigram FTS                              | 2–4 MB        | metadata columns only; README trigrams explode                                                                                                            |
| `user_stars` + snapshot + groups + etags | ~2 MB         | 3.4k rows × ~300 B + small tables                                                                                                                         |
| **Total**                                | **~35–65 MB** | paid path; the $0 launch caps FTS at 64 KB/repo and 20 MB/user ([14 §3.6](14-abuse-protection.md)). Contentless FTS would land near the low end (⚠️ §2.5) |

Against the **10 GB/DB** ceiling, shard at **150 users** (≈7–10 GB packed) or 250 with contentless FTS. 10k users → 40–70 shards; 1M users → 4–7k shards — both far below D1's 50,000 databases/account. Shards are immutable-as-a-set: add `sw_users_N` when the last one crosses 70% full; never rebalance.

- **Read path fan-out:** user shard (FTS + filters) ∥ Vectorize (namespace) → RRF in the Worker → one corpus snippet fetch (`repo_id IN (…)`, grouped by corpus shard) → result page. No cross-DB SQL joins; the snapshot in `user_stars` makes filters single-DB, and corpus shards are reached only for snippets/pipeline writes, always keyed by `repo_id`.

### 4.4 Worker bindings

One Worker can bind ~**5,000 D1 databases** (1 MB script metadata, ~150 B/binding). At 150 users/shard that is ~750k users from a single deployment, which outlives v1. Beyond it, deploy a shard-gateway Worker per 100 shards and route through service bindings. Bindings are generated by the Alchemy config (`D1_USERS_0…N`, `VECTORIZE_0…N`); the `shard_id → binding` map lives in `packages/cloudflare`. Enable D1 read replication on user shards (search-heavy) once available in the account region.

## 5. Cost model (paid phase)

> **Free-tier delta:** on $0 the marginal bill is $0 within the free caps; the binding walls are D1 storage/rows and R2 bytes, not dollars ([13](13-free-tier-feasibility.md), [14 §3.6](14-abuse-protection.md)). The 10k neurons/day free pool row below is the launch-relevant number.

### 5.1 Unit economics (per full user, 3.4k repos)

| Item                                                                        | One-time                                                                  | Steady per month                                                           |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Embedding (bge-m3, 5.7M tokens @ $0.012/M)                                  | **$0.068** (→ ~$0.034 at 50% corpus cache hits; 0 if within free neurons) | churn ~0.6M tokens → **$0.007** (bounded globally by changed unique repos) |
| Vectorize stored (23.55M dims @ $0.05/100M)                                 | —                                                                         | **$0.012**                                                                 |
| D1 (35–65 MB @ $0.75/GB-mo; 5 GB included)                                  | —                                                                         | **$0.026–0.048**                                                           |
| R2 (corpus + cache) + queries (10 searches/user/mo, rerank 30k tokens each) | ~$0.0005                                                                  | **$0.0014**                                                                |

**Free pool:** 10,000 neurons/day ÷ 1,075 neurons/M-tokens ≈ **9.3M tokens/day** ≈ **1.6 full users/day** (~49/month) at zero AI cost. Paid path is the same $0.012/M tokens ($0.011/1k neurons).

### 5.2 Scale (all users indexed, no eviction; from §5.1 × N plus shared corpus)

| Monthly $                                             | 10 users  | 100 users | 1k users | 10k users |
| ----------------------------------------------------- | --------- | --------- | -------- | --------- |
| Vectorize stored (N×23.55M dims)                      | $0.11     | $1.17     | $11.77   | $117.75   |
| D1 storage (user 35–65 MB + corpus, −5 GB)            | $0        | ~$0.5     | ~$29     | ~$320     |
| AI churn (linear worst case)                          | $0.07     | $0.72     | $7.2     | $72       |
| Rerank + query embeds (10 searches/user)              | <$0.01    | $0.01     | $0.90    | $9.00     |
| **Total marginal**                                    | **≈$0.2** | **≈$2.4** | **≈$50** | **≈$520** |
| One-time onboarding (bounded by unique corpus, not N) | ~$0.3     | ~$1.7     | ~$5      | ~$16      |

D1 dominates from ~1k users; **eviction (§6) cuts the 10k-user D1 row ~3× and Vectorize ~5×** (only hot/warm users keep full indexes), landing near **$150–200/mo**. At 10k users the bill is ~$0.02/user/mo — the Workers Paid $5 base and the 10k neurons/day pool cover the rest; R2 stays under $0.05/mo everywhere.

### 5.3 Cost controls

1. **Shared corpus + embedding cache** — fetch/chunk/embed once; users only copy vectors into namespaces. The largest lever.
2. **Chunk caps** — ≤12 chunks/repo (README truncated ≥256 KB), summary always, README <1 KB → summary-only, forks/no-README → metadata-only.
3. **Tiered semantics** — `full` (all chunks) for hot users; `lite` (summary + top 2 chunks/repo ≈ 10k vectors) for warm; `none` (lexical) for cold.
4. **MRL dims** — qwen3-embedding-0.6b at 512/256d for lite tiers (same $/token as bge-m3); bge-m3 1024d for full. Index dims are fixed per index, so pin one config per shard generation.
5. **D1 + queries** — trigram on metadata only; contentless FTS when verified; evict cold FTS; shard at 150–250 users; rerank only on descriptive/mixed queries ([07 §5.4](07-search-contract.md)); cache query embeddings; cap semantic searches/user/day.
6. **Budget kill switch** — daily checks on neurons, D1 `rows_written`, stored dims; degrade to lexical-only and pause admission when a threshold trips.

## 6. Eviction & freshness

### 6.1 Tier policy

| Tier       | Trigger               | Kept                                  | Evicted                          | Sync cadence                                                    |
| ---------- | --------------------- | ------------------------------------- | -------------------------------- | --------------------------------------------------------------- |
| `hot`      | visited ≤ 7 d         | full FTS + full namespace             | —                                | daily (scheduled)                                               |
| `warm`     | visited ≤ 30 d        | FTS + lite namespace                  | extra chunks                     | weekly                                                          |
| `cold`     | 30–90 d               | `user_stars` + groups only (~1 MB)    | FTS, namespace, snapshot refresh | re-index on visit (lexical from corpus, semantic from R2 cache) |
| `archived` | > 90 d, not revisited | `user_stars` row; corpus stays shared | all per-user caches              | opt-in re-index                                                 |

Popular profiles are warm by construction (visit/LRU), so eviction never touches them. The policy is a pure LRU with promotion on any successful search or sync.

### 6.2 Reclamation mechanics

- **Vectorize:** vector IDs are deterministic (`{repo_id}:{idx}`), so eviction reconstructs the id set from `user_stars` + `repo_chunks.chunk_count` and deletes in batches via `deleteByIds` (assume ≤1,000/batch, ⚠️ limit undocumented). No index-wide scan, no `list-vectors` paging.
- **D1:** `DELETE FROM user_repo_fts WHERE rowid IN (SELECT rowid FROM user_fts_rows WHERE user_id = ?)` batched ≤100 (bound-param limit) — never a full-table scan; then `user_fts_rows`, snapshot columns, `user_dirty`. FTS deletes are expensive — do them in a nightly `evict` job, not on the request path.
- **R2 + rebuild on return:** corpus objects are shared; the nightly GC deletes an object when no `repo_readmes`/`embedding_cache` reference remains. Rebuild lexical by re-tokenizing corpus chunks (~seconds–minutes); rebuild semantic by reading packed f32 embeddings from R2 and upserting — no Workers AI call, no GitHub call. This is why the embedding cache exists.

### 6.3 Freshness

- On visit, `last_visited_at` updates; if `now > next_sync_at`, enqueue a P0 incremental job and serve **stale-while-revalidate** results with an "indexing" badge ([03 §4.2](03-sync-and-limits.md) semantics).
- README changes are discovered per repo during any user's sync; `repos.refreshed_at` bumps and a `repo_events` row is written. Fan-out: hot users get an eager FTS refresh; warm/cold users get a `user_dirty` row, applied lazily at their next sync (bounded fan-out, e.g. 5k users/repo, is a v1.1 refinement).
- Unstar: `is_starred=0`, FTS delete, vector delete at the next complete sweep; keep rows 90 d (reactivation restores everything, and unchanged READMEs skip re-work).

## 7. Sync orchestration at N users

**Shape:** one cron tick (1/min) reads due `sync_jobs` from `sw_core`, applies admission limits, and spawns **one Workflow instance per active sync** (`sw-sync-{run_id}`). Workflows give per-user durability, resumable checkpoints, `sleepUntil` for rate-limit pauses, and isolation — one user's failure cannot corrupt another's. A single global Sequential job would create head-of-line blocking and make partial failure global; per-user instances avoid both (Workflows: 50k concurrent _running_/2M queued instances; waiting instances are free). **Free-tier delta:** admission is CF-quota-bound first ([13 §2(b)](13-free-tier-feasibility.md)); a full backfill must chain ≤250-repo instances because free Workflow instances cap at 1,024 steps ([15 §2.5](15-free-semantic-search.md)).

**Global GitHub governor (Durable Object `GithubGovernor`, singleton id):**

| Concern      | Design                                                                                                                                                                                                                      |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Token bucket | Hourly window keyed to `x-ratelimit-reset` (not clock hour), 5,000 capacity minus a 300-request reserve; ≤700 req/min pacing against the 900 pt/min secondary limit; response headers reconcile the local count (`observe`) |
| Concurrency  | 5 leases (Workers' 6-connection cap); leases expire (60 s) so crashes release slots                                                                                                                                         |
| Fairness     | Deficit round-robin among users in the active set; per-job burst cap (e.g. 120 requests) then requeue — one backfill can never occupy a whole window                                                                        |
| Priority     | P0 interactive-on-visit (burst 50) > P1 manual > P2 hot nightly > P3 warm/backfill (only runs on leftover budget) with 2 h aging to prevent starvation                                                                      |
| Admission    | `sync_jobs` partial unique index dedupes concurrent requests; a request while running attaches to `run_id` ([05 §3.2](05-cli.md), [06 §6](06-webui.md)); the cron caps _new_ backfills (e.g. 20/h, 200/day)                 |
| Failure      | Per-repo `readme_state='error'` retried next run; per-step retries per [03 §1.3](03-sync-and-limits.md); governor state is persisted per mutation and alarm-refilled, so a crash loses nothing                              |

Workers' native Rate Limiting binding is per-location with only 10 s/60 s windows — unusable as the shared 5,000/h governor. A single DO is safe: state is reconstructed from storage after eviction, and only one object ever owns the lease state. Queues (1M free ops/mo, 15-min consumer wall time) are the dispatch escalator if cron+workflow-create throughput becomes the bottleneck (Workflow creation: 300/s/account, 100/s/workflow).

**Scheduling policy:** never nightly-sweep everyone — listing cost is ~35 requests/user even when 304s are free ([03 §2(d)](03-sync-and-limits.md)). Hot users daily, warm weekly, cold on visit. At 1k hot users the sweep alone is ~35k requests ≈ 7 h of the shared window, which is why the nightly job must be budget-limited and why on-visit lazy sync for cold users is the scaling default.

## 8. Abuse impact & quotas

Public sync endpoints are the attack surface: a script can enqueue thousands of usernames to blow up D1, Vectorize and R2. Layered controls:

| Layer     | Control                                                                                                                                                                                                                                                                                          |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Request   | Per-IP rate limit (Workers Rate Limiting binding, per-location) + a global D1/DO counter for cross-location accuracy; mandatory Turnstile on index starts (day 1 on free, [14 §3.3](14-abuse-protection.md)); optional `sw_` bearer for CLI ([05 §6.2](05-cli.md))                               |
| Identity  | Per-IP/day: ≤3 new usernames and ≤5 sync requests ([14 §3.2](14-abuse-protection.md)); indexed-user soft cap 50 full/warm ([14 §3.6](14-abuse-protection.md)); login must exist and have ≤`MAX_STARS = 10,000` public stars                                                                      |
| Admission | `sync_jobs` dedupe; weighted new-user admission ≤10 units/day ([14 §4](14-abuse-protection.md)); queue overflow returns `503 + Retry-After`, not a crash; per-user README/FTS caps ([14 §3.6](14-abuse-protection.md)), re-list ≥15 min / full refresh ≥24 h, semantic builds only for hot users |
| Backstop  | Tiered eviction (§6) reclaims storage automatically; budget kill switch degrades to lexical-only; `requested_by_ip` retained for forensics; corpus GC prevents orphan bloat                                                                                                                      |

READMEs are public GitHub data displayed as snippets + deep links (never full re-publication in v1); owners get an unindex/opt-out path (open question 6).

## 9. Recommended v1 scope

1. **Schema + topology:** `sw_core`, `sw_corpus`, `sw_users_0` (single shard), shard-router facade from day 1; corpus dedupe + hash-keyed README/R2/embedding cache.
2. **Lexical:** per-user FTS5 with `user_id` scoping, filters from the `user_stars` snapshot, snippet hydration from corpus chunks.
3. **Semantic:** free path = repo-level R2 blobs + in-Worker kNN ([15](15-free-semantic-search.md)); paid path = lazy per-user namespace on one Vectorize index with deterministic vector IDs and metadata indexes before first upsert; lexical fallback wherever the semantic store is absent.
4. **Sync:** cron dispatcher + `GithubGovernor` DO (token bucket, leases, priorities, dedupe); per-user Workflows where free step limits allow (chained ≤250-repo instances); lazy on-visit sync for cold users ([13 §2(b)](13-free-tier-feasibility.md), [14 §3.4](14-abuse-protection.md)).
5. **Ops:** TTL/LRU eviction job, R2 GC, free-quota counters + dashboard ([13 §4.3](13-free-tier-feasibility.md), [14 §5.3](14-abuse-protection.md)), budget kill switch; keep `usage` dashboards ready for the paid Vectorize billing ambiguity (§3.2).
6. **Defer:** contentless FTS, global-index `lite` tier, multi-corpus shards, read replication tuning, MRL model switch, Queues dispatch, MCP.

## 10. Open questions

1. **Namespace economics + query billing — resolved for the $0 launch.** Vectorize is not used ([15 §1](15-free-semantic-search.md)); R2 bytes + 10 ms CPU are the free walls. The paid question (does per-user storage beat a global index at ≥10k users, and how are queried dims billed?) returns only with a paid migration (§3.2).
2. **Contentless FTS in D1** — verify SQLite ≥3.43 (`contentless_delete`) and ≥3.46 (`contentless_unindexed`) before adopting; it roughly doubles shard capacity.
3. **FTS refresh fan-out** — eager for how many starrers of a changed popular repo, lazy for the rest? 5k threshold proposal.
4. **Corpus partition** — is `repo_id` range right (vs hash) given snippet lookups are always by id, and when does the first split happen?
5. **Public star visibility — resolved (2026-09-13, [09 §1](09-public-data-and-limits.md)).** `/users/{login}/starred` returns public stars only, verified; private stars are absent by construction. Service messaging is "public stars only" ([08 §1](08-public-service-ux.md)); keep the `star_count` sanity check ([03 §3](03-sync-and-limits.md)).
6. **Admission UX + legal** — 202-with-queue-position vs 429; unindex endpoint, ToS stance on serving README snippets for arbitrary accounts, retention statement.
7. **Embedding cache format + fairness metric** — packed f32 vs f16 (storage vs recall); p95 queue wait per priority class and the SLO from "user clicks sync" → first searchable result.

## Sources (verified 2026-09-13)

- Vectorize limits (20M vectors/index, 50k namespaces Paid, 64 B names, topK 50/100, 10 metadata indexes), filtering (<2,048 B filter, namespace-before-metadata, no arrays), API, and pricing ($0.05/100M stored, $0.01/M queried, 10M/50M included): <https://developers.cloudflare.com/vectorize/platform/limits/> · <https://developers.cloudflare.com/vectorize/reference/metadata-filtering/> · <https://developers.cloudflare.com/vectorize/reference/client-api/> · <https://developers.cloudflare.com/vectorize/platform/pricing/> (updated 2026-04-21…2026-08-05)
- D1 limits (10 GB/DB, 50k DBs, ~5,000 bindings/script, 2 MB row, 100 params) and pricing ($0.75/GB-mo, 25B reads/50M writes included): <https://developers.cloudflare.com/d1/platform/limits/> · <https://developers.cloudflare.com/d1/platform/pricing/>
- Workers AI pricing (10k neurons/day, bge-m3 1,075 neurons/M & $0.012/M, qwen3-embedding-0.6b MRL, reranker 283 neurons/M): <https://developers.cloudflare.com/workers-ai/platform/pricing/> (updated 2026-08-28)
- Workflows limits (50k running/2M queued, 300 creates/s/account, 10k steps, subrequests to 10M): <https://developers.cloudflare.com/workflows/reference/limits/> · DO limits/pricing (single-threaded, ~1,000 req/s soft; $0.15/M requests): <https://developers.cloudflare.com/durable-objects/platform/limits/> · <https://developers.cloudflare.com/durable-objects/platform/pricing/> · rate-limit binding locality: <https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/>
- R2 pricing ($0.015/GB-mo, 10 GB free, A $4.50/M, B $0.36/M, free deletes): <https://developers.cloudflare.com/r2/pricing/> · Queues pricing: <https://developers.cloudflare.com/queues/platform/pricing/>
- FTS5 contentless/contentless-delete semantics (SQLite 3.43+): <https://www.sqlite.org/fts5.html> · D1 supported SQL (FTS5 incl. `fts5vocab`): <https://developers.cloudflare.com/d1/sql-api/sql-statements/>
- GitHub rate limits / ETag behavior / `/user/starred` semantics: [03-sync-and-limits.md](03-sync-and-limits.md) sources.
