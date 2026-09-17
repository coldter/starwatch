# 07 — Search Contract

> ⚠️ **Pivot notice (2026-09-13):** this document predates the public multi-tenant pivot. See [08-public-service-ux.md](08-public-service-ux.md)–[12-hardening.md](12-hardening.md) for the current design and [11-assumptions-delta.md](11-assumptions-delta.md) for exactly what changed.

> 📊 **Eval update (2026-09-13):** measured on the real 3,448-star corpus — see [18-search-quality-eval.md](18-search-quality-eval.md). **Required design changes before implementation:** deterministic query expansion (static lexicon), IDF/specificity-gated name boosts, quality-aware AND→OR fallback, repo-level 384–512d vectors (chunking not justified by the data).

> Status: **draft for discussion** · 2026-09-13 · Defines the v1 contract for query classes, accuracy targets, filters, ranking, snippets and parsing. Grounded in a read-only sample of the live stars (3,300 repos: full metadata; 110 READMEs fetched for size/quality stats) and the decisions in [00](00-requirements.md)–[02](02-stack-and-pipeline.md). ⚠️ marks items to verify at implementation time.

## 1. Scope and invariants

- Covers requirements **R1–R7** (search) and fixes the defaults behind **R11–R13** (CLI / WebUI / MCP). If this contract and a requirement disagree, requirements win; if this contract and doc 01 disagree, **this contract wins** (it is later and testable).
- One engine, three surfaces: CLI (v1), Web UI (v1), MCP (v2) call the same `SearchService`; filter names, defaults and result shape are identical everywhere (§4.5).
- **Semantic is a deployment capability, not a given.** `GET /api/health` reports `semanticSearch` (`STARWATCH_SEMANTIC_SEARCH`, default off). When it is off, `mode=hybrid|semantic` are answered as keyword results with `mode: "keyword"`, `semanticCoverage: 0` and **no** `degraded` flag — a keyword answer from a keyword-only deployment is the answer, not a degradation — and `relevance` stays the keyword + expansion fusion. Nothing else in this contract changes, and stored vectors/README state survive the flip in both directions.
- Corpus: **3,448 stars** (live 2026-09-13; earlier docs said 3,277 — a truncated pagination). Percentages below are from a live sample; use them as expectations, not exact counts.
- Search only sees metadata + README text. No code, issues, releases, or wiki content ([00 §5](00-requirements.md)).
- Every result is a repo (never a bare document/chunk). `similar <repo>` is the only mode without a text query.

**Baseline corpus facts (live sample, 2026-09-13):**

| Property                   | Sample result                                                    | Consequence for search                                           |
| -------------------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------- |
| README present             | 108/110 (98%)                                                    | `has-readme` is a rare narrowing; semantic covers ~98% of corpus |
| README size                | p25 3.8 KB · median 7.5 KB · p90 23 KB · max 232 KB · <1 KB ≈ 4% | chunking fine; tiny READMEs give semantic almost nothing (§8)    |
| Language NULL              | 154/3,300 (4.7%)                                                 | language filter excludes NULL unless `--lang unknown`            |
| License NULL / NOASSERTION | 10.1% / 11.1%                                                    | need a `none` sentinel; SPDX strings are short (§4.3)            |
| Topics empty               | 832/3,300 (25.2%)                                                | topic filters exclude a quarter of corpus by construction        |
| Description empty          | 103/3,300 (3.1%)                                                 | README text carries lexical                                      |
| Archived                   | 126/3,300 (3.8%)                                                 | penalty, not exclusion (§5.3)                                    |
| Forks                      | 32/3,300 (1.0%)                                                  | fork filter is effectively a no-op; default is "any"             |

## 2. Query classes and expected behavior

Seven classes. "Quality expectation" is plain language and maps to a target in §3.2. Examples are real repos in the star sample.

