# 02 — Stack (Effect + Cloudflare) & Ingestion Pipeline

> ⚠️ **Pivot notice (2026-09-13):** this document predates the public multi-tenant pivot. See [08-public-service-ux.md](08-public-service-ux.md)–[12-hardening.md](12-hardening.md) for the current design and [11-assumptions-delta.md](11-assumptions-delta.md) for exactly what changed.

> Status: **draft for discussion** · 2026-09-13 · Versions verified against the npm registry on this date.

## 1. Version landscape (verified via `npm view`, 2026-09-13)

| Package                 | `latest`         | `rc`                                               |
| ----------------------- | ---------------- | -------------------------------------------------- |
| `effect`                | 3.22.2           | **4.0.0-rc.112** (pinned — see compatibility note) |
| `@effect/sql-d1`        | 0.50.0           | 4.0.0-rc.112                                       |
| `@effect/sql-sqlite-do` | 0.30.0           | 4.0.0-rc.112                                       |
| `@effect/platform`      | 0.97.2 (v3 only) | — (folded into core)                               |
| `@effect/cli`           | 0.77.1 (v3 only) | — (`effect/unstable/cli`)                          |
| `@effect/vitest`        | 0.30.0           | 4.0.0-rc.115                                       |
| `alchemy`               | 2.0.0-beta.77    | —                                                  |
| `effect-cf`             | 0.41.1           | —                                                  |
| `wrangler`              | 4.131.1          | —                                                  |

> ⚠️ **Compatibility pin (verified empirically 2026-09-13):** `alchemy@2.0.0-beta.77` crashes on `effect` ≥ rc.113 — `TypeError: Config.string is not a function` (rc.113 renamed Config constructors to PascalCase; Alchemy beta.77 predates it). Its CLI won't even print `--help`. **Working combination: `effect` + `@effect/*` = `4.0.0-rc.112`, `alchemy@2.0.0-beta.77`, TypeScript 7.0.2.** Bump both together when Alchemy ships a compatible beta.

**Decision (settled): Effect v4 RC.**

- v4 (RC since Aug 2026) rewrote the runtime, consolidated `@effect/*` packages into `effect` (`effect/unstable/*`), and cut the minimal Effect+Stream+Schema bundle from ~70 kB to ~20 kB. The 2026 ecosystem (Alchemy v2, effect-cf, current templates) targets v4.
- All Effect packages pinned to the exact same rc (`4.0.0-rc.112`, the newest Alchemy-compatible RC); migrate when stable lands. Personal project → the risk is acceptable.

## 2. Cloudflare integrations

| CF product                                | Effect support                                                                 | Plan                                                                      |
| ----------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| D1                                        | ✅ official `@effect/sql-d1` (rc) — `batch`, **no transactions**               | primary SQL layer                                                         |
| Durable Object SQLite                     | ✅ official `@effect/sql-sqlite-do` (rc)                                       | only if we use DOs                                                        |
| R2 / KV / Queues / Vectorize / Workers AI | ❌ no first-party packages                                                     | thin `Effect.tryPromise` wrappers; optionally `effect-cf` (98★ community) |
| HTTP routing                              | ✅ `effect/unstable/http` + `httpapi`                                          | HttpApi for WebUI, RPC for CLI                                            |
| MCP                                       | `effect/unstable/ai` McpServer (streamable HTTP); serverless mode stability ⚠️ | v2                                                                        |

## 3. Workers runtime gotchas (apply from day 1)

