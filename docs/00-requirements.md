# 00 — Requirements

> ⚠️ **Pivot notice (2026-09-13):** this document predates the public multi-tenant pivot. See [08-public-service-ux.md](08-public-service-ux.md)–[12-hardening.md](12-hardening.md) for the current design and [11-assumptions-delta.md](11-assumptions-delta.md) for exactly what changed.

> Status: **draft for discussion** · 2026-09-13
> Technical deep dives: [01-search-and-index.md](01-search-and-index.md) · [02-stack-and-pipeline.md](02-stack-and-pipeline.md)

## 1. Problem

~3,400 GitHub stars (3,448 as of 2026-09-13), and no way to search them properly:

- GitHub's stars page search matches **repo name/topic only** (official docs: "The search bar only searches based on the name of a repository or topic").
- Global repo search has **no `is:starred` qualifier** (verified live: API returns `422 — "None of the search qualifiers apply to this search type"`), caps at **1,000 results**, and `in:readme` only works globally — never scoped to your stars.
- Star Lists have **no REST API and no search** (GraphQL only).
- Net effect: repos "saved for later" are effectively lost unless you remember the exact name.

## 2. What we're building

**starwatch** — a personal search service over the user's GitHub stars.

|            |                                                                                           |
| ---------- | ----------------------------------------------------------------------------------------- |
| Corpus     | ~3,400 starred repos (3,448 live 2026-09-13; growing ~10–20/week): metadata + README text |
| Search     | full-text (BM25) + semantic (vector) + hybrid, with filters                               |
| Interfaces | **CLI (v1)** · **Web UI (v1)** · MCP server (v2)                                          |
| Stack      | TypeScript + Effect · Cloudflare Workers · D1 + Vectorize + Workers AI (+ R2)             |
| Freshness  | incremental sync on a schedule; detect new stars, unstars, changed READMEs                |
| Users      | single user (me). Not multi-tenant.                                                       |

> Corpus count note: the original estimate of 3,277 (2026-09-13) came from a truncated pagination; the canonical live count is **3,448**. Example outputs in docs/04–07 that use 3,277/3,300 are illustrative mock-ups; the real count is stored in D1 after sync.

## 3. Query taxonomy (what must work)

| #   | Query                                                               | Mode that carries it |
| --- | ------------------------------------------------------------------- | -------------------- |
| U1  | `search "effect"` — exact name/identifier                           | lexical              |
| U2  | `search "library to schedule durable background jobs with retries"` | semantic             |
| U3  | `search "tui for git" --lang rust --min-stars 500`                  | hybrid + filters     |
| U4  | `similar <repo>` — find repos like this one                         | vector similarity    |
| U5  | `search "http client" --topic api --lang ts`                        | filters + lexical    |
| U6  | `search "that parser combinator thing"` — vague memory              | semantic             |
| U7  | Agent mid-task (MCP): "find the repo I starred for X"               | any + MCP            |

## 4. Functional requirements

**Search**

- **R1** full-text over name, description, topics, README
- **R2** semantic over README chunks + a per-repo summary vector
- **R3** hybrid ranking by default; each result carries a snippet + matched-text reason
- **R4** filters: language, stars (range), topics, starred date, archived, license — composable with every mode
- **R5** sort: relevance (default) / stars / recently starred / recently pushed
- **R6** `similar` (more-like-this) from a repo's summary vector
- **R7** p95 end-to-end search latency < 500 ms

**Sync**

- **R8** initial full backfill + scheduled incremental sync (nightly cron)
- **R9** idempotent, resumable, checkpointed (no partial corruption on failure)
- **R10** detect unstars (soft delete), renames, README changes; re-embed only changed chunks

**Interfaces**

- **R11** CLI: `sync`, `search`, `similar`, `show`, `stats`; `--json` output for scripting
- **R12** Web UI: search bar, filter facets, results with snippets, repo detail
- **R13** (v2) MCP tools: `search_stars`, `get_star`, `similar_stars`

**Ops**

- **R14** secrets only in Worker secrets (GitHub PAT); no third-party data sharing
- **R15** cost: ≤ $5/mo baseline (Workers Paid) + **< $5/mo marginal**; one-time backfill < $1
- **R16** tracing/logs: Cloudflare observability + Effect spans

## 5. Non-goals (v1)

- Searching inside repo **code** (README + metadata only)
- Multi-user, sharing, teams
- Star management beyond sync (bulk unstar, star-list write-back)
- Mobile app / browser extension
- AI-generated summaries/tags per repo (candidate for v2)

## 6. Fixed decisions (settled 2026-09-13)

- **Effect v4 RC** (`effect@4.0.0-rc.115`); all Effect packages pinned to the same rc, migrate at stable
- **Alchemy v2 beta** (`2.0.0-beta.77`) for infrastructure: typed bindings + Worker init phase
- TypeScript + Effect; Cloudflare Workers runtime; Cloudflare as data home
- D1 (metadata + FTS5 + chunks), Vectorize (vectors), Workers AI (embeddings/rerank), R2 (raw README archive, optional)
- CLI + Web UI first; MCP later

## 7. Open questions

1. Embedding: **bge-m3** chosen ✓ (see [01](01-search-and-index.md) §3.2) — one live batch-schema check remains ⚠️.
2. v2 AI summaries/tags per repo (Workers AI LLM pass): wanted? Enables filters like `--category`.
3. Filter set — is license useful? Do we want `--has-issues`, `--last-pushed` ranges?
4. WebUI hosting: same Worker (static assets) vs separate Cloudflare Pages project.
5. Naming: package scope `@starwatch/*`, CLI binary `starwatch` — good?

**Resolved:** "R service" was a typo for **Cloudflare Workers**. Rerank: included in v1, flag-controlled.

## 8. Success criteria

- "I know I starred something for X" → found in one query, < 30 s from thought to repo URL.
- Zero-maintenance steady state (cron sync runs silently; failures visible in logs).
- Marginal cost stays single-digit $/mo.