| #   | Class                       | Real example                                                                                                                        | Primary leg                                                                          | Quality expectation                                                             |
| --- | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| Q1  | Known-item (name)           | `lazygit` → `jesseduffield/lazygit`                                                                                                 | lexical + exact-name boost                                                           | rank 1 ≥ 95% of runs; target in top-3 ~100%                                     |
| Q2  | Known-item (ambiguous word) | `effect` → `Effect-TS/effect`                                                                                                       | exact-name boost; otherwise stars/recency surface `visual-effect`, `landing-effects` | without exact-name boost this query fails: it is the load-bearing test for §5.3 |
| Q3  | Known-item (identifier)     | `gql.tada`, `wttr.in`, `cal.diy`, `drizzle-orm`                                                                                     | keyword mode (punctuation heuristic) + trigram                                       | top-1 ≥ 95%; punctuation must survive tokenization                              |
| Q4  | Descriptive / conceptual    | "library to schedule durable background jobs with retries" → `hatchet`, `dbos-transact-ts`, `openworkflow`, `trigger.dev`, `bullmq` | semantic + rerank; lexical adds durable/jobs                                         | at least one target in top-3 ~80% of runs; in top-10 ~95%                       |
| Q5  | Mixed: concept + filters    | `"http client" --topic http-client --lang ts` → `ky`, `misina`, `insomnia`                                                          | hybrid, filters on both legs                                                         | useful target in top-3 ~85%; filters applied exactly, always                    |
| Q6  | Browse-only (no text)       | `--lang rust --min-stars 5000 --sort stars`                                                                                         | D1 SQL only                                                                          | byte-identical results for the same index snapshot; no relevance claims         |
| Q7  | Similar-to                  | `similar Effect-TS/effect` → `alchemy`, `effect-cf`, `effect-mq`, `visual-effect`                                                   | summary vectors                                                                      | ≥3 of top-10 human-judged related; ≥50% overlap with curated list               |
| Q8  | Long-tail / noisy           | "that parser combinator thing" → `optique`, `tree-sitter` (grade 1)                                                                 | semantic                                                                             | usable result in top-10 ~70%; in top-3 ~45%                                     |
| Q9  | Incidental strings          | `SQLITE_BUSY`, `--legacy-peer-deps`, import paths                                                                                   | lexical (porter + trigram)                                                           | repo mentioning the string in top-10 ≥ 85%                                      |

**Routing in `auto` mode (doc 01 §7 refined):** identifier-like queries (§6.4) run `keyword` mode first; if lexical returns 0 repos, escalate to `hybrid`. Everything else runs `hybrid`. `browse` runs when the text is empty. `similar` only via the explicit subcommand/tool. Routing is observable in `--explain` (`mode`, `fallback`).

**Filters are constraints, not boosts.** `"tui for git" --lang rust` correctly returns `gitoxide`/`gitbutler` and _not_ `lazygit` (Go) even though lazygit is the better semantic answer. Eval must assert filter correctness here, not recall (§3.3 Q5).

## 3. Accuracy targets and measurement

### 3.1 Metrics (definitions)

Per query, judged repos have grade 0 (not relevant), 1 (related/plausible), 2 (would open/save today). Unlisted repos are grade 0.

- `R@10` (recall@10, strict) = |grade-2 repos in top-10| / |grade-2 set|. Queries with no grade-2 target are excluded from R@10 but checked for graceful empty output.
- `nDCG@10` = DCG@10 / IDCG@10 with gain `2^g − 1` (2 → 3, 1 → 1, 0 → 0) and discount `1 / log2(rank + 1)`.
- `MRR` = mean over queries of `1 / rank` of the first grade ≥ 1 result in top-10; 0 if none.
- `Success@3` = fraction of queries with a grade-2 result in top-3. This is the number to quote in plain language.
- `p95 latency` = server-side total span, 5 runs/query, first run discarded (cold isolate), warm isolates only. Client network time reported separately.
- `Filter precision` = fraction of returned rows satisfying every filter (must be 1.000 by construction; asserted, not measured loosely).

### 3.2 Targets per class (launch gates)

| Class              | R@10                     | nDCG@10                              | MRR                                    | Success@3              | p95 latency       |
| ------------------ | ------------------------ | ------------------------------------ | -------------------------------------- | ---------------------- | ----------------- |
| Q1–Q3 known-item   | ≥ 0.95                   | ≥ 0.92                               | ≥ 0.92                                 | 1.00 (no exceptions)   | < 200 ms          |
| Q4 descriptive     | ≥ 0.80                   | ≥ 0.72                               | ≥ 0.68                                 | ≥ 0.80                 | < 500 ms          |
| Q5 mixed + filters | ≥ 0.85                   | ≥ 0.75                               | ≥ 0.70                                 | ≥ 0.85                 | < 500 ms          |
| Q6 browse          | n/a                      | n/a                                  | n/a                                    | Filter precision 1.000 | < 150 ms          |
| Q7 similar         | Curated-overlap@10 ≥ 0.5 | n/a                                  | Nearest curated ≤ 10 always; ≥ 0.5 MRR | —                      | < 300 ms          |
| Q8 long-tail/noisy | ≥ 0.60                   | ≥ 0.50                               | ≥ 0.45                                 | ≥ 0.45                 | < 500 ms          |
| Q9 incidental      | ≥ 0.85                   | ≥ 0.78                               | ≥ 0.75                                 | ≥ 0.85                 | < 300 ms          |
| **Overall**        | —                        | **≥ 0.75** (weighted by class count) | —                                      | —                      | **< 500 ms** (R7) |

Additional launch gate: **auto/hybrid must beat keyword-only on Q4 by ≥ 0.08 nDCG@10** on the golden set. If not, hybrid isn't earning its complexity and fusion must be re-tuned before shipping.

