# starwatch

## *Toy Project _trying out effect-ts with cloudflare platform along side Pi agent with open weight models_*

Public search for GitHub stars. Enter any GitHub username and get full-text search over that user's public starred repositories — no login required. Semantic (embedding) search is an opt-in extra, off by default: `STARWATCH_SEMANTIC_SEARCH=1`.

**Stack:** TypeScript · [Effect](https://effect.website) · Cloudflare Workers (Alchemy) · D1 + R2 (Workers AI is declared for the deployment, but only called when semantic search is on)

## How it works

1. **Enter a username** — the public star listing is fetched in seconds; metadata + keyword search is available immediately.
2. **Eager-lazy indexing** — READMEs are fetched in the background (and embedded too, when semantic search is on); results improve progressively while you search.
3. **Search** — D1 FTS5 keyword search, filtered by language, stars, topics, dates, archived state and **collections imported from the user's public GitHub Lists**. With `STARWATCH_SEMANTIC_SEARCH=1`, `bge-small-en-v1.5` embeddings are ranked alongside it with weighted RRF.

## Repository layout

| Path                  | Contents                                                                                |
| --------------------- | --------------------------------------------------------------------------------------- |
| `apps/worker`         | Worker API (HttpApi), sync workflows, Alchemy stack                                     |
| `apps/webui`          | React 19 SPA — Vite, Tailwind v4, vendored beUI motion components                       |
| `apps/cli`            | Terminal client: `search`, `show`, `sync`, `status`, `groups`, `health`                 |
| `packages/core`       | Pure search and sync planning: FTS5 builder, expansion, RRF, ranking, star diff         |
| `packages/cloudflare` | D1/R2 storage, GitHub client, Workers AI embedder (on deployments with semantic search) |
| `packages/domain`     | Schema models and the static concept lexicon                                            |
| `eval-lab`            | Local search-quality lab over a real 3,448-star corpus                                  |

## Development

### Local dev (`alchemy dev`)

One command runs the whole stack: the Worker in **workerd** (D1/R2/Queues/Workflows simulators, hot reload, API on `:1337`) plus the WebUI Vite dev server (`:5173`, proxying `/api` to the Worker).

Prerequisite — Cloudflare credentials, because the bindings (including Workers AI and the rate limiters) are declared in the Worker even in dev. Semantic search itself is off unless `STARWATCH_SEMANTIC_SEARCH=1`:

```bash
# interactive (recommended)
pnpm --filter @starwatch/worker exec alchemy profile create default
pnpm --filter @starwatch/worker exec alchemy profile edit

# or env-based
cp apps/worker/.env.example apps/worker/.env   # set CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN + GITHUB_TOKEN
```

`GITHUB_TOKEN` is a fine-grained PAT with public read only. It is strongly
recommended everywhere and **required for collections**: GitHub's GraphQL API
(the only one exposing the public Lists we import) refuses anonymous requests,
and a token lifts the REST quota from 60/hour to 5,000/hour.

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

### Tests & search-quality lab

```bash
pnpm -r typecheck && pnpm -r test                # all workspace packages
pnpm --filter @starwatch/eval-lab run eval       # measured quality lab (real corpus)
```

### Deploy to Cloudflare

```bash
pnpm run deploy   # builds the WebUI, then runs alchemy deploy
```

Credentials + `GITHUB_TOKEN` from the local-dev setup apply here too. Semantic search is off unless `apps/worker/.env` sets `STARWATCH_SEMANTIC_SEARCH=1` (see [docs/19](docs/19-implementation-status.md#semantic-search-is-optional)).

**Status:** MVP implemented — worker API + Tier-0/Tier-1 Workflows, CLI, WebUI, `alchemy dev` loop. See [docs/19-implementation-status.md](docs/19-implementation-status.md) for test counts, verification results and known gaps.

**Version pin (important):** Effect `4.0.0-rc.112` + Alchemy `2.0.0-beta.77` — newer Effect RCs (≥ rc.113) break Alchemy beta.77. See [docs/02-stack-and-pipeline.md](docs/02-stack-and-pipeline.md) §1.
