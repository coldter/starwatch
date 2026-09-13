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

```bash
pnpm install
pnpm -r typecheck && pnpm -r test                # 6 packages · 226 tests
pnpm --filter @starwatch/webui build             # dist/ is served by the worker
pnpm --filter @starwatch/worker dev              # Alchemy dev (needs Cloudflare auth)
pnpm --filter @starwatch/cli dev -- search effect -u coldter
pnpm plan && pnpm deploy                         # Alchemy plan/deploy (needs credentials)
pnpm --filter @starwatch/eval-lab run eval       # search-quality regression lab
```

**Status:** MVP implemented — worker API + Tier-0/Tier-1 Workflows, CLI, and WebUI, 226 unit tests green. Not yet deployed (needs Cloudflare credentials); global abuse budgets and Turnstile are follow-ups. See [docs/19-implementation-status.md](docs/19-implementation-status.md).

**Version pin (important):** Effect `4.0.0-rc.112` + Alchemy `2.0.0-beta.77` — newer Effect RCs (≥ rc.113) break Alchemy beta.77. See [docs/02-stack-and-pipeline.md](docs/02-stack-and-pipeline.md) §1.