Latency budget (warm, concurrent legs): parse < 2 ms · FTS ≤ 60 ms · query embed ≤ 100 ms · Vectorize ≤ 120 ms (max, overlapped with FTS) · RRF + boosts < 5 ms · rerank ≤ 250 ms · snippet assembly ≤ 50 ms. Sum ≤ 480 ms with headroom.

### 3.3 Golden set

- **Size:** 60–100 queries, stored in-repo as `eval/golden.yaml`; baseline in `eval/baseline.json`.
- **Composition:** 15–20 known-item (split: 5 short names, 5 `owner/name`, 5 punctuation identifiers, 5 ambiguous words), 15–20 descriptive, 10–15 mixed (≥2 where a filter excludes the obvious answer), 5–10 browse (two expect zero rows), 5–10 similar (each with 3–10 curated neighbors), 10–15 noisy/long-tail (2–3 deliberately absent, e.g. "purple elephant database", to prove empty output is graceful), 5 incidental strings.
- **Grading:** grade before ever seeing ranker output; candidate pool = manual browsing + union of keyword/semantic top-20. Grade in one sitting, then re-check 20% after a week. A repo unstarred later → eval reports it `orphaned`; update the golden set instead of letting it silently become grade 0.
- **Index pinning:** every baseline records `repo_count`, `last_sync_at` and the chunker/model version. Index drift > 1% since baseline makes regression comparison invalid (see §3.5).

Schema (exact shape the harness reads):

```yaml
version: 1
index_snapshot:
  { repo_count: 3300, last_sync_at: "2026-09-13T06:00:00Z", embed_model: "bge-m3", chunker: "v1" }
queries:
  - id: k-002
    class: known-item
    query: "effect"
    mode: auto
    relevance:
      { "Effect-TS/effect": 2, "kitlangton/visual-effect": 0, "Dhravya/landing-effects": 0 }
    notes: "exact-name boost must beat star/recency prior"
  - id: d-001
    class: descriptive
    query: "library to schedule durable background jobs with retries"
    mode: auto
    relevance:
      "hatchet-dev/hatchet": 2
      "dbos-inc/dbos-transact-ts": 2
      "openworkflowdev/openworkflow": 2
      "triggerdotdev/trigger.dev": 1
      "taskforcesh/bullmq": 1
      "inngest/inngest": 1
  - id: s-001
    class: similar
    repo: "Effect-TS/effect"
    relevance:
      {
        "alchemy-run/alchemy": 2,
        "danieljvdm/effect-cf": 2,
        "TeamWarp/effect-mq": 2,
        "kitlangton/visual-effect": 1,
      }
```

### 3.4 Eval harness (`starwatch eval`)

```
starwatch eval [--set eval/golden.yaml] [--index local|deployed]
               [--mode auto|keyword|semantic|hybrid] [--rerank auto|on|off]
               [--classes known-item,descriptive,...] [--baseline eval/baseline.json]
               [--fail-on-regression] [--update-baseline] [--allow-drift] [--json] [--verbose]
```

- Runs each query against the chosen index in the requested mode; `auto` respects per-query routing from the golden set.
- Output: per-class metrics table (metric, baseline, current, Δ), overall row, latency p50/p95, slowest queries, worst per-query regressions, and orphan/missing-target report.
- `--json` emits the same data plus `git_sha`, `index_snapshot`, `run_at` — `eval/baseline.json` is exactly this document.
- Exit code 1 when the regression policy (§3.5) is violated and `--fail-on-regression` is set; 0 otherwise.
- `--index local` uses a local D1 snapshot (deterministic fixture; local embeddings recompute). The vector leg needs recorded neighbors (`eval/fixtures/vector_<snapshot>.json`, top-50 per eval query) because Vectorize can't be snapshotted ⚠️ confirm fixture size stays ≤ 10 MB.
- `--index deployed` is the end-to-end run (real D1 + Vectorize + AI) and is the only mode that validates latency targets.

### 3.5 Regression policy

Run `eval --fail-on-regression` before every change that touches retrieval, fusion, boosts, rerank, chunking, embeddings or filter SQL. It fails when any of:

1. A class drops **nDCG@10 by > 0.03 absolute**, **R@10 by > 0.05**, or **MRR by > 0.05** vs baseline.
2. **Any known-item query's grade-2 target falls out of top-10** — hard invariant, averages must not hide it.
3. p95 latency exceeds the class budget, or grows > 20% relative to baseline with no budget headroom.
4. Filter precision < 1.000 on any browse/mixed query.
5. Any orphaned target or index drift > 1% without `--allow-drift` (in that case the run reports metrics but refuses to fail: incomparable baselines).

Baseline updates require `--update-baseline` in the same commit as the change, with the eval diff pasted into the commit body. A baseline "refresh" without a retrieval change deserves its own review.

## 4. Filter taxonomy

### 4.1 Semantics and defaults

