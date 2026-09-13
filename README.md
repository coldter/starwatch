# starwatch

Public search for GitHub stars. Enter any GitHub username and get full-text + semantic search over that user's public starred repositories — no login required.

**Stack:** TypeScript · [Effect](https://effect.website) · Cloudflare Workers (Alchemy) · D1 + Vectorize + Workers AI + R2

## How it works

1. **Enter a username** — the public star listing is fetched in seconds; metadata + keyword search is available immediately.
2. **Eager-lazy indexing** — READMEs are fetched and embedded in the background; semantic results improve progressively while you search.
3. **Search** — lexical (FTS5) + semantic (bge-m3) + hybrid RRF + rerank, with filters: language, stars, topics, dates, archived, and **groups imported from the user's public GitHub Lists**.

## Docs

**Current design (public multi-tenant service):**
- [docs/08-public-service-ux.md](docs/08-public-service-ux.md) — first-use flow, eager-lazy sync UX, username-context search, groups context
- [docs/09-public-data-and-limits.md](docs/09-public-data-and-limits.md) — GitHub public-data strategy + rate-limit/capacity dossier (live-verified)
- [docs/10-multitenant-architecture.md](docs/10-multitenant-architecture.md) — shared corpus, Vectorize namespaces, D1 sharding, costs, eviction
- [docs/11-assumptions-delta.md](docs/11-assumptions-delta.md) — what the pivot changed in docs 00–07
- [docs/12-hardening.md](docs/12-hardening.md) — abuse controls, quotas, cost guardrails, runbooks
- [docs/13-free-tier-feasibility.md](docs/13-free-tier-feasibility.md) — zero-spend envelope: exact free limits, breaking points, first paid upgrades
- [docs/14-abuse-protection.md](docs/14-abuse-protection.md) — $0 abuse defense: budgets, DO governors, degradation ladder
- [docs/15-free-semantic-search.md](docs/15-free-semantic-search.md) — free semantic search: repo-level embeddings + in-Worker kNN (benchmarked)
- [docs/16-search-quality-teardown.md](docs/16-search-quality-teardown.md) — teardown of openalternative.co / GitHub / npm search + patterns to adopt
- [docs/17-query-understanding-ranking.md](docs/17-query-understanding-ranking.md) — query expansion, ranking design, worked `auth`+TS walkthrough
- [docs/18-search-quality-eval.md](docs/18-search-quality-eval.md) — measured results on the real 3,448-star corpus + required fixes
- [docs/19-implementation-status.md](docs/19-implementation-status.md) — what's built, test counts, how to deploy, known gaps

**Original design (pre-pivot; parts superseded — see doc 11):**
- [00-requirements.md](docs/00-requirements.md) · [01-search-and-index.md](docs/01-search-and-index.md) · [02-stack-and-pipeline.md](docs/02-stack-and-pipeline.md)
- [03-sync-and-limits.md](docs/03-sync-and-limits.md) · [04-groups.md](docs/04-groups.md) · [05-cli.md](docs/05-cli.md) · [06-webui.md](docs/06-webui.md) · [07-search-contract.md](docs/07-search-contract.md)

## Development

### Local dev (`alchemy dev`)

One command runs the whole stack: the Worker in **workerd** (D1/R2/Queues/Workflows simulators, hot reload, API on `:1337`) plus the WebUI Vite dev server (`:5173`, proxying `/api` to the Worker).

Prerequisite — Cloudflare credentials, because Workers AI and the rate-limit bindings run live even in dev:

```bash
# interactive (recommended)
pnpm --filter @starwatch/worker exec alchemy profile create default
pnpm --filter @starwatch/worker exec alchemy profile edit

# or env-based
cp apps/worker/.env.example apps/worker/.env   # set CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN (+ optional GITHUB_TOKEN)
```

```bash
pnpm install
pnpm dev          # alchemy dev: Worker (:1337, workerd) + WebUI (:5173, Vite)
```

Standalone variants: `pnpm dev:webui` (UI only) · `pnpm --filter @starwatch/worker run dev` (API only).

### Tests & search-quality lab

```bash
pnpm -r typecheck && pnpm -r test                # 6 packages · 226 tests
pnpm --filter @starwatch/eval-lab run eval       # measured quality lab (real corpus)
```

### Deploy to Cloudflare

```bash
pnpm deploy       # builds the WebUI, then runs alchemy deploy
```

Credentials + `GITHUB_TOKEN` from the local-dev setup apply here too.

**Status:** MVP implemented — worker API + Tier-0/Tier-1 Workflows, CLI, WebUI, `alchemy dev` loop, 226 unit tests green. See [docs/19-implementation-status.md](docs/19-implementation-status.md).

**Version pin (important):** Effect `4.0.0-rc.112` + Alchemy `2.0.0-beta.77` — newer Effect RCs (≥ rc.113) break Alchemy beta.77. See [docs/02-stack-and-pipeline.md](docs/02-stack-and-pipeline.md) §1.
