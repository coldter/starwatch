# 19 — Implementation Status

> Status: **built, not yet deployed** · 2026-09-13 · Free-tier MVP of the public service. See docs/08–18 for design.

## What exists

| Layer                | Location                          | Notes                                                                                                                                                                                                                       |
| -------------------- | --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Domain models        | `packages/domain`                 | Schema models + static concept lexicon (15 clusters incl. auth/http/jobs/tui)                                                                                                                                               |
| Search engine (pure) | `packages/core/src/search`        | FTS5 MATCH builder (injection-safe), classifier, expansion, weighted RRF, IDF-gated name boosts, dedupe, snippets, vector codec + kNN                                                                                       |
| Sync planning (pure) | `packages/core/src/sync`          | wire schemas (`Schema.encodeKeys`), star diff, README/embed planning, cooldowns                                                                                                                                             |
| Storage              | `packages/cloudflare/src/storage` | D1 schema + repositories, per-user FTS5 (porter + trigram), R2 vector blobs                                                                                                                                                 |
| GitHub client        | `packages/cloudflare/src/github`  | Public endpoints, ETags/304, README raw-probe chain, GraphQL public Lists                                                                                                                                                   |
| AI embedder          | `packages/cloudflare/src/ai`      | `bge-small-en-v1.5` (384d), batch ≤32, repo-text profile                                                                                                                                                                    |
| Worker API           | `apps/worker/src`                 | HttpApi: health/users/sync (+SSE)/groups/search/repos; per-IP rate limits; Alchemy stack                                                                                                                                    |
| Sync workflows       | `apps/worker/src/sync`            | `StarListingWorkflow` (Tier 0, ETag-aware pages, unstar diff), `StarRefreshWorkflow` (Tier 1, READMEs → embeddings → R2 parts → merged blob)                                                                                |
| CLI                  | `apps/cli`                        | `search/show/sync/status/groups/health`, `--json`/`--plain`/`--explain`, exit codes                                                                                                                                         |
| WebUI                | `apps/webui`                      | Landing + `/u/$login`: default view lists every star (recently starred first, paged) beside the public Lists rail and index stats; URL-state search with filters and sort, groups chips, sync SSE banner, repo drawer, a11y |
| Search-quality lab   | `eval-lab`                        | Local FTS5 + embeddings eval over the real 3,448-star corpus                                                                                                                                                                |
| Design docs          | `docs/00–18`                      | Research, pivots, free-tier feasibility, hardening, ranking, eval                                                                                                                                                           |

**Test counts:** core 127 · cloudflare 76 · cli 43 · worker 48 = **294 passing**; all 6 packages typecheck; WebUI builds (`apps/webui/dist`).

## The docs/18 quality fixes are in the code

1. Expansion runs as its **own weighted RRF leg** (0.6) — never replaces the query.
2. **IDF/specificity-gated name boosts** — the `nuxflare/auth` failure is covered by a regression test.
3. **Quality-aware AND→OR fallback** (`chooseMatchStrategy`, MIN_AND_HITS = 3).
4. **Repo-level vectors** (384d f32, no chunking), brute-force kNN in the Worker; vectors are stored as a merged R2 blob + id sidecar.

## How to run

**Local dev — one command (`alchemy dev`):**

```bash
pnpm install
pnpm dev        # Worker in workerd on :1337 (D1/R2/Queues/Workflows simulators) + WebUI on :5173
```

Prerequisite: Cloudflare credentials (Workers AI and rate-limit bindings run live even in dev) — interactive `alchemy profile create default` + `alchemy profile edit`, or env vars from `apps/worker/.env.example`. Standalone: `pnpm dev:webui` / `pnpm --filter @starwatch/worker run dev`.

**Tests:** `pnpm -r typecheck && pnpm -r test` · **Quality lab:** `pnpm --filter @starwatch/eval-lab run eval`

**Deploy:** `pnpm deploy` (builds the WebUI, then `alchemy deploy`).

**Verified end-to-end against live GitHub (2026-09-13):** synced `coldter` (3,449 repos, ~100 s), then `auth --lang typescript` returned **1. better-auth/better-auth · 2. lucia-auth/lucia · 3. melody-auth · 5. voidauth · 7. logto-io/logto** — the docs/18 acceptance example passes. First-run bugs fixed: first-time sync now fetches the profile itself (previously required a prior lookup), and language/license filters are case-insensitive (`typescript` == `TypeScript`).

## Known gaps (deliberate, ordered)

1. **No deploy has been exercised in this environment** (no credentials). First action after deploy: smoke test `/api/health`, sync a small account, run a search, confirm workflow steps in the dashboard.
2. **Global budgets / Turnstile / degradation ladder** (docs/14 §2–3) not wired yet; only per-IP `ratelimits` bindings are active. Needed before traffic.
3. **Cron re-sync** not scheduled yet (Tier 0 is manual through `POST /sync`).
4. **GitHub Lists import** is best-effort (`Effect.ignore`) and capped by subrequest budgets; large list counts may need pagination batching.
5. **README ref is `HEAD`** for raw probes (the frozen `Repo` schema has no `default_branch`).
6. **WebUI stubs**: no sync cancel/queue position, no per-user SEO/OG tags, README not rendered in-app (links to GitHub).
7. **Eval lab is not yet wired as a regression gate** in CI/local workflow; it remains a standalone lab.
8. **Workflow limits** are pinned to `steps: 1_000` (free cap is 1,024; observed worst cases 107 and 195).
9. **`alchemy dev` requires Cloudflare credentials** — D1/R2/Queues/Workflows are emulated locally, but Workers AI and the rate-limit bindings run live.

## Next steps

1. Deploy (plan → deploy) and smoke test with a real account.
2. Wire budgets/Turnstile per docs/14 and a nightly cron for hot users.
3. Connect `eval-lab` to the deployed API as the regression gate.
4. Iterate ranking constants (all exported) against the golden set.