| Filter       | Values / format                                                                          | Default                        | D1/FTS leg                                                                | Vectorize leg                                                   | Missing values                                              |
| ------------ | ---------------------------------------------------------------------------------------- | ------------------------------ | ------------------------------------------------------------------------- | --------------------------------------------------------------- | ----------------------------------------------------------- |
| language     | GitHub language name; CLI aliases `ts`,`js`,`py`,`rs`,`go`; `unknown` allowed            | any                            | `language = ?` (alias→canonical, `IN` for alias sets)                     | string index `language` (canonical names; `"unknown"` sentinel) | NULL → only matches `--lang unknown`; Vectorize `"unknown"` |
| stars        | `min`,`max` integers ≥ 0, inclusive                                                      | unbounded                      | `stars >= ? AND stars <= ?` (index)                                       | numeric index `stars`, `$gte`/`$lte`                            | never NULL; treat as 0                                      |
| topics       | slug strings, repeatable                                                                 | any                            | `EXISTS (SELECT 1 FROM json_each(topics_json) WHERE value = ?)` per topic | ❌ arrays not filterable → **post-filter top-50** (§4.3)        | empty topics never match                                    |
| groups       | user-defined slugs, repeatable                                                           | any                            | join `repo_groups` + `EXISTS` per group                                   | ❌ post-filter                                                  | ungrouped repos never match                                 |
| starred date | `--starred-after` (inclusive) / `--starred-before` (exclusive), `YYYY-MM-DD` or ISO, UTC | unbounded                      | `starred_at >= ? AND starred_at < ?`                                      | numeric index `starred_at` (epoch s)                            | always present                                              |
| archived     | `--archived` / `--no-archived`                                                           | any (with ×0.40 penalty, §5.3) | `archived = ?`                                                            | bool index `archived`                                           | missing → false                                             |
| license      | SPDX id or `none`, case-insensitive, repeatable = OR                                     | any                            | `license IN (...)`                                                        | string index `license`; `"none"` sentinel                       | NULL → `none`; `NOASSERTION` kept literal                   |
| fork         | `--fork` / `--no-fork`                                                                   | any                            | `fork = ?`                                                                | bool index `fork`                                               | missing → false                                             |
| has-README   | `--has-readme` / `--no-readme`                                                           | any                            | `readme_state = 'present'`; present means ≥ 1 byte                        | bool index `has_readme`                                         | missing repo → false; 0-byte README = missing               |
| last-pushed  | `--pushed-after` / `--pushed-before` (UTC, same rules as starred date)                   | unbounded                      | `pushed_at >= ? AND pushed_at < ?`                                        | numeric index `pushed_at` (epoch s)                             | always present; bots make this a weak freshness signal      |
| owner/org    | `--owner`, exact GitHub login, case-insensitive, repeatable = OR                         | any                            | `owner_login IN (...)`                                                    | ❌ no index (spare slot) → post-filter on `full_name` prefix    | always present                                              |

### 4.2 Topic semantics — recommendation: AND by default

- `--topic a --topic b` = **both** required (`topicMode: "all"` default). Topics in this corpus are precise labels (`http-client`, `durable-execution`, `parser-combinators`); AND is what a user means when stacking facets, and it keeps result sets honest.
- `--topic-mode any` switches one query to OR; same for groups (`--group-mode any`).
- AND is applied **before** the result limit in D1; the vector leg post-filters its top-50, so an AND with a rare topic can legitimately return fewer than 10 semantic candidates. Documented limitation, not a bug (§4.3).
- Empty result due to filters never auto-relaxes. The CLI prints the active filters and a hint; the WebUI offers one-click removal.

### 4.3 Vectorize limits and our allocation ⚠️

Hard limits that shape the design: **≤ 10 metadata indexes per index** (declared before insert, cannot be added later without re-upserting); string metadata is filterable on the **first 64 UTF-8 bytes only**; **arrays are not supported** (topics, groups); multiple keys are implicit **AND**; `topK ≤ 50` when metadata is returned; a filter on a key that is absent at upsert time does not match `$eq` — so **store explicit defaults, never omit metadata**.

Allocation (8 of 10 used, 2 spare):

| #   | Metadata field          | Type   | Filters served                                                   |
| --- | ----------------------- | ------ | ---------------------------------------------------------------- |
| 1   | `language`              | string | language (`"unknown"` default)                                   |
| 2   | `stars`                 | number | min/max stars                                                    |
| 3   | `archived`              | bool   | archived tri-state                                               |
| 4   | `starred_at`            | number | starred date range                                               |
| 5   | `license`               | string | license (`"none"` default)                                       |
| 6   | `fork`                  | bool   | fork tri-state                                                   |
| 7   | `has_readme`            | bool   | has-README tri-state                                             |
| 8   | `pushed_at`             | number | last-pushed range                                                |
| —   | topics / groups / owner | —      | **post-filter** in the Worker after KNN (D1 lookup by `repo_id`) |

