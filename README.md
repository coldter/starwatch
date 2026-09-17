# starwatch

Public search for GitHub stars. Enter any GitHub username and get full-text + semantic search over that user's public starred repositories — no login required.

**Stack:** TypeScript · [Effect](https://effect.website) · Cloudflare Workers (Alchemy) · D1 + Workers AI + R2

## How it works

1. **Enter a username** — the public star listing is fetched in seconds; metadata + keyword search is available immediately.
2. **Eager-lazy indexing** — READMEs are fetched and embedded in the background; semantic results improve progressively while you search.
3. **Search** — D1 FTS5 keyword search plus `bge-small-en-v1.5` embeddings ranked with weighted RRF, filtered by language, stars, topics, dates, archived state and **collections imported from the user's public GitHub Lists**.

## Repository layout

| Path                  | Contents                                                                        |
| --------------------- | ------------------------------------------------------------------------------- |
| `apps/worker`         | Worker API (HttpApi), sync workflows, Alchemy stack                             |
| `apps/webui`          | React 19 SPA — Vite, Tailwind v4, vendored beUI motion components               |
| `apps/cli`            | Terminal client: `search`, `show`, `sync`, `status`, `groups`, `health`         |
| `packages/core`       | Pure search and sync planning: FTS5 builder, expansion, RRF, ranking, star diff |
| `packages/cloudflare` | D1/R2 storage, GitHub client, Workers AI embedder                               |
| `packages/domain`     | Schema models and the static concept lexicon                                    |
| `eval-lab`            | Local search-quality lab over a real 3,448-star corpus                          |

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

### CLI

The terminal client speaks to the same API:

```bash
pnpm --filter @starwatch/cli run dev -- search "tui for git" -u sindresorhus
pnpm --filter @starwatch/cli run dev -- status sindresorhus
pnpm --filter @starwatch/cli run dev -- show sindresorhus/lazygit
```

`-u, --user` (or `STARWATCH_USER`) selects whose stars to search; `--api-url` (or `STARWATCH_API_URL`) points at a deployed Worker. `search` takes filters (`--mode`, `--lang`, `--topic`, `--min-stars`, `--license`, `--starred-after`, …) plus `--explain`, `--plain` and `--json`.

### WebUI

The WebUI is a Vite + React 19 SPA styled with **Tailwind v4** and composed
from **[beUI](https://beui.dev)** motion components, vendored through the
shadcn registry into `apps/webui/src/components/{motion,agents}`. Design tokens
(semantic colors, radii, type) live in `apps/webui/src/styles.css`; the
component contract, slice ownership and conventions are documented in
[apps/webui/docs/ui-contract.md](apps/webui/docs/ui-contract.md).

```bash
npx shadcn@latest add @beui/<slug>   # from apps/webui — add or update a component
```

Vendored beUI sources are excluded from oxlint/oxfmt so registry updates stay
byte-identical; app code uses the semantic tokens (`bg-card`,
`text-muted-foreground`, `text-star`, …) rather than raw palette values.

The palette is the **[Pierre theme](https://github.com/pierrecomputer/theme)**
(MIT), vibrant variants: neutral near-black/white surfaces with Display-P3
accents — the P3 values in dark, their deeper sRGB steps in light where a hue
must also carry text, and the electric P3 blue as `--ring` in both.

### Tests & search-quality lab

```bash
pnpm -r typecheck && pnpm -r test                # all workspace packages
pnpm --filter @starwatch/eval-lab run eval       # measured quality lab (real corpus)
```

### Deploy to Cloudflare

```bash
pnpm deploy       # builds the WebUI, then runs alchemy deploy
```

Credentials + `GITHUB_TOKEN` from the local-dev setup apply here too.

**Status:** MVP implemented — worker API + Tier-0/Tier-1 Workflows, CLI, WebUI, `alchemy dev` loop. See [docs/19-implementation-status.md](docs/19-implementation-status.md) for test counts, verification results and known gaps.

**Version pin (important):** Effect `4.0.0-rc.112` + Alchemy `2.0.0-beta.77` — newer Effect RCs (≥ rc.113) break Alchemy beta.77. See [docs/02-stack-and-pipeline.md](docs/02-stack-and-pipeline.md) §1.
