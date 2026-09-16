# 15 — Free Semantic Search (Zero-Spend Design)

> Status: **draft for discussion** · 2026-09-13 · ⚠️ marks low-confidence items to re-check at implementation time.
> Scope: the **hard requirement** is zero spend — Workers **Free** plan only (100k req/day, **10 ms CPU**/request, 128 MB/isolate, 50 subrequests) plus the free allowances of D1 (5 GB total, 500 MB/DB), R2 (10 GB, 1M Class A + 10M Class B ops/mo), Workers AI (10k neurons/day), Cache API and KV. This doc **supersedes the Vectorize semantic leg** in [01 §3.2](01-search-and-index.md), [07 §4.3](07-search-contract.md) and [10 §3](10-multitenant-architecture.md); [07](07-search-contract.md) still owns relevance/latency targets (docs 16–18 pending), [12](12-hardening.md) owns paid-mode degraded behavior, [14](14-abuse-protection.md) owns the $0 budget/degradation authority, and [13](13-free-tier-feasibility.md) owns the free-plan quota matrix. It changes _where vectors live and how they are searched_, not what results must look like.
>
> **Updated 2026-09-13 (free-tier pivot):** canonical free caps — `MAX_STARS = 10,000`, semantic window newest **1,500** repos, ≤10 weighted new users/day, embeddings ≤6,000 neurons/day — are reconciled with [14 §3.6/§4](14-abuse-protection.md).

## 1. Vectorize free tier cannot host this service (⚠️ verified live 2026-09-13)