Post-filtering costs one D1 `IN` query per search and caps topic-filtered semantic recall at ≤ 50 candidates. If eval shows Q5 mixed recall suffering, the fallback lever is dropping the semantic leg for rare topics (lexical carries them). Owner stays unindexed on purpose: exact `full_name` prefix matching in the Worker is free and keeps 2 index slots free for future filters (e.g. `primary_topic`, v2 `category`).

### 4.4 Groups design ⚠️ (new in this contract)

Groups are user-defined labels for browse and narrowing (`cloudflare`, `tui`, `effect`, `v2-candidates`). Storage: `groups(id, slug, name)` + `repo_groups(repo_id, group_id)` in D1; managed by `starwatch group add|remove|list` (v1 scope to confirm — groups are not in [00 §4](00-requirements.md)). They are many-to-many and therefore post-filter only — never a Vectorize metadata field.

### 4.5 Naming parity (canonical across surfaces)

| Concept      | CLI                                                                 | HTTP API / MCP `filters`               | WebUI query param       |
| ------------ | ------------------------------------------------------------------- | -------------------------------------- | ----------------------- |
| language     | `--lang`                                                            | `language`                             | `language`              |
| stars        | `--min-stars` / `--max-stars`                                       | `minStars` / `maxStars`                | `minStars` / `maxStars` |
| topics       | `--topic` (repeat) + `--topic-mode`                                 | `topics[]` + `topicMode`               | `topics` + `topicMode`  |
| groups       | `--group` (repeat) + `--group-mode`                                 | `groups[]` + `groupMode`               | `groups`                |
| starred date | `--starred-after` / `--starred-before`                              | `starredAfter` / `starredBefore`       | same                    |
| archived     | `--archived` / `--no-archived`                                      | `archived: true\|false` (absent = any) | `archived`              |
| license      | `--license` (repeat)                                                | `license[]`                            | `license`               |
| fork         | `--fork` / `--no-fork`                                              | `fork: true\|false`                    | `fork`                  |
| has-README   | `--has-readme` / `--no-readme`                                      | `hasReadme: true\|false`               | `hasReadme`             |
| last-pushed  | `--pushed-after` / `--pushed-before`                                | `pushedAfter` / `pushedBefore`         | same                    |
| owner/org    | `--owner` (repeat)                                                  | `owner[]`                              | `owner`                 |
| sort / limit | `--sort relevance\|stars\|starred\|pushed` / `--limit` / `--offset` | `sort` / `limit` / `offset`            | same                    |

Shared result shape (contracts package): `{ full_name, url, description, language, stars, starred_at, pushed_at, archived, fork, license, topics[], groups[], snippet { text, html?, source, chunk_id? }, score, explain? }`. `snippet.text` is plain text; `snippet.html` is pre-escaped with only `<mark>` tags (§6). MCP omits `html` and `explain` unless requested.

## 5. Ranking and fusion defaults

### 5.1 Pipeline

1. Parse (§6) → `{ text, phrases, negations, filters, mode, sort, limit }`.
2. Legs in parallel with the same filters:
   - **Lexical:** `repos_fts` (name/desc/topics/readme, porter+unicode61) → top-50 repos by `bm25()`; plus trigram index for identifier tokens.
   - **Semantic:** embed query (bge-m3, 1024d) → Vectorize top-50 **chunks** with metadata pre-filters; aggregate to repos (§5.2).
3. RRF at **repo level** (decision, see below) with k = 60; apply boosts (§5.3).
4. Optional rerank of the top window (§5.4).
5. Attach snippets (§6); sort/limit; `--explain` records everything.

> **Decision — repo-level RRF.** Doc [01 §7](01-search-and-index.md) sketches chunk-level RRF, but the FTS index in [01 §3.1](01-search-and-index.md) is one row per repo, so the lexical leg cannot rank chunks. We fuse repo-level: FTS returns repo ranks directly; the semantic leg aggregates its chunks to a repo score first. Revisit only if eval shows long READMEs dominating semantic results after length damping.

### 5.2 RRF, top-k, chunk→repo aggregation

