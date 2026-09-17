# 01 — Search modes & index deep dive

> ⚠️ **Pivot notice (2026-09-13):** this document predates the public multi-tenant pivot. See [08-public-service-ux.md](08-public-service-ux.md)–[12-hardening.md](12-hardening.md) for the current design and [11-assumptions-delta.md](11-assumptions-delta.md) for exactly what changed.

> Status: **draft for discussion** · 2026-09-13 · Based on live docs + npm/API verification on this date; ⚠️ marks low-confidence items to re-check at implementation time.

## 1. Recommendation at a glance

**All-Cloudflare DIY stack:**

| Layer              | Choice                                  | Why                                                                                      |
| ------------------ | --------------------------------------- | ---------------------------------------------------------------------------------------- |
| Metadata + filters | **D1** (SQL)                            | full SQL filters, joins with lexical results                                             |
| Lexical            | **D1 FTS5** (porter + trigram)          | FTS5 confirmed supported in D1 (docs updated 2026-04-21, incl. `fts5vocab`); native BM25 |
| Semantic           | **Vectorize** + **Workers AI `bge-m3`** | pre-filtered metadata search; 1024d; $0.012/M tokens                                     |
| Rerank             | **Workers AI `bge-reranker-base`**      | $0.0031/M tokens → ~$0.01/mo at our usage                                                |
| Fusion             | **RRF in the Worker**                   | ~20 lines; industry standard; used by Cloudflare AI Search itself                        |

Marginal cost ≈ **$0–1/mo** on top of the $5 Workers Paid plan. One-time backfill ≤ **$0.40**. Full comparison in §6.

## 2. Query taxonomy (from requirements)

| Query type               | Example                                   | Lexical | Semantic                          | Hybrid |
| ------------------------ | ----------------------------------------- | ------- | --------------------------------- | ------ |
| Exact name / identifier  | `effect`, `sqlite-vec`, `useEffect`       | ✅      | ⚠️ (tokenizers split identifiers) | ✅     |
| Concept / paraphrase     | "durable background jobs with retries"    | ❌      | ✅                                | ✅     |
| Mixed: concept + filters | "tui for git --lang rust --min-stars 500" | ⚠️      | ✅                                | ✅     |
| Incidental strings       | error text, CLI flags                     | ✅      | ❌                                | ✅     |
| Similar-to               | `similar effect`                          | ❌      | ✅                                | n/a    |

Hybrid is the default for a reason: no single mode covers the whole taxonomy.

## 3. Search modes

### 3.1 Lexical — SQLite FTS5 in D1