1. **Module-scope layer build + pre-warm.** Build the app layer once per isolate; call the handler once at startup to avoid the known "aborted first request wedges the isolate" bug (Effect #6319; fix PR still open ⚠️).
2. **`Error.stackTraceLimit = 0`** at the top of the Worker entry — `Effect.fn` definition sites capture stacks; on Workers this can blow the 1 s startup CPU budget (Effect #8038, fixed in v4).
3. **`nodejs_compat` is implicit** for compatibility dates ≥ 2026-08-04. Prefer `import { env } from "cloudflare:workers"` for bindings.
4. **D1 has no transactions** — use `db.batch()` for atomic multi-statement writes.
5. **Subrequests:** the default 10,000/invocation can be exceeded by a full backfill → raise in wrangler config.
6. **6 simultaneous outbound connections** max → cap GitHub fetch concurrency at 5.
7. **Workflow `step.do` results ≤ 1 MiB** — write READMEs to R2/D1, return keys.
8. **Bundle discipline:** subpath imports, never import `@effect/platform-node` in the Worker, measure startup (`wrangler check startup`).

## 4. IaC choice (settled)

**Alchemy v2** (pinned exact `2.0.0-beta.77`). Effect-native IaC: typed bindings, `Cloudflare.Worker` init phase (structurally solves gotcha #1), deploys D1/R2/Vectorize/Queues, PR stages. Risk accepted: beta, fast-moving — exact pin, expect occasional churn (see the effect compatibility pin in §1). Wrangler still used underneath for local dev and emergency debugging.

## 5. Ingestion pipeline

**Auth:** fine-grained PAT, User permission **"Starring: Read"** (+ repo access if private stars should be indexed; verify once ⚠️). Stored as a Worker secret.

**List / diff (scheduled):**

- `GET /user/starred?per_page=100&sort=created&direction=asc` with `Accept: application/vnd.github.star+json` → 35 requests for ~3,448 stars.
- Store **ETag per page** in D1; unchanged pages return 304 = **free** (no rate-limit cost).
- Diff starred IDs vs DB → new / unstarred / renamed.

**README fetch (only when needed):**

- `GET /repos/{o}/{r}/readme` (raw body) with `If-None-Match`; 304 → skip; 404 → mark missing, recheck ≤ monthly.
- Concurrency ≤ 5 (respects the 6-connection cap and GitHub secondary limits).
- Budget: 33 list + ~3.3k READMEs ≈ **66% of one 5,000 req/hr window**.

**Pipeline shape:**

```
Cron (nightly)
  └─► Workflow "star-sync" (durable, checkpointed in D1)
        ├─ step: list pages → upsert metadata → diff
        ├─ step: worklist = new + pushed_at-changed + missing-retry
        ├─ steps: batches of 25 repos, ≤5 concurrent
        │     ├─ fetch README (ETag) → R2 put + D1 row
        │     ├─ chunk (1.2k chars / 15% overlap) → hash chunks
        │     ├─ embed changed chunks (≤100/req, bge-m3) → Workers AI
        │     ├─ Vectorize upsert (≤1,000/batch) + deleteByIds (removed chunks)
        │     └─ D1 batch: repo row + chunks + sync state
        └─ finish: run stats → D1
```

- Unstar → soft delete (`is_starred=0`) + `deleteByIds` vectors; keep rows ~90 days for undo/audit.
- Incremental embedding, cheapest layer first: page ETag → README ETag → per-chunk hash. Typical edit touches 1–2 chunks.
- Idempotent everywhere: keyed by `repo.id`; vector IDs `{repo_id}:{chunk_idx}` with upsert semantics.

**Sizing (~3,450 repos, avg 6 KB README; scales linearly):**

| Metric              | Value                                                                        |
| ------------------- | ---------------------------------------------------------------------------- |
| Chunks              | ~19.7k (+ 3.3k summary vectors) ≈ **23k vectors**                            |
| Stored dims (1024d) | ~23.5M                                                                       |
| One-time embedding  | ~5.7M tokens → **$0.07** (bge-m3) / $0.38 (bge-base)                         |
| Backfill wall-clock | **15–40 min** (GitHub-bound @ concurrency 5); worst case 1 rate-limit window |
| Steady state        | ~0.6M tokens/mo → **$0.007/mo** + ~40 workflow steps/mo                      |
| Storage             | R2 ~26 MB · D1 ~15–60 MB (free allowances)                                   |

**Queue vs Workflow-only:** start Workflow-only (one moving part). Move fan-out to Queues only if the star count exceeds ~10k or per-repo pacing is needed.

## 6. Proposed monorepo layout

```
starwatch/
├── packages/
│   ├── domain/       # Schema models (Repo, Chunk, SearchQuery, Filters), branded ids, errors
│   ├── contracts/    # HttpApi + RpcGroup definitions shared by worker/cli/webui
│   ├── core/         # services: SearchService, RepoRepository, SyncService (generic over SqlClient)
│   └── cloudflare/   # binding layers: D1, R2, Vectorize, Workers AI, config from env
├── apps/
│   ├── worker/       # entry + handlers + crons + workflows; wrangler.jsonc
│   ├── cli/          # Effect CLI, talks RPC
│   └── webui/        # Vite + React; HttpApiClient
└── docs/
```

Dependency direction: `webui | cli → contracts → domain`; `worker → core + contracts + domain`; `cloudflare` imported only by the worker.

## 7. Observability

- Cloudflare Workers observability: traces + logs to Grafana/Axiom; `persist: false` unless dashboard storage is wanted.
- Effect spans via `effect/unstable/observability/Otlp` (in core for v4); flush with `ctx.waitUntil`.
- CLI: pretty local logs; `--json` for machines.

## 8. Open questions

1. Backfill trigger: run full sync automatically on first deploy, or manual first run?
2. Local dev for D1: `wrangler dev --remote` vs local D1 for iteration.
3. Alchemy state store for a solo project: local file (default) vs `CloudflareStateStore` — start local, decide after first deploy.