- Per-leg top-k: **50** (Vectorize `topK ≤ 50` with metadata; FTS matched).
- Semantic aggregation: `sem(repo) = max(cosine) + 0.3 × second_best(cosine)`, capped at **2 chunks per repo**, then length damping `× 1 / (1 + 0.03 · ln(chunk_count + 1))` (1 chunk → 0.98, 20 → 0.92, 40 → 0.90). The summary vector counts as chunk 0. Rank repos by the aggregated score; that rank feeds RRF.
- Fusion: `rrf(repo) = 1/(60 + rank_fts) + 1/(60 + rank_vec)`; display-normalized `base = rrf / (2/61) ∈ (0, 1]` (1.0 = ranked #1 by both legs).
- No weighted score sums: BM25 and cosine are not calibrated; RRF needs no tuning and matches Cloudflare AI Search's own `rrf` fusion.
- Final: `score = base × Π(boost factors)` (boosts below), then ordering/tie-breakers. A repo appears once in the fused list; its chunks never occupy it multiple times.

### 5.3 Boost / penalty table

All factors are multiplicative on `base` and are logged per result in `--explain`.

| Factor                                                                     | Multiplier                                  | Rationale / notes                                                                            |
| -------------------------------------------------------------------------- | ------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Exact `full_name` match (case-insensitive, includes `owner/name` queries)  | ×1.60                                       | Known-item guarantee; must beat star/recency priors. `effect` → `Effect-TS/effect`           |
| Repo name exact match (single token equals name)                           | ×1.45                                       | Handles both `lazygit` and `ky`                                                              |
| Name prefix match (query token is prefix of name, ≥ 3 chars)               | ×1.20                                       | `drizzle` → `drizzle-orm`                                                                    |
| All query tokens present in name                                           | ×1.10                                       | e.g. `"git oxide"`                                                                           |
| Star prior                                                                 | `1 + 0.04 · log10(stars + 1)`, capped ×1.25 | 82k → ×1.20, 16k → ×1.17, 100 → ×1.08. Never let popularity outrank meaning                  |
| Starred recently                                                           | ≤ 90 days ×1.10; ≤ 365 days ×1.05           | "saved for later" skews recent; helps vague memory                                           |
| Group boost (query text mentions a group slug/name, no explicit `--group`) | ×1.15                                       | Only when unambiguous; explicit group filters don't need it                                  |
| Archived                                                                   | ×0.40                                       | 3.8% of corpus; penalty not exclusion — archived gems are exactly what search should recover |
| README length                                                              | applied to `sem()` only, not final          | prevents 40-chunk READMEs from winning by surface area (§5.2)                                |
| Exact name in trigram leg                                                  | no extra boost                              | already reflected in lexical rank                                                            |

Boosts are intentionally small except the name family (×1.10–1.60). Anything larger makes semantic results unreachable for descriptive queries. Thresholds are tuning knobs; eval must justify changes (§3.5).

### 5.4 Rerank stage

- Model: `bge-reranker-base` (Workers AI), flag-controlled per doc 01 §7.
- **Window:** top **30** repos after boosts by default; `--rerank-depth 50` max. Passages: top 2 chunks per repo (best lexical/semantic matching chunks), ≤ 60 passages, each truncated to ~512 tokens; repo rerank score = max passage score.
- **Effect:** within the window, rerank score determines order; boosts that encode explicit user intent survive rerank — exact/prefix name factor, archived penalty, group factor. Star/recency/length factors are pre-rerank only. Items outside the window keep their RRF order below it.
- **Mode:** default `--rerank auto`: on for descriptive/mixed/noisy, off for known-item/browse/incidental (rerank adds latency and can only hurt an exact name match); forced with `on`/`off` for eval.
- **Cost:** ~60 passages × ≤ 512 tokens ≈ 30k tokens/query → ~$0.0001/query, ≈ $0.01–0.03/mo at our usage. Latency ≤ 250 ms p95; if the budget is at risk, drop depth to 30 before dropping rerank.

### 5.5 Tie-breakers

In order: (1) rerank score desc (when enabled), (2) fused `score` desc, (3) exact-name match rank (exact > prefix > token), (4) stars desc, (5) starred_at desc, (6) `repo_id` asc (stable, deterministic). Browse mode replaces 1–4 with the explicit sort key, then applies 5–6.

**Explicit sorts are a pure re-ordering of the match set** (`sort=pushed|starred|stars`, worker `SORT_MATCH_LIMIT`). Relevance order is decided inside each leg's top-50, so re-ordering that same window would show only "the newest of the 50 most relevant" — a repo pushed yesterday but ranked #60 would be unreachable. Legs therefore widen to 500 for non-relevance keys, and the fused set is re-ordered by the key (then 5–6). Nothing is re-scored: `score` and `matchedBy` still describe relevance, and `sort=relevance` is byte-identical to a search without a sort. A query-less request with an explicit key is the browse path: the filtered candidates ordered by the key, no legs and no embeddings.

### 5.6 `--explain` output shape

```jsonc
{
  "query": {
    "text": "durable background jobs",
    "mode": "hybrid",
    "fallback": null,
    "truncated": false,
    "filters": { "language": ["typescript"], "topics": ["durable-execution"], "topicMode": "all" },
  },
  "results": [
    {
      "repo": "hatchet-dev/hatchet",
      "score": 0.873,
      "rrf": {
        "lexical_rank": 7,
        "lexical_bm25": 14.32,
        "semantic_rank": 2,
        "semantic_cosine": 0.71,
        "chunks": 9,
      },
      "boosts": [
        { "name": "star_prior", "factor": 1.16 },
        { "name": "archived", "factor": 1.0 },
      ],
      "rerank": { "score": 0.91, "window_rank": 1 },
      "snippet": {
        "source": "semantic",
        "chunk_id": "hatchet-dev/hatchet:4",
        "text": "…",
        "highlights": ["durable"],
      },
    },
  ],
  "timings_ms": {
    "parse": 0.4,
    "lexical": 23.1,
    "semantic": 61.7,
    "rerank": 147.2,
    "total": 238.4,
  },
  "legs": { "lexical": "ok", "semantic": "ok" },
}
```

CLI pretty mode condenses each result to one reason line: `#2 sem:2 lex:7 ★7.9k stars+16% rerank:0.91`.

## 6. Snippets and highlighting

- **Lexical** (`snippet()` over `repos_fts`): `snippet(repos_fts, 3, '\x01', '\x02', ' … ', 24)` where column 3 is `readme` per [01 §3.1](01-search-and-index.md) (24 tokens ≈ 200 chars). Markers are stripped from indexed text at ingest, so they cannot collide. Result cap **200 chars**; if the snippet is empty/whitespace, fall back to `description` (first 200 chars), then to `owner/name`.
- **Semantic**: take the chunk that produced `max(cosine)`; chunk text is markdown-stripped at ingest (link text kept, URLs dropped, code fences kept as plain lines). Trim to the best sentence window: one sentence with the highest count of distinct query terms plus one neighbor, cap **240 chars**; if no term overlap, first 200 chars + `…`. The `owner/repo — <heading>` context prefix is used for embedding, not shown.
- **Highlighting order:** escape `& < > " '` first → insert `<mark>` (HTML surfaces) or ANSI bold (CLI, respects `NO_COLOR`). Highlight terms = parsed query terms and phrases (length ≥ 2, negations excluded); whole-word, case-insensitive; **max 6 marks** per snippet; never re-mark inside a mark. `snippet.text` stays plain (no markup); `snippet.html` contains only escaped text + `<mark>` and is safe for `innerHTML`. MCP always returns `text`.
- **Max lengths:** lexical 200 / semantic 240, hard cap 300; `starwatch show <repo>` returns full description + first 2,000 chars of README (not the whole file; R2 has the original).
- **Never render raw README HTML.** Ingest strips HTML tags and image syntax; snippets cannot inject markup beyond `<mark>`.

## 7. Query parsing rules and safety

1. **Grammar:** `query := (negation)? (phrase | term)`; quotes group phrases (`"exact phrase"`); `-term` and `-"exact phrase"` negate. Unbalanced quotes are lenient: everything after the first quote is treated as a phrase (no error).
2. **Default multi-term semantics:** lexical uses **implicit AND**; if it returns 0 repos and the query contains no quoted phrase/negation, retry with **OR** and set `fallback: "or"` in the response/explain. The semantic leg always embeds the full natural-language text.
3. **Negation:** lexical applies `AND NOT`; semantic drops negated tokens from the embedding and then excludes candidates whose name/description/topics contain the negated token (metadata check only). Documented as best-effort — a repo whose README mentions the negated term once is not excluded.
4. **Identifier detection (`auto` → `keyword` mode)** when any holds: single token; contains any of `- . _ / : @`; matches `/^[a-z0-9]+([-_][a-z0-9]+)+$/`; camelCase token (`useEffect`); or is an exact/prefix match against repo names in D1 (case-insensitive). `gql.tada`, `wttr.in`, `bge-m3`, `Effect-TS/effect` all route keyword; a 5+ token natural sentence never does.
5. **Empty query → browse mode:** the filtered candidates ordered by `sort`. `relevance` is meaningless without text, so it falls back to `sort=starred` — the **most recently starred repos first**, never a relevance claim. The response carries `total` (every candidate, not just the page) and accepts `offset`, so a client can page the whole star list instead of receiving a corpus dump in one response.
6. **Safety:**
   - FTS5 MATCH: every term is wrapped in double quotes with internal `"` doubled (`term.replaceAll('"', '""')`); raw FTS operators (`AND`, `OR`, `NOT`, `NEAR`, `*`, `^`, `:`) are never passed through — only our parsed `-` negation maps to `NOT`.
   - All SQL is parameterized; topics use `json_each` values, never string-built `IN` lists.
   - Unicode: NFC-normalize query and indexed text; `unicode61` handles case folding/diacritics; CJK works via trigram (substrings ≥ 3 chars) + bge-m3 multilingual embeddings.
   - Very long input: cap **512 chars / 64 tokens**; truncate, set `truncated: true`, and log. Embedding input additionally capped at 2,000 chars.
   - Control characters stripped before indexing and querying (also protects snippet markers).

## 8. Realistic expectations and non-goals

**When semantic disappoints.**

- ~4% of READMEs are < 1 KB and ~2% are missing/empty (live sample: 0-byte and 557-byte examples exist). Embeddings of a 5-line README carry almost no signal; these repos are reachable by name/lexical only, and the summary vector (name + description + topics + language) is their main semantic crutch.
- Boilerplate READMEs (templates, monorepos, "generated by X") embed near each other and pollute neighbors; rerank + star prior mitigate but do not fix this.
- Vague memory with wrong vocabulary ("that job thing with the retries") works only if the concept's words appear somewhere in the README; bge-m3 is good at paraphrase, not telepathy.

**When lexical disappoints.**

- Vocabulary mismatch ("job scheduler" vs README "cron") — semantic/rerank covers; FTS5 gives nothing.
- Typos: trigram partially covers ≥ 3-char substrings; short tokens (e.g. `ky`) cannot use trigram.
- Long natural-language queries hit implicit AND → zero results; the OR fallback (§7.2) is the safety net, with lower precision.
- 25% of repos have no topics, so topic-filter queries silently exclude them (correct but visible: report the excluded count? ⚠️ consider in UI).

**What a v2 LLM query-expansion stage buys.**

- Structured extraction (concept text + filters like `lang:rust`, `minStars:500`), synonym expansion ("durable jobs" → "workflow engine, queue, retry, cron"), and identifier repair (`usehook-ts` → `usehooks-ts`).
- Expected effect on the golden set: **+5–10 nDCG@10 points on descriptive/noisy classes**; Success@3 on Q8 from ~45% toward ~65%; mixed queries route filters more reliably. Roughly $0.001/query and 300–800 ms added latency — acceptable behind `--expand` (MCP default off), and only shippable if eval proves the gain. Index-time AI summaries/tags (v2, doc 01 §3.4) is the bigger win: it would give topics-like signal to the 25% of repos with none.

**Explicitly out of scope for v1.**

- Code search, issue/PR/release/wiki search; indexing non-README docs beyond a future "docs/" pass.
- Cross-user/global GitHub search or recommendations; feed/trending.
- Multi-turn conversational search, query clarification dialogs, LLM answer synthesis.
- Personalization from clickstream (none collected); ranking is corpus/query signals only.
- Non-GitHub sources (bookmarks, RSS, local notes).
- Non-English README quality: bge-m3 covers multilingual retrieval, but golden-set targets and grading are English; CJK lexical recall is trigram-only.

## 9. Open questions

1. **Groups in v1?** Not in [00 §4](00-requirements.md); this contract defines them anyway. Confirm scope (and whether group slugs are CLI-managed only).
2. **Topic post-filter recall cap**: accept the ≤ 50 semantic candidate limit, or drop the semantic leg when a rare topic filter is active? Decide with eval data on Q5.
3. **Star prior strength**: cap at ×1.25 here; the user may prefer stars as pure tie-break. Eval can settle it (k-002 is the canary).
4. **Rerank default**: `auto` (off for known-item) vs always-on. Latency budget suggests auto.
5. **Local eval fixtures**: record Vectorize neighbors per golden query (deterministic, no network) vs always eval against the deployed index. Fixture size ⚠️.
6. ~~Corpus count drift~~ — **resolved 2026-09-13**: canonical count is live-derived (**3,448**); docs/03 carries both-column tables.
7. **Empty-query default**: 25 most recently starred vs a saved "start page" (recent + groups + random rediscovery).

## Sources

Internal: [00-requirements.md](00-requirements.md) · [01-search-and-index.md](01-search-and-index.md) · [02-stack-and-pipeline.md](02-stack-and-pipeline.md).
External (verified 2026-09-13, same set as doc 01 unless noted):

- SQLite FTS5 (bm25, snippet, highlight, MATCH escaping): <https://www.sqlite.org/fts5.html>
- D1 FTS5 support: <https://developers.cloudflare.com/d1/sql-api/sql-statements/>
- Vectorize limits (10 metadata indexes, 64-byte prefixes, topK 50): <https://developers.cloudflare.com/vectorize/platform/limits/>
- Vectorize metadata filtering (operators, implicit AND, no arrays): <https://developers.cloudflare.com/vectorize/reference/metadata-filtering/>
- Workers AI reranker `bge-reranker-base`: <https://developers.cloudflare.com/workers-ai/models/bge-reranker-base>
- RRF (Cormack, Clarke & Buettcher 2009): <https://plg.uwaterloo.ca/~gvcormac/cormacksigir09-rrf.pdf>
- nDCG (Järvelin & Kekäläinen 2002): <https://dl.acm.org/doi/10.1145/582415.582418>
- bge-m3: <https://huggingface.co/BAAI/bge-m3>
- GitHub starred API (sampling method for the stats in §1/§8): <https://docs.github.com/en/rest/activity/starring>