- **Confirmed**: D1 supports the FTS5 module (including `fts5vocab`) — [Cloudflare D1 docs, updated 2026-04-21](https://developers.cloudflare.com/d1/sql-api/sql-statements/).
- One FTS5 table over `full_name`, `description`, `topics`, `readme`; `tokenize='porter unicode61'`.
- A second **trigram** FTS index for substring/identifier hits (`sqlite-vec`, `useEffect`, `bge-m3`).
- Ranking with `bm25()`; snippets with `snippet()`; highlighting with `highlight()`.
- **Strong**: exact names, identifiers, rare tokens, quoted phrases. Deterministic, free, fast, no model needed.
- **Weak**: vocabulary mismatch ("job scheduler" ≠ "cron"); typos (trigram mitigates partially).
- **Role**: the leg that always runs; also carries all metadata filters via plain SQL.

### 3.2 Semantic — Vectorize + Workers AI embeddings

Embedding model options (Workers AI):

| Model                           | Dims       | Context                            | $/M tokens | Notes                                                                                                             |
| ------------------------------- | ---------- | ---------------------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------- |
| **`@cf/baai/bge-m3`** ✅ chosen | 1024       | long (docs say 60k; HF card 8k) ⚠️ | **$0.012** | multilingual, cheapest published; backfill fits one day's free allowance; batch-call schema needs a live check ⚠️ |
| `@cf/baai/bge-base-en-v1.5`     | 768        | 512 toks                           | $0.067     | clean ≤100-text batches; needs ~300-token chunks                                                                  |
| `@cf/baai/bge-small-en-v1.5`    | 384        | 512 toks                           | $0.020     | cheapest English, lower quality                                                                                   |
| `@cf/qwen/qwen3-embedding-0.6b` | 1024 (MRL) | 8,192                              | $0.012     | strong; sync batch ≤32                                                                                            |

**Chunking (README → vectors):**

- Structure-aware Markdown split: ~1,200 chars, 15% overlap; never split inside code fences; prefix each chunk with `owner/repo — <nearest heading>` for context.
- One extra **summary vector per repo** (`name + description + topics + language`) — powers `similar` and repo-level recall.
- Deterministic chunking + per-chunk content hash → steady-state edits re-embed only changed chunks (usually 1–2).
- Estimated corpus: ~19.7k chunks + ~3.3k summary vectors ≈ **23k vectors**.

**Vectorize constraints that shape the design:**

- Max **1,536 dims**; metadata ≤10 KiB/vector; **topK ≤ 50** when returning metadata.
- Filters are **pre-filtered** (good) but limited: `$eq $ne $in $nin $lt $lte $gt $gte`; multiple keys = implicit AND; **no `$or`/`$and` nesting**.
- **Max 10 metadata indexes per index**, declared before insert; string metadata is indexed on the **first 64 UTF-8 bytes** only.
- **Topics are arrays → not filterable in Vectorize.** Plan: topic filters run on the D1 lexical leg; the semantic leg filters on `language / stars / archived / starred_at / license`. (Alternative: post-filter the top-50 by topics — slight recall loss. Decide in v1.)
- Mutations (upsert/delete) are **asynchronous** — visible in seconds; acceptable.

### 3.3 Hybrid — the default

- Run both legs with the same filters: FTS5 top-50 (BM25) + Vectorize top-50 (KNN).
- Fuse with **Reciprocal Rank Fusion**: `score = Σ 1/(60 + rank)` at chunk level, then aggregate to repo level (best chunk wins; star count as tie-break).
- Optional second stage: **rerank top 30–50 passages** with `bge-reranker-base`.
- Why RRF over weighted score sums: no calibration between BM25 and cosine needed; it keeps working as either leg's score range shifts; Cloudflare's AI Search uses `rrf` fusion too.

### 3.4 Context-driven extensions (v2+)

- Query rewriting/expansion with a Workers AI LLM (decompose "rust tui git diff tool" → structured query + filters).
- `similar <repo>` via the stored summary vector.
- AI per-repo summaries/tags (better browsing; extra filter dimensions like `--category tui`).

## 4. Filters

| Filter           | D1 (lexical/metadata)          | Vectorize (semantic)                      |
| ---------------- | ------------------------------ | ----------------------------------------- |
| language         | SQL `WHERE`                    | metadata index (string)                   |
| stars range      | `WHERE`                        | metadata index (number)                   |
| archived         | `WHERE`                        | metadata index (bool)                     |
| starred_at range | `WHERE`                        | metadata index (number, epoch)            |
| license          | `WHERE`                        | metadata index (string)                   |
| topics           | `json_each` over `topics_json` | ❌ array — lexical leg only / post-filter |

## 5. Where the data lives

| Store                 | Contents                                         | Approx size        |
| --------------------- | ------------------------------------------------ | ------------------ |
| D1 `repos`            | metadata + sync state                            | ~10–15 MB          |
| D1 `repos_fts`        | FTS5 index (name/desc/topics/readme)             | ~30–60 MB          |
| D1 `chunks`           | chunk text (snippets for semantic hits)          | ~25 MB             |
| Vectorize `starwatch` | ~23k vectors × 1024d                             | ~23.5M stored dims |
| R2 (optional)         | raw README archive (re-chunking without refetch) | ~26 MB             |

All well within free allowances (D1 5 GB, R2 10 GB; Vectorize stored dims cost pennies).

## 6. Index architecture options compared

### Option A — Cloudflare-native DIY ✅ recommended

D1 (metadata + FTS5 + chunks) → Vectorize → Workers AI → RRF fused in the Worker.

- Cost: ≈$0–1/mo marginal. Full control of chunking, fusion, rerank, filters.
- Filters: best possible (SQL + vector metadata).
- Effort: medium — but it's the same Effect code we're writing anyway; the extra pieces are a chunker and ~20 lines of RRF.
- Risks: we own relevance quality; Vectorize metadata constraints above.

### Option B — Cloudflare AI Search (managed)

Managed hybrid (vector + BM25, `rrf` fusion), built-in reranking, MCP endpoint, R2 as source, zero pipeline code.

- Limits that matter: **max 5 custom metadata fields** (we want 6+), filterable string prefix = 64 UTF-8 bytes, no arrays, embedding model **fixed at instance creation**, max 50 results.
- Pricing: open beta **free** within limits; preview pricing after: **$0.75/M tokens** ingestion + **$2/GB-mo** storage + **$0.75/1k** semantic queries → roughly **$4–17/mo** at our corpus depending on final terms ⚠️.
- **Verdict:** excellent _secondary_ surface (instant MCP, near-zero code) or fallback; not the primary engine because filters are a top requirement and we'd be locked to its limits. Can be added later over the same R2 corpus.

### Option C — Durable Object SQLite + Vectorize

Same FTS5 as D1, but single DO instance: strongly consistent, logic co-located, 10 GB/DO, storage $0.20/GB-mo.

- **Verdict:** D1 is simpler for one shared corpus. Revisit if we ever go multi-corpus/per-user.

### Option D — External engines (if we ever leave Cloudflare)

| Engine                | Hybrid                                              | Cost/mo @ our scale | Notes                                                                                                  |
| --------------------- | --------------------------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------ |
| **Turbopuffer**       | ✅ single-call BM25 + vector + RRF, rich pre-filter | **$16 min**         | best Workers DX + true single-call hybrid; per-unit pricing not public ⚠️                              |
| **Typesense Cloud**   | ✅ native hybrid + facets                           | ~$21.60             | stores full docs; one-time 720h free tier                                                              |
| **Qdrant Cloud**      | ✅ native RRF/DBSF, strong pre-filters              | **$0** (free tier)  | 1 GB RAM / 4 GB disk; best free external                                                               |
| **Meilisearch Cloud** | ✅ hybrid + facets + real UI                        | ~$20–30             | has a built-in Cloudflare Workers AI embedder                                                          |
| **Neon Postgres**     | ✅ pgvector + `lakebase_text` BM25 via SQL CTEs     | $0–5                | **only Effect-native option** (`@effect/sql-pg`); ParadeDB `pg_search` removed from Neon (Sep 2026) ⚠️ |
| Upstash Vector        | ✅ dense+sparse RRF (not BM25)                      | $0                  | filter "budget" can silently reduce recall ⚠️                                                          |
| Weaviate / Pinecone   | ✅ / partial                                        | $0 (free tiers)     | viable, no Workers-first story                                                                         |

**Why not external now:** cost isn't the deciding factor (several are free) — but the Cloudflare-native stack is just as cheap, keeps one vendor, one secret store, no extra accounts, and D1 FTS5 removed the old gap (no native keyword search) that used to force external engines. Keep a `SearchService` abstraction so a swap later is a weekend, not a rewrite.

### Comparison matrix

|                    | A: CF DIY           | B: AI Search       | C: DO+Vectorize | Turbopuffer        | Qdrant             | Neon                |
| ------------------ | ------------------- | ------------------ | --------------- | ------------------ | ------------------ | ------------------- |
| metadata filters   | ✅ SQL (best)       | ⚠️ 5 fields        | ✅ SQL          | ✅ rich pre-filter | ✅ rich pre-filter | ✅ SQL (best)       |
| lexical quality    | ✅ FTS5 BM25        | ✅ BM25            | ✅ FTS5         | ✅ BM25            | ⚠️ sparse vectors  | ✅ BM25             |
| semantic           | ✅                  | ✅                 | ✅              | ✅                 | ✅                 | ✅ pgvector         |
| single-call hybrid | ❌ (we fuse)        | ✅                 | ❌              | ✅                 | ✅                 | ❌ (SQL CTE)        |
| stores full docs   | ✅ D1               | ✅                 | ✅              | ✅                 | ✅ payload         | ✅                  |
| snippets           | ✅ FTS5/chunks      | ✅                 | ✅              | ✅                 | ✅                 | ✅                  |
| Workers/TS fit     | ✅ native           | ✅ binding         | ✅ native       | ✅ SDK             | ✅ REST            | ✅ Hyperdrive       |
| Effect fit         | ✅ `@effect/sql-d1` | ⚠️ plain fetch     | ✅ `sqlite-do`  | ⚠️ plain fetch     | ⚠️ plain fetch     | ✅ `@effect/sql-pg` |
| cost/mo            | **$0–1**            | $0 beta → $4–17 ⚠️ | $0–1            | $16                | **$0**             | $0–5                |
| lock-in            | low                 | high               | low             | medium             | low                | lowest              |

## 7. Ranking & fusion design (proposed)

1. Parse query → `{ text, filters, mode: auto|keyword|smart|semantic }`.
2. Legs in parallel: FTS5 top-50 (SQL filters) + Vectorize top-50 (metadata filters).
3. RRF fuse at chunk level; aggregate per repo: best chunk score + star-count tie-break.
4. Optional rerank of top 30 passages (`bge-reranker-base`), then order.
5. Result = repo + best snippet (FTS `snippet()` or matched chunk, ~200 chars) + score + deep link.
6. Mode routing: hybrid by default; lexical-only when the query looks like an exact identifier (single token, contains `-`/`.`/`/`, or matches a repo name).

## 8. Cost at our scale (CF-native)

| Item                                    | One-time    | Monthly                   |
| --------------------------------------- | ----------- | ------------------------- |
| Workers Paid                            | —           | $5.00                     |
| Embeddings — backfill 5.7M tok (bge-m3) | $0.07       | $0.007 steady state       |
| Vectorize stored dims (~23.5M)          | —           | ~$0.007                   |
| Vectorize queries (few hundred/mo)      | —           | $0 (50M dims/mo included) |
| Reranker (300 searches × 50 passages)   | —           | ~$0.01                    |
| D1 / R2 / Workflows / Queues            | —           | $0 (within allowances)    |
| **Total**                               | **≤ $0.40** | **≈ $5.02**               |

Stable through ~10× usage growth. First cost that grows: Vectorize stored dimensions.

**Free-tier math:** Workers AI includes 10,000 neurons/day ≈ **9.3M tokens/day** at bge-m3 (1,075 neurons/M tokens). The entire backfill (~5.7M tokens) fits in a single day's free allocation, and steady state (~0.6M tokens/mo) never leaves the free pool. That's why bge-m3 is the "free at our scale" choice — the paid floor is only the $5 Workers plan.

## 9. Phases

- **Phase 1 (build):** D1 FTS5 + Vectorize + bge-m3 + RRF (+ rerank flag), behind a `SearchService` interface.
- **Phase 2:** WebUI + MCP; optionally register AI Search over the same R2 corpus as an instant secondary surface.
- **Phase 3 (only if relevance disappoints):** swap the lexical/vector engine behind `SearchService` (Turbopuffer or Neon are the two contenders).

## 10. Open decisions (for discussion)

1. ✅ **bge-m3 chosen** (free at our scale — see §8); still verify its batch input schema live before building the pipeline ⚠️.
2. ✅ **Rerank in v1** (flag-controlled; ~$0.01/mo).
3. Chunk size 1,200 chars / 15% overlap — confirm.
4. Topic filtering in the semantic leg: lexical-only vs `primary_topic` metadata field (64-byte string).
5. Exact filter set (see requirements §7.4).
6. Identifier-routing heuristic vs always-hybrid.

## Sources (load-bearing, verified 2026-09-13)

- D1 FTS5: <https://developers.cloudflare.com/d1/sql-api/sql-statements/>
- Vectorize limits: <https://developers.cloudflare.com/vectorize/platform/limits/> · filtering: <https://developers.cloudflare.com/vectorize/reference/metadata-filtering/> · pricing: <https://developers.cloudflare.com/vectorize/platform/pricing/>


- Workers AI models: <https://developers.cloudflare.com/workers-ai/models> · pricing: <https://developers.cloudflare.com/workers-ai/platform/pricing> · reranker: <https://developers.cloudflare.com/workers-ai/models/bge-reranker-base>
- AI Search: <https://developers.cloudflare.com/ai-search/> · limits/pricing: <https://developers.cloudflare.com/ai-search/platform/limits-pricing>


- GitHub search limitation: <https://docs.github.com/en/search-github/searching-on-github/searching-for-repositories> (no `is:starred`; 1,000-result cap: <https://docs.github.com/en/rest/search/search>)