**Free-tier billing facts** ([pricing](https://developers.cloudflare.com/vectorize/platform/pricing/), docs updated 2026-04-21; [limits](https://developers.cloudflare.com/vectorize/platform/limits/), updated 2026-08-05): Workers Free includes **5M stored vector dimensions/month** and **30M queried vector dimensions/month**; vectors are **float32 only** (no int8/binary); max 100 indexes and 1,000 namespaces per index on Free. Queried dims are charged by the formula `(stored + queried) × dims`, i.e. **each query effectively scans the whole namespace**, so a single query over one user costs that user's stored dims.

Per-user sizing from [10 §3](10-multitenant-architecture.md) — 23,552 vectors (19.7k chunks + 3.3k summaries) vs repo-level 3,448:

| Vector granularity | dims | dims/user | Stored users in 5M | Semantic queries/mo (30M ÷ dims/user) |
| ------------------ | ---- | --------- | ------------------ | ------------------------------------- |
| chunk-level        | 1024 | 24.1M     | **0**              | 1.2                                   |
| chunk-level        | 512  | 12.1M     | **0**              | 2.5                                   |
| chunk-level        | 128  | 3.0M      | **1**              | 10                                    |
| repo-level         | 1024 | 3.53M     | **1**              | 8                                     |
| repo-level         | 512  | 1.77M     | **2**              | 17                                    |
| repo-level         | 256  | 0.88M     | **5**              | 34                                    |
| repo-level         | 128  | 0.44M     | **11**             | 68                                    |
| repo-level         | 32   | 0.11M     | **45**             | 273                                   |

With the free-tier window of 1,500 repos ([14 §3.6](14-abuse-protection.md)) the per-user dims shrink ~2.3×, which does not change the conclusion.

**Conclusion.** The free Vectorize tier is a single-user demo: one full repo-level index at 1024d leaves ~8 semantic searches/month; even 11 users at 128d share ~68 searches/month. Chunk-level does not fit at all (MRL-shrunk 128d still only holds **one** user). Vectorize is also float32-only, so int8 quantization cannot stretch it. It cannot back a public multi-tenant semantic service, and the paid tier is out by the zero-spend rule. **Keep Vectorize out of the free critical path** (a `SearchBackend`/`SemanticIndex` adapter stays in place for a future paid migration — see §6.2). ⚠️ The query column assumes namespace-scoped billing, the best case; the pessimistic whole-index reading is worse (see the billing ambiguity flagged in [10 §3.2](10-multitenant-architecture.md)), and either way the conclusion is unchanged. Instrument the first deployed week if this is ever revisited.

## 2. Replacement design: one vector per repo, brute-force kNN in the Worker

### 2.1 Corpus shape

- **One vector per (user, repo)** — 3,448 typical; the $0 launch embeds the newest **1,500** repos ([14 §3.6](14-abuse-protection.md)) and listing is capped at `MAX_STARS = 10,000` ([14](14-abuse-protection.md)); benchmark tables below include 5,000 for CPU/R2 headroom. No chunk vectors on the free tier: 23k vectors/user costs ~6.3× the embedding tokens (§5) and forces either Vectorize or unacceptable storage/CPU.
- **Document text** (what gets embedded): `owner/name — <description> | topics: … | <language>` + a **distilled README**: markdown/HTML-stripped, first ~600 chars plus the first lines under the top 2 headings, hard cap **1,400 chars** (~350 tokens). Chunk text stays in D1 for snippets, but is no longer embedded.
- **Per-user dims/precision are configurable**, unlike Vectorize (fixed dims per index). The blob header records `dims`/`precision`, so hot and cold tiers can differ.
- **Filters become pre-filters**: SQL in the user shard resolves the filter set to `repo_id`s (or a filter bitset stored in the blob), and only those vectors are scored. This is exact and cheaper than Vectorize's metadata indexes; topic filters, previously post-filtered ([07 §4.3](07-search-contract.md)), become first-class.
- **Tenancy is file-per-user, not namespace-per-user**: isolation comes from the R2 key + the user shard's `repo_id` set. There is no shared ANN index to collapse recall on (contrast [10 §3.1(b)](10-multitenant-architecture.md)) and no server-side vector count limit — the only ceilings are R2 bytes and the 10 ms CPU scan.
- **Updates are whole-blob rewrites**: a sync re-embeds only changed repo docs (content hashes), mutates a fresh in-memory blob, writes a new `index_version`, then flips the D1 pointer. Old objects stay until the nightly GC, so in-flight searches keep serving a consistent snapshot. A 5,000-repo rewrite is ~7 MB — one Class A op.
- **Unstarred repos** are removed at the next sync by rebuilding the blob from `user_stars WHERE is_starred = 1`; no per-vector delete API is needed.

### 2.2 Model and MRL

- **`@cf/qwen/qwen3-embedding-0.6b`** — $0.012/M tokens = **1,075 neurons/M** (same as bge-m3), 1024-dim output, **MRL 32–1024** per the Qwen model card, plus a query-side `instruction`. Workers AI does **not** expose a `dimensions` parameter: the verified input schema accepts `queries`/`documents`/`text` with **max 32 texts/request** and no dims field, so MRL truncation is **client-side**: slice the first _d_ dims and renormalize (`v = v[0..d]; v /= ||v||`). Quality at 256/512 must be eval-gated ⚠️.
- `bge-m3` is a viable fallback (same price/neuron rate, 100-text batches ⚠️, 60k context) but its output is **fixed 1024d** (not MRL), so it forces 1024d storage/CPU.
- `@cf/google/embeddinggemma-300m` (768d, MRL to 128, 512-token input, 100-text batches verified) is attractive on CPU but its **price is unpublished** (absent from the embeddings pricing table) ⚠️ — excluded from a zero-spend design for now.

### 2.3 Storage: R2 blobs + Cache API (never D1 BLOBs)

One immutable, versioned blob per user; deterministic key `vectors/{model}/{dims}/{precision}/u{user_id}/{index_version}.bin`:

```
magic u32 | version u16 | dims u16 | precision u8 | flags u8 | count u32 | reserved u32
ids      u32[count]                    // repo_id per position, sorted
vectors  count × stride bytes          // f32: dims×4 · int8: dims (+optional scale)
filters  count × 8 bytes               // packed language/archived/fork/star-range bits (optional)
```

- Fixed stride + parallel `Uint32Array` ids = O(1) random access for hybrid rerank (§4) and binary-search lookup by `repo_id` (0.022 ms for 1,000 lookups over 5k — §3.2).
- **R2 is the store** (`get().arrayBuffer()` → `new Float32Array(buf)` view is ~free). **D1 BLOBs are disqualified**: the binding returns BLOBs as a plain JS `number[]` (`Array.from`), and benchmarked cost is **82 ms for a 1.77 MB blob** — 8× the entire free CPU budget. D1 keeps only small metadata (`dims`, `precision`, `r2_key`, `etag`, timestamps).
- **Cache API** in front, keyed by the full R2 key (version included), TTL 300 s: a search in a warm colo never touches R2. First search per colo per version is one Class B op (10M/mo free). No KV needed (KV could hold the manifest/version pointer if desired).
- Updates rewrite the whole blob in one Class A op (~1M/mo free); the `index_version` bump in D1 invalidates caches without explicit purges.
- Eviction = one R2 delete (free op) + D1 row flip, matching [10 §6](10-multitenant-architecture.md); no `deleteByIds` paging.

Storage per user (3,448 vectors, ids + optional scale included), and R2 capacity at ~8 GB usable (2 GB reserved for READMEs):

| dims / precision | bytes/vector | per user    | users @8 GB | CPU @5,000 repos (§3) |
| ---------------- | ------------ | ----------- | ----------- | --------------------- |
| 1024 f32         | 4,100        | 14.1 MB     | ~565        | 5.6 ms — too close    |
| 512 f32          | 2,052        | **7.08 MB** | ~1,130      | **2.3 ms**            |
| 256 f32          | 1,028        | 3.54 MB     | ~2,260      | 1.1 ms                |
| 512 int8         | 520          | 1.79 MB     | ~4,470      | 4.4 ms (V8 penalty)   |
| 256 int8         | 264          | 0.91 MB     | ~8,800      | ~2.2 ms (est.)        |

**Vectors/user: 3,448 (repo-level) vs 23,552 (chunk-level, not on Free); at the canonical newest-1,500 window the per-user columns above shrink ~2.3× (e.g. ~3.1 MB at 512d f32). D1/user: <2 KB — pointer row (`vector_blobs`) + `user_semantic` state; no vectors. Cache API/user: one cached object per colo, free, 512 MB/object. R2/user: the table above plus ~7.5 KB/repo of shared README text.**

### 2.4 Query path and the 10 ms CPU budget

1. Parse query (<2 ms budget in [07 §3.2](07-search-contract.md)); 2. embed the query once (`queries` with instruction, ~30–60 tokens); 3. fetch the user blob (Cache API → R2); 4. FTS5 top-50 and (optionally) top-N candidates; 5. score candidate/full set with a flat f32 dot product, 4× unrolled; 6. top-k=50 (heap only if k > 200); 7. RRF + boosts + snippet from D1.

| Step (512d f32, 5,000-repo user)    | Measured p50 | Derated ×2.5 | Note                                                                                          |
| ----------------------------------- | ------------ | ------------ | --------------------------------------------------------------------------------------------- |
| full scan (pure semantic / similar) | 2.33 ms      | 5.8 ms       | §3                                                                                            |
| hybrid: gather 1,000 FTS candidates | 0.42 ms      | 1.1 ms       | §4                                                                                            |
| top-k=50 selection                  | 0.03–0.07 ms | ~0.2 ms      | naive insertion; heap for k>200                                                               |
| blob view (`Float32Array`)          | ~0 ms        | ~0 ms        | view is free; `arrayBuffer()` copies the body (~1–2 ms per 7 MB, memory counts toward 128 MB) |
| parse + fusion + response shaping   | ~1.0 ms      | ~1.0 ms      | estimate ⚠️                                                                                   |
| snippet/meta fetch from D1          | ~1.0 ms      | ~1.0 ms      | estimate ⚠️                                                                                   |
| **total (pure semantic)**           | **~4.5 ms**  | **~8.0 ms**  | fits 10 ms with little margin                                                                 |
| **total (hybrid rerank)**           | **~2.5 ms**  | **~3.4 ms**  | comfortable                                                                                   |

1024d f32 (5.6 ms measured) derates to ~14 ms — **not viable on Free**. 128–256d, or int8 storage for cold tiers, are the levers. At the canonical newest-1,500 window the full scan is ~0.7 ms p50 at 512d f32 (§3.1: 3,448 vectors = 1.60 ms), so the 5,000-repo column is headroom, not the launch size. The default free-tier search is therefore **hybrid-first** (§4) with the full scan reserved for `semantic`/`similar`.

### 2.5 Indexing path under Free limits

3,448 docs ÷ 32 per AI call = **108 calls/user** (1,500-repo window: ~47 calls), at/over the **50-subrequest/invocation** Free limit → indexing must span invocations. Both Workflows (Free: 1,024 steps, 10 ms CPU/step, 50 subrequests/step) and Queues (Free: 10k ops/day) are available; Workflows per-user with ~3 embed steps (≤ 32 calls each) is the direct mapping to [10 §7](10-multitenant-architecture.md). Content-addressed dedupe ([10 §2.6](10-multitenant-architecture.md)) still applies: shared repos are embedded once, users copy pointers, so the real token cost tracks the _unique_ corpus.

Per user, standard profile: 1 listing sync + 108 batched embed calls across 3 Workflow steps (1,500-repo window: ~47 calls across 2 steps) + 1 blob `put` + a handful of D1 writes. Against Free allowances that is 3–4 Worker invocations, well inside 100k req/day and 10k Queue ops/day even at 10 weighted new users/day ([14 §4](14-abuse-protection.md)).

### 2.6 Data model deltas

Replace the Vectorize tables from [10 §2.3](10-multitenant-architecture.md) with a blob registry; the per-user shard keeps only pointers and states:

```sql
-- control DB: replaces vectorize_shards
CREATE TABLE vector_blobs (
  user_id     INTEGER PRIMARY KEY,
  index_version INTEGER NOT NULL DEFAULT 0,
  embed_model   TEXT NOT NULL,             -- '@cf/qwen/qwen3-embedding-0.6b'
  dims          INTEGER NOT NULL,          -- 256 | 512 (MRL slice)
  precision     TEXT NOT NULL DEFAULT 'f32' CHECK (precision IN ('f32','int8')),
  vector_count  INTEGER NOT NULL DEFAULT 0,
  r2_key        TEXT NOT NULL,
  etag          TEXT,                      -- CAS on rewrite
  bytes         INTEGER NOT NULL,
  built_at      INTEGER, last_error TEXT
);
-- user shard: per-user state only (replaces user_index_state.semantic_*)
CREATE TABLE user_semantic (
  user_id INTEGER PRIMARY KEY,
  state   TEXT NOT NULL DEFAULT 'absent'
          CHECK (state IN ('absent','building','ready','stale','degraded','error')),
  tier    TEXT NOT NULL DEFAULT 'none' CHECK (tier IN ('none','hot','warm','cold')),
  index_version INTEGER NOT NULL DEFAULT 0,
  dims INTEGER NOT NULL DEFAULT 512, precision TEXT NOT NULL DEFAULT 'f32',
  repos_embedded INTEGER NOT NULL DEFAULT 0,
  cpu_state TEXT NOT NULL DEFAULT 'ok' CHECK (cpu_state IN ('ok','pressured')),
  error_reason TEXT
);
```

`user_semantic.dims/precision` feed the query path (slice the query to the user's dims; choose the f32 vs int8 kernel). `cpu_state='pressured'` is set by the hourly job when the p95 scan derates past budget and is the per-user input to §6.1 step 2.

## 3. Node benchmark (V8 evidence)

**Method** (2026-09-13, Node 26.8.2, Linux x64, V8 JIT; scripts `/tmp/opencode/bench-semantic.mjs` + `bench2..5.mjs`): synthetic L2-normalized f32 vectors, flat typed arrays, 15–25 warmups + 60–100 iterations, p50 reported. Workerd runs the same V8 generation, but isolate flags and the CPU meter can differ — treat Node as a **best case** and apply a 2–3× derating until measured deployed ⚠️.

### 3.1 Full-scan dot products, p50 ms (4× unrolled f32; scalar int8)

| Vectors                 | f32 128d | f32 256d | f32 512d | f32 1024d | int8 512d |
| ----------------------- | -------- | -------- | -------- | --------- | --------- |
| 3,448 (typical user)    | 0.39     | 0.79     | 1.60     | 4.57      | 2.11      |
| 5,000 (Free cap)        | 0.58     | 1.14     | 2.33     | 5.58      | 4.44      |
| 20,000 (above Free cap) | 2.32     | 4.59     | 9.67     | 23.20     | 12.69     |

The f32 kernel that was measured (flat contiguous vectors, 4-way unrolled, ids in a parallel `Uint32Array`):

```ts
function bestDot(q: Float32Array, v: Float32Array, n: number, d: number) {
  let best = -Infinity,
    bestIdx = -1;
  const d4 = d & ~3; // dims are multiples of 4; tail handles the rest
  for (let i = 0; i < n; i++) {
    const o = i * d;
    let s0 = 0,
      s1 = 0,
      s2 = 0,
      s3 = 0;
    for (let j = 0; j < d4; j += 4) {
      s0 += q[j] * v[o + j];
      s1 += q[j + 1] * v[o + j + 1];
      s2 += q[j + 2] * v[o + j + 2];
      s3 += q[j + 3] * v[o + j + 3];
    }
    let s = s0 + s1 + s2 + s3;
    for (let j = d4; j < d; j++) s += q[j] * v[o + j];
    if (s > best) {
      best = s;
      bestIdx = i;
    }
  }
  return bestIdx; // + score for top-k
}
```

No allocation inside the loop; the blob is one `Float32Array` view over the R2 `ArrayBuffer` (or a slice for a candidate subrange), and int8 uses the same shape with an `Int8Array` view and int32 accumulators (safe: 512 × 127² = 8.3M ≪ 2³¹).

### 3.2 Supporting measurements

| Operation (5,000-repo user unless noted)                    | p50                                     |
| ----------------------------------------------------------- | --------------------------------------- |
| gather-dot 1,000 FTS candidates, 512d f32                   | **0.42 ms** (vs 2.52 ms full scan)      |
| binary search 1,000 `repo_id`s in a 5k sorted `Uint32Array` | 0.022 ms                                |
| top-k naive k=50 / heap k=200                               | 0.03 / 0.10 ms                          |
| MRL cascade 128d shortlist → 512d rerank top-500            | 1.36–1.67 ms (no win vs 1.60–2.33 full) |
| `JSON.parse` of a 35 MB f32 array + `Float32Array.from`     | **102 ms**                              |
| `new Float32Array(arrayBuffer)` view                        | ~0.01 ms                                |
| D1-style BLOB read (`Array.from`) of 1.77 MB                | **82 ms**                               |

### 3.3 Readings that drive the design

1. **f32 beats int8 per dim in V8** (~1.3–1.9× faster at equal dims; int8 only wins on bytes). int8 is a _storage_ optimization, not a CPU one.
2. **512d f32 fits the Free budget for ≤5k repos** (2.3 ms p50 → ~6 ms derated); 1024d does not.
3. **Cascades are not worth the complexity** at this N — only at 20k+ vectors does 128d→512d beat a full 512d scan, and pure-semantic users are capped at 5k.
4. **Binary only.** JSON parsing is 10× the CPU budget; D1 BLOB reads are 8×. R2 `ArrayBuffer` + typed-array _views_ are the only compliant read path.
5. **Flat contiguous `Float32Array` + 4× unroll** is the recommended kernel; AoS (`Float32Array[]`) is slightly faster on paper but adds per-vector objects and GC pressure. **WASM SIMD** ⚠️ is the escalation lever if workerd derating proves worse (same 128 MB/isolate; ~64 MiB script headroom).

## 4. Hybrid candidate approach

| Mode               | Candidate source                                   | Vector work                         | When it wins                                                                 |
| ------------------ | -------------------------------------------------- | ----------------------------------- | ---------------------------------------------------------------------------- |
| `keyword`          | FTS5 top-50                                        | none                                | identifiers, exact names, filters, degraded mode                             |
| `hybrid` (default) | FTS5 top-**500–1,000** → vector rerank             | gather-dot candidates only (0.4 ms) | descriptive + rare terms; keeps latent semantic recall off the critical path |
| `semantic`         | full per-user scan → top-50 → RRF                  | 2.3 ms at 512d                      | pure paraphrase/vocabulary mismatch (Q4/Q8), no FTS anchors                  |
| `similar <repo>`   | full scan                                          | 1 repo lookup + scan                | Q7; zero query-embedding tokens                                              |
| filtered hybrid    | SQL pre-filter → candidate `repo_id`s → gather-dot | 0.4 ms/1k candidates                | all mixed queries (Q5)                                                       |

- **RRF** stays as [07 §5.2](07-search-contract.md): repo-level `1/(60 + rank)`; only the _source_ of the semantic rank changes (candidate rerank vs full scan). The semantic aggregation formula is deleted: there is exactly one vector per repo, so `sem(repo) = cosine` and no chunk aggregation/length damping is needed.
- **Routing rules** (refine [07 §7.4](07-search-contract.md)): single token / punctuation / camelCase / name match → `keyword` (no AI call). Multi-token descriptive with no filters → full-scan `hybrid` (semantic ranks come from the scan, 2.3 ms). Descriptive **with** selective filters (language/topic/star range) → filtered gather-dot: resolve `repo_id`s in D1 first, score only those (0.4 ms/1,000). Long noisy queries → full scan. `similar` → direct index lookup + scan.
- **Worked example — Q5** `"http client" --topic http-client --lang ts`: D1 returns ~180 repos matching both facets → gather-dot 180 vectors (~0.1 ms) → semantic top-50; FTS gives its own ~40; RRF fuses; the target (`ky`) is in the candidate set by construction, so semantic recall is exact for the filtered universe and no Vectorize metadata index is needed.
- **Recall caveat (the important one).** Reranking FTS candidates _cannot_ recover a repo FTS missed, which is precisely the Q4/Q8 failure mode semantics exist for. Candidate rerank is a **latency/CPU optimization for queries that already have decent lexical anchors**, never a replacement for the full scan on descriptive queries (mirrors the launch gate in [07 §3.2](07-search-contract.md): hybrid must beat keyword-only by ≥0.08 nDCG@10 on Q4).
- **RRF combinations that are safe on this design**: (keyword, full-scan-semantic), (keyword, filtered-gather-semantic), (keyword, candidate-rerank) — each leg reports ranks, fusion is unchanged. What is _not_ safe is dropping the full scan for Q4/Q8 while claiming semantic coverage; `--explain` must show `semantic_source: full|filtered|candidates` so eval can assert it.
- Snippets come from the corpus (`repo_chunks`) selected by query-term overlap on the top semantic hits — no chunk vectors needed.

## 5. Workers AI budget (10k neurons/day)

10,000 neurons ÷ 1,075 neurons/M = **9.30M tokens/day** for embeddings (bge-m3 and qwen3-embedding-0.6b identical rate; $0.012/M). `embeddinggemma` price unpublished ⚠️.

| Document profile                                        | chars ≈ tokens/repo | tokens/user (3,448) | users/day @9.3M |
| ------------------------------------------------------- | ------------------- | ------------------- | --------------- |
| Metadata only (name+desc+topics)                        | 180 ≈ 45            | 0.16M               | ~60             |
| **Standard (metadata + distilled README, 1,400 chars)** | 1,400 ≈ 350         | **1.21M**           | **~7.7**        |
| Rich (2,400-char README)                                | 2,400 ≈ 600         | 2.07M               | ~4.5            |
| Chunk-level (23,000 × 1,200-char chunks)                | 330/chunk           | 7.59M               | ~1.2            |

**Free-window note:** at the canonical newest-1,500 window ([14 §3.6](14-abuse-protection.md)) the standard profile is ~0.53M tokens ≈ 565 neurons/user, i.e. ~10 users/day under the 6,000-neuron embeddings knob ([14 §4](14-abuse-protection.md)); the 3,448-repo rows above assume the full corpus and are the paid/comparison view.

- **Queries are cheap**: ~50 tokens/query ≈ 0.05 neurons; even 10k semantic searches/day is 0.5M tokens (~5% of the pool). Rerank (`bge-reranker-base`, 283 neurons/M; ~30k tokens/query) is ~8.5 neurons/search and also fits, but is optional on Free.
- **Batching**: qwen3 max **32 texts/request** (verified schema); bge-m3/embeddinggemma accept up to 100 ⚠️. 32-text batches mean 108 AI calls per user for the full 3,448-repo corpus (~47 in the 1,500-repo window); Workers AI rate limit is 3,000 req/min — never the constraint.
- **Batching plan** (per user, standard): 108 AI calls = 3 Workflow steps of 36 calls (1,500-repo window: ~47 calls = 2 steps, blob ~3 MB); each call returns 32 × 512d f32 ≈ 64 KB, so one step holds ~2.3 MB in memory and appends into the blob buffer incrementally; the blob (7 MB) fits the 128 MB isolate alongside the scan. Retry a failed batch once (250 ms backoff), then mark the repo `embed_state='error'` and continue — never fail the whole user for one repo ([03 §1.3](03-sync-and-limits.md) semantics).
- **Deployed validation before scaling admission** ⚠️: run `wrangler dev --remote` / deployed canary with the real 512d kernel and record `cpuTimeMs` per invocation (available in Workers Logs / Tail Worker trace events) at 3.4k and 5k repos. Freeze the derating factor in `eval` notes. If p95 CPU > 8 ms, apply §6.1 step 1 before raising the daily cap.
- **Admission**: ≤**10 weighted new users/day** overall ([14 §3.6/§4](14-abuse-protection.md)); at ~565 neurons per standard window, ~10/day fits the 6,000-neuron embeddings knob with headroom for query embeds, churn and retries. Steady-state churn (~2%/mo of each user's repos) is ~0.024M tokens/user/mo (≈26 neurons) — negligible.
- Count tokens in the `cost_ledger` ([12 §4.2](12-hardening.md)); pause new indexing (not search) when the day's ledger crosses **6,000 neurons** ([14 §4](14-abuse-protection.md)).

## 6. Fallback and migration

### 6.1 If even this exceeds 10 ms CPU

Triggers: `exceededCpu` rate > 0.5% on semantic routes, or p95 semantic latency > 500 ms, or the deployed/Node derating exceeds 4×. Fallback ladder (each step keeps the same API contract):

1. **Drop dims** per user (512 → 256), no re-embedding (MRL slice + renormalize).
2. **Hybrid-only** search: FTS top-N + candidate rerank (1.5 ms), `semantic` mode returns cached/full-scan only for users < 1,000 repos.
3. **Keyword-only MVP**: `X-Starwatch-Mode: keyword; degraded=cpu` (same mechanics as [12 §3.2](12-hardening.md)). UX wording — CLI: `showing keyword results · smart search is at capacity today`; WebUI banner: `Semantic search is temporarily off. Keyword results are complete and ranked as usual.` An explicit `--mode semantic` returns `503`, never a silent downgrade.
4. **Queue semantic** behind a per-IP daily allowance (or owner-only), so CPU is spent where neurons are.

### 6.2 Migration path to Vectorize (vectors stay reusable)

The free design deliberately keeps migration cheap: vectors are stored **unquantized f32 where possible** (int8 is a derived tier), content-addressed in R2, with the model version, dims and deterministic per-repo IDs (`r{repo_id}`) in the key/header. A later Vectorize upsert reads the same R2 blobs and copies values — **no re-embedding**, no GitHub refetch, matching [10 §6.2](10-multitenant-architecture.md). Metadata indexes are declared before the first upsert ([07 §4.3](07-search-contract.md)); f32 blobs already satisfy Vectorize's float32-only requirement. If Vectorize is never affordable, the same blobs keep serving the in-Worker path.

## 7. Recommendation

**Tiered free-semantic design: ship hybrid-on-repo-vectors day 1, keep chunk-level semantics for a paid future.**

| Tier        | Vectors    | dims/precision                      | bytes/user                                         | Search work                                                             | Promotion rule                                                                                                                     |
| ----------- | ---------- | ----------------------------------- | -------------------------------------------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| day 1 (MVP) | repo-level | **512 f32**                         | ~3.1 MB at the 1,500-repo window (7.1 MB at 3,448) | full scan at window (~0.7 ms); tested to 5k (2.3 ms) + candidate rerank | ≤10 weighted new users/day ([14 §4](14-abuse-protection.md)); cohort of 100–500 users; expand while R2 < 40% and derating measured |
| scale tier  | repo-level | **256 f32** hot / **512 int8** cold | 3.5 / 1.8 MB                                       | 1.1 / 4.4 ms                                                            | R2 > 60% full or CPU derating > 3×                                                                                                 |
| degraded    | repo-level | 256 f32                             | 3.5 MB                                             | hybrid-only, keyword fallback                                           | `exceededCpu`/neuron cap                                                                                                           |
| paid later  | repo+chunk | 1024 f32 → Vectorize                | 23k vectors                                        | Vectorize ANN + rerank                                                  | only if spend policy changes                                                                                                       |

**Rollout phases**

| Phase                                        | Scope                                                                                                                 | Exit gate                                                             |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| P0 — keyword MVP                             | D1 FTS5 + filters + snippets, no AI, no blobs                                                                         | Q1–Q3/Q9 targets met; browse deterministic; zero CPU risk             |
| P1 — semantic behind a flag                  | `vector_blobs` + Cache API + 512d f32, repo-level, ≤10 weighted users/day admission ([14 §4](14-abuse-protection.md)) | Q4 R@10 ≥ 0.80, p95 < 500 ms, `exceededCpu` < 0.5%, `cpu_state` wired |
| P2 — scale tiering                           | hot f32-512 / warm f32-256 / cold int8-512; MRL eval picks dims; eviction                                             | R2 < 60%, derating factor measured, Q4/Q7 gate at reduced dims        |
| P3 — paid/Vectorize (only if policy changes) | upsert existing blobs, chunk-level re-embed optional                                                                  | migration drill: Vectorize serves ≥ P2 nDCG with no re-embedding      |

**Decision table**

| Option                                  | Zero spend            | 10 ms CPU       | 3.4k users storage                                                  | Quality       | Ops     | Migration               |
| --------------------------------------- | --------------------- | --------------- | ------------------------------------------------------------------- | ------------- | ------- | ----------------------- |
| Vectorize Free                          | ✅                    | n/a             | **≤1 user**                                                         | good          | low     | n/a                     |
| Vectorize Paid                          | ❌                    | n/a             | ~$0.012/user/mo storage (chunk-level) ⚠️                            | good          | low     | n/a                     |
| **R2 blobs + in-Worker kNN (this doc)** | ✅                    | ✅ 512/256d f32 | ~1.1k users @8 GB at 3,448 vectors (~2.6k at the 1,500-repo window) | good (MRL ⚠️) | medium  | **clean (no re-embed)** |
| FTS-only                                | ✅                    | ✅              | n/a                                                                 | fails Q4/Q8   | trivial | clean if blobs kept     |
| External free tier (e.g. Qdrant)        | ⚠️ ToS/limits, non-CF | n/a             | 1 GB                                                                | good          | medium  | re-upload, no re-embed  |

**What changes in the other docs**

- [01](01-search-and-index.md): §3.2 (Vectorize + bge-m3) → this doc's repo-blob design; §5 Vectorize row → R2 vector blobs; §6 Option A/C; §8 costs → **$0**; §9 Phase 1.
- [07](07-search-contract.md): §4.3 metadata allocation (obsolete — SQL pre-filters + blob filter bits); §5.1 semantic leg = repo-level in-Worker kNN; §5.2 delete chunk aggregation/length damping; §5.4 rerank stays (passages from D1); §6 semantic snippet selection; open question 2 resolved; latency budget §3.2 (add scan budget).
- [10](10-multitenant-architecture.md): §3 (Vectorize multi-tenancy) replaced; §2.1 "Vectors" row → per-user R2 blob; `vectorize_shards` → `vector_blobs(dims, precision, r2_key, etag, cpu_state)`; §5 costs → $0 and D1/R2-only; §6 eviction = blob delete; §4.4 bindings drop `VECTORIZE_*`.
- [12](12-hardening.md): §3.1 budget semantics (CPU-bound), §4.1 global cap becomes an R2/CPU admission cap, degraded reason `cpu`; its free-tier supersession is [14](14-abuse-protection.md).
- [14](14-abuse-protection.md): semantic budget path = repo-level R2 blobs + in-Worker kNN (§2.2); window/caps reconciled (§3.6).

**Open questions**

1. **MRL quality** — nDCG@10 at 256/512d vs 1024d on `eval/golden.yaml`; pick the smallest passing dims (blocks the default).
2. **Workerd vs Node CPU** — measure `exceededCpu` and p95 with real 512d scans before scaling admission; fix the derating factor.
3. **Precision default** — is int8-512's 4.4 ms acceptable for cold tiers, or keep f32-256 (1.1 ms) and accept 2× storage?
4. **Filter strategy** — D1 row-read pre-filter vs blob filter bitset: which stays under 5M rows read/day at target traffic?
5. **Rerank on Free** — ~8.5 neurons/search is affordable, but does it earn its latency when the semantic leg is already CPU-limited?
6. **bge-m3 batch/context** — confirm the 100-text batch and 60k context claims if qwen3's 32-text batches become an indexing bottleneck.
7. **`similar` quality** — one repo vector per repo vs the old summary vector; does Q7 clear its curated-overlap target?
8. **Chunk-level comeback** — at what scale does chunk-level + Vectorize (or paid CPU) beat this design on the golden set, and do we keep chunk text when vectors go?

## Sources (verified 2026-09-13)

- Vectorize free/paid stored & queried dims + formula: <https://developers.cloudflare.com/vectorize/platform/pricing/> (updated 2026-04-21)
- Vectorize limits (float32, 100 indexes / 1,000 namespaces Free, 20M vectors/index): <https://developers.cloudflare.com/vectorize/platform/limits/> (updated 2026-08-05)
- Workers Free limits (10 ms CPU, 128 MB, 100k req/day, 50 subrequests, 50 Cache API calls/request): <https://developers.cloudflare.com/workers/platform/limits/> (updated 2026-09-05)
- Workers AI pricing (10k neurons/day; bge-m3 & qwen3-embedding-0.6b 1,075 neurons/M = $0.012/M; embeddinggemma absent ⚠️): <https://developers.cloudflare.com/workers-ai/platform/pricing/> (updated 2026-08-28)
- qwen3-embedding-0.6b input schema (`queries`/`documents`/`text`, maxItems 32, no `dimensions`), 1024d, 8,192 ctx: <https://developers.cloudflare.com/workers-ai/models/qwen3-embedding-0.6b/> · raw schema <https://raw.githubusercontent.com/cloudflare/cloudflare-docs/production/src/content/workers-ai-models/qwen3-embedding-0.6b.json>
- Qwen3-Embedding-0.6B MRL 32–1024 (model card): <https://huggingface.co/Qwen/Qwen3-Embedding-0.6B>
- embeddinggemma-300m (768d, MRL 128–768, 512 ctx, batch 100, price unpublished ⚠️): <https://developers.cloudflare.com/workers-ai/models/embeddinggemma-300m/> · <https://ai.google.dev/gemma/docs/embeddinggemma>
- bge-m3 (1024d fixed, 60k ctx): <https://developers.cloudflare.com/workers-ai/models/bge-m3/>
- D1 limits (500 MB/DB Free, 5 GB/account, 2 MB row, BLOB → `Array.from` on read): <https://developers.cloudflare.com/d1/platform/limits/> · <https://developers.cloudflare.com/d1/worker-api/> · <https://developers.cloudflare.com/d1/platform/pricing/>
- R2 free tier (10 GB, 1M Class A, 10M Class B): <https://developers.cloudflare.com/r2/pricing/> (updated 2026-08-07)
- Workflows Free limits (1,024 steps, 10 ms CPU/step, 50 subrequests; 100 concurrent, 100k executions/day): <https://developers.cloudflare.com/workflows/reference/limits/> (updated 2026-06-15)
- Queues Free (10k ops/day): <https://developers.cloudflare.com/queues/platform/pricing/> (updated 2026-04-21)
- Benchmark scripts: `/tmp/opencode/bench-semantic.mjs`, `bench2.mjs`, `bench3.mjs`, `bench4.mjs`, `bench5.mjs` (not committed; Node 26.8.2, Linux x64)
