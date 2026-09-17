# 06 — WebUI interaction spec

> ⚠️ **Pivot notice (2026-09-13):** this document predates the public multi-tenant pivot. See [08-public-service-ux.md](08-public-service-ux.md)–[12-hardening.md](12-hardening.md) for the current design and [11-assumptions-delta.md](11-assumptions-delta.md) for exactly what changed.

> Status: **draft for discussion** · 2026-09-13 · Capabilities verified against npm and the **installed** `effect@4.0.0-rc.112`, `alchemy@2.0.0-beta.77` sources, and live Cloudflare docs on this date; ⚠️ marks low-confidence items to re-check at implementation time.
> Depends on: [00-requirements.md](00-requirements.md) (R12) · [01-search-and-index.md](01-search-and-index.md) (modes, filters, snippets) · [02-stack-and-pipeline.md](02-stack-and-pipeline.md) (monorepo, Workers gotchas).

## 1. Recommendation at a glance

| Area               | Decision                                                                                           |
| ------------------ | -------------------------------------------------------------------------------------------------- |
| App shape          | **SPA** (Vite + React 19), client-side routing; served as Worker static assets                     |
| Serving            | **Same API Worker** via the `assets` prop — _not_ Cloudflare Pages, _not_ a second Worker          |
| Router             | TanStack Router (typed search params) — low-stakes; React Router 8 is a fine fallback              |
| Data fetching      | **`@effect/atom-react` + `AtomHttpApi`** (`effect/unstable/reactivity`), not TanStack Query        |
| Live sync progress | **SSE** via `HttpApiSchema.StreamSse` (typed Effect `Stream` on both ends); polling as fallback    |
| Auth               | **Cloudflare Access** (GitHub IdP), wired through Alchemy's `access` prop — no app-level token     |
| Avatars            | GitHub CDN directly + `github.com/identicons/{login}.png` fallback; no proxy in v1                 |
| Results            | **Paginated** (25/page), not infinite scroll; all search state in the URL                          |
| Groups             | docs/04 model: local-first manual groups + smart groups (saved searches); flat, slug-keyed         |
| Group API          | docs/04 §6.1 routes, mounted under `/api/*` (e.g. `GET /api/groups`) to avoid SPA-route collisions |

`apps/webui/` is a pure client package; it imports only `packages/contracts` (HttpApi spec + schemas) and `packages/domain` types, never Worker code (docs/02 §6).

## 2. Information architecture & route map

| Route                | Screens        | Purpose                                                           |
| -------------------- | -------------- | ----------------------------------------------------------------- |
| `/`                  | Search         | Main query surface with filter rail and results (default landing) |
| `/repo/:owner/:name` | Repo detail    | Metadata, README, groups, similar repos                           |
| `/groups`            | Groups manager | Create / edit / reorder / delete groups                           |
| `/groups/:slug`      | Group context  | Search pre-scoped to a group; smart groups show their rule        |
| `/sync`              | Sync status    | Live progress, history, errors, rate-limit state                  |
| `/settings`          | Settings       | Auth, index, appearance, danger zone; deep-linkable tabs `?tab=`  |

**SPA, not MPA.** One shell, instant mode/filter changes, and URL-addressable state; there is no server rendering or SEO need (single user, behind Access). Static assets make this a single deploy unit with the API already.

```
AppShell (header: logo · search · sync chip · theme · ⚙)
├── /            SearchPage      ── FilterRail + ResultList
├── /repo/:o/:n  RepoDetailPage  ── Metadata + Readme + Groups + Similar
├── /groups      GroupsPage      ── GroupList (reorder) + editor dialogs
├── /groups/:slug GroupSearchPage ── SearchPage with a locked group filter
├── /sync        SyncPage        ── Progress + History + RateLimit
└── /settings    SettingsPage    ── tabs: index | sync | appearance | danger
        404 → "Not found" card with links home; no route ever renders blank
```

## 3. Search page (core UX)

```
┌────────────────────────────────────────────────────────────────────────────┐
│ starwatch [  tui for git                        ⌘K ]   ● synced 2h ago  ☾ ⚙ │
├───────────────┬────────────────────────────────────────────────────────────┤
│ FILTERS  (live)  [auto][keyword][semantic][hybrid]      sort: relevance ▾  │
│ Language      │  48 results · 47 ms · hybrid                               │
│  ● TypeScript │ ┌────────────────────────────────────────────────────────┐ │
│  ● Rust  318  │ │ ▸ ratatui/ratatui   ● Rust   ★ 12.4k   pushed 3d ago   │ │
│  ● Go    201  │ │   Rust library for building terminal UIs…              │ │
│  ● Python 96  │ │   "a [tui] for [git] with side-by-side diffs"  #cli    │ │
│ Stars         │ │   [keyword] [semantic]  similar ↗  open ↗  ★           │ │
│  ▁▃▅▇▅▃▁      │ ├────────────────────────────────────────────────────────┤ │
│  [100───5000] │ │ ▸ extrawurst/gitui  ● Rust  ★ 18.2k  pushed 1w ago     │ │
│ Groups        │ └────────────────────────────────────────────────────────┘ │
│  [#infra ×]   │                                                            │
│  [#reading ×] │   ◀  1 / 5  ▶       25 per page                           │
│ Topics        │                                                            │
│  [ rust ▾ ]   │   Empty query → Recent stars + top groups + stats card     │
│ Starred       │   No results  → keep filters, suggest mode/filter changes  │
│  [2024-01-01] │   Error       → message + Retry + "search keyword-only"     │
│ ☐ archived    │                                                            │
└───────────────┴────────────────────────────────────────────────────────────┘
```

- **Search bar**: always visible and focused on `/`; `Cmd/Ctrl+K` focuses it from anywhere. Debounce 200 ms, cancel in-flight query on new keystroke (AbortController via Effect interruption). Show a subtle spinner in the bar while querying.
- **Mode toggle**: `auto` (default — server's identifier-routing heuristic from docs/01 §7.6) / `keyword` / `semantic` / `hybrid`. Always expose it: when `auto` picked a mode, label the result meta (`hybrid → keyword (identifier)`) so the choice is explainable.
- **Filter rail** (left, live facet counts computed server-side for the current query with each facet's own selection removed):
  - Language: top-N chips (N=8) + "more…" popover; language dot uses bundled Linguist colors.
  - Stars: histogram (log buckets) + dual-thumb range slider + numeric inputs; URL encodes `min-max`.
  - Groups: chips (emoji + color), multi-select; **repeated groups = OR (union)** with a `group-all` (AND) toggle when 2+ are selected — mirrors docs/04 §5.2; smart groups selectable too.
  - Topics: tag input with autocomplete from a `topics` extract (typeahead via `GET /api/suggest/topics`).
  - Starred date: after/before range, presets (This year / 30 days / custom).
  - Archived: tri-state toggle — hide (default) / include / only.
  - Each active filter renders as a removable chip above the results; "Clear all" and **"Save search as group"** (persists the current `{q, filters}` as a smart group — docs/04 §3.3).
- **Result cards**: `owner/name` (link), description (2 lines), language dot + name, stars (formatted), `pushed_at` relative, group chips (emoji + color, docs/04 §5.5), snippet (~200 chars) with `<mark>` highlights, and a **matched-by badge** rendered from the `matchedBy[]` array (`keyword` / `semantic` / both — docs/05 §4.4). Actions: open detail, `similar ↗`, open on GitHub, add-to-group.
- **Use paged results.** Result sets are small (hybrid legs cap at top-50 each; ~100 candidates), and pages preserve the URL, Back behavior, and `j/k` navigation. A `load more` button is acceptable, but classic `◀ 1/5 ▶` is the recommendation.
- **URL state = the source of truth** (validated with the contracts schemas on every route change):

  ```
  /?q=durable+jobs&mode=hybrid&lang=TypeScript&lang=Rust&group=infra
   &topic=queue&stars=100-5000&starred=2024-01-01..2026-05-01
   &archived=1&sort=stars&page=2
  ```

  Defaults (`mode=auto`, `sort=relevance`, `page=1`, no filters) are omitted. Every search is bookmarkable and shareable — this is the single largest UX win of the URL-first design.

- **Keyboard shortcuts** (shown in a `?` help overlay):

  | Key                   | Action                                                     |
  | --------------------- | ---------------------------------------------------------- |
  | `/` or `Cmd/Ctrl+K`   | Focus search                                               |
  | `j` / `k` / `↑` / `↓` | Move selection between result cards                        |
  | `Enter`               | Open selected repo detail                                  |
  | `o`                   | Open selected repo on github.com                           |
  | `g`                   | Jump to groups manager (`g s` sync, `g ,` settings)        |
  | `s`                   | Open `similar` for selected repo                           |
  | `Esc`                 | Blur search → clear draft → close popovers (in that order) |

- **States**: (1) skeleton cards while loading (never a blank flash); (2) _empty query_ — recent stars, top groups, corpus stats (`3,277 repos · 23k chunks · last sync 2h`); (3) _no results_ — keep filters visible, offer "switch to semantic", "remove language filter" (the single most likely culprit), and a link to GitHub search; (4) _error_ — human message, `Retry`, and "search keyword-only" recovery when the semantic leg is down; (5) _degraded_ — a slim banner "vector leg unavailable — showing keyword results" without hiding results.

## 4. Repo detail (`/repo/:owner/:name`)

```
┌────────────────────────────────────────────────────────────────────────────┐
│ ← back        rails/rails  ● Ruby  [archived]                 open on GitHub │
│ ────────────────────────────────────────────────────────────────────────── │
│ ★ 57.2k · forks 22.1k · MIT · pushed 2d ago · starred 2021-03-04 · 89 MB   │
│ topics: [ruby][framework][web]            Groups: [#infra][#reading] + Edit │
│ clone: [ git@github.com:rails/rails.git  ⧉ ]  [https ▾]   last indexed 2h ago│
│ ────────────────────────────────────────────────────────────────────────── │
│ README (sanitized markdown)                    SIMILAR REPOS (summary vector)│
│ ┌───────────────────────────────┐              ┌────────────────────────────┐│
│ │ # Ruby on Rails               │              │ ▸ sinatra/sinatra  ★ 12.6k ││
│ │ … rendered GFM, code blocks … │              │ ▸ hanami/hanami    ★ 6.1k  ││
│ │ … tables, images (opt-in) …   │              └────────────────────────────┘│
│ └───────────────────────────────┘              ┌────────────────────────────┐│
│                                                │ ▸ hotwired/turbo   ★ 5.2k  ││
│                                                └────────────────────────────┘│
└────────────────────────────────────────────────────────────────────────────┘
```

- **README rendering must be treated as untrusted input.** Render with `react-markdown` + `remark-gfm` + `rehype-sanitize` (GitHub schema), raw HTML disabled (`skipHtml`) — never `dangerouslySetInnerHTML` with stored README bytes. Rewrite relative links to `https://github.com/{owner}/{repo}/blob/{default_branch}/…` and images to `raw.githubusercontent.com`; external links get `rel="noopener noreferrer"`; remote images are **opt-in per page** with `referrerPolicy="no-referrer"` (README badges are third-party trackers). GitHub's own `Accept: application/vnd.github.html+json` output is already sanitized, but it costs an extra API call and won't render our archived copy — not used.
- Metadata block: stars, forks, license, topics, default branch, `created_at`, `pushed_at`, `starred_at`, size, archived. Everything links to the GitHub page it came from.
- **Group membership editor**: chips + "Edit" popover listing groups with checkboxes, plus "create group from this repo" and a write to the docs/04 §6.1 bulk membership routes (`POST`/`DELETE /api/groups/:slug/members`, accepts `full_name`); the mutation's `reactivityKeys` refreshes the detail, group counts, and any open search results.
- **`similar` section**: top 10 by summary-vector similarity, from the same endpoint the CLI uses (`similar <repo>`); each row links to its detail page.
- **Copy clone URL**: HTTPS/SSH toggle, copy button with toast; `git clone` convenience.
- **Unstar warning**: when `is_starred = 0`, a yellow banner — "No longer starred on GitHub (removed 3 d ago). Kept for 90 days, until 2026-12-12." — plus "Remove now". Tapping it doesn't unstar anything on GitHub; starwatch never writes to GitHub in v1.

## 5. Groups manager (`/groups`)

```
┌────────────────────────────────────────────────────────────────────────────┐
│ Groups                                             [+ New group]           │
├────────────────────────────────────────────────────────────────────────────┤
│ ⠿ #infra     ● blue   manual   42 repos   ✎ ✕     ← drag / Alt+↑↓ to reorder│
│ ⠿ #reading   ● amber  manual   17 repos   ✎ ✕                             │
│ ⠿ #rust-ts   ● slate  smart    "lang=rust AND stars>500 AND unarchived"     │
│ ⠿ #later     ● green  manual    0 repos   "Assign repos from search"        │
├────────────────────────────────────────────────────────────────────────────┤
│ Smart rules (form, AND-composed):                                          │
│  Language [Rust ▾]  Stars [500 – ∞]  Topic [ contains "http" ]             │
│  Starred after [2024-01-01]  ☐ include archived        [Save] [Cancel]      │
└────────────────────────────────────────────────────────────────────────────┘
```

- **Model note:** the group model is specified in [04-groups.md](04-groups.md) — manual membership + smart `rules_json`, flat, slug-keyed, local-first; this spec only consumes it. The API mounts docs/04 §6.1 routes under `/api/*` (e.g. `GET /api/groups`) so the client route `/groups` and the API route never collide.
- Create/rename/delete (delete confirms with repo count; slug stays stable on rename), color palette token/hex + emoji icon (docs/04 §3.4), **reorder by drag-and-drop with a keyboard alternative** (`Alt+↑/↓` moves the focused row); persist order via one `PUT /api/groups/reorder`.
- **Assignment**: multi-select mode in search results (`x` key or checkbox) reveals a bulk bar with "Add to group…" / "Remove from group…" for large-scale cleanup; use the repo-detail editor for a single repo. Drag-from-results is a stretch goal; the multi-select path must stay keyboard-complete.
- **Smart-rule editor**: form-based AND builder whose fields/operators are exactly the search-filter vocabulary, serialized to the versioned `rules_json` of docs/04 §4.2 (`match: "all"` only in v1); "Save search as group" in the search bar reuses the same serializer with the current `q`.
- `/groups/:slug` opens the search page with a locked group filter chip; smart groups additionally render their rule as editable chips that can be "unlocked" into ad-hoc filters. The rail lists the top groups with counts (`docs/04 §6.3`); the full manager lives at `/groups`.
- Empty states: no groups yet → explain manual vs smart with two example recipes; empty manual group → "Find repos" CTA that pre-fills the assign flow.

## 6. Sync UI

Banner/chip in the header (always visible), expanded page at `/sync`:

```
● synced 2h ago                                                   (current state)
◐ syncing · fetching READMEs  ▓▓▓▓▓░░░  1,240/3,277               (in progress)
⏸ rate-limited · resumes 14:32 UTC (GitHub)                       (paused)
⚠ last sync failed · Retry                                        (failed)
```

```
┌ Sync ──────────────────────────────────────────────────────────────────────┐
│ Status: syncing · phase "embedding changed chunks"   [Sync now (disabled)] │
│ ████████████████████░░░░░░░░  1,240 / 3,277    ETA ~4 min                  │
│ +12 new · −2 unstarred · 31 READMEs changed · 47 chunks embedded           │
│ ──────────────────────────────────────────────────────────────────────────  │
│ History                                                                    │
│ 2026-09-13 03:00 · 6m12s · +12/−2/31 · ok                                  │
│ 2026-09-12 03:00 · 5m58s · +8/−0/12 · ok ← ⚠ 1 README fetch failed, retried│
│ 2026-09-11 03:00 · 0m41s · +0/−0/0  · rate-limited after 120 fetches       │
└────────────────────────────────────────────────────────────────────────────┘
```

- **Transport: SSE**, not polling. Effect `rc.112` ships the whole pipe: `HttpApiSchema.StreamSse({ data: SyncEvent })` on the endpoint, typed `Stream<SyncEvent>` on the generated client (verified in `effect/unstable/httpapi`), and `Atom.pull(...)` to expose the stream as an atom for `useAtomValue`. Cloudflare Workers impose **no wall-clock limit on HTTP invocations while the client is connected** (Workers limits, updated 2026-09-05), so a long-lived sync stream is supported; our `HttpPlatform` stub already does not compress responses, so events flush immediately. Ping event every 15 s.
- Events: `{_tag:"phase", name, done, total}` · `{_tag:"counts", added, removed, changed, chunks}` · `{_tag:"done", runId, summary}` · `{_tag:"error", message, retryable}` · `{_tag:"ping"}`. Reconnect with backoff; on reconnect refetch `GET /api/sync/status` before resuming the stream. Polling fallback (`GET /api/sync/status` every 3 s) if SSE fails twice.
- **Sync now** triggers `POST /api/sync` (idempotent: 409 with current run id if already running); disabled while running; optimistic header chip.
- **Rate-limit paused**: server stores `rate_limit_reset_at` from GitHub headers; the panel shows a live countdown and a "resume at" time instead of an error — it's a normal state, not a failure.
- **Error banner** with the last error message + `Retry` and a link to `wrangler tail` guidance; failed README fetches that were retried successfully are shown as a count, not an error.
- CLI parity: `starwatch sync` consumes the same `StreamSse` endpoint for progress output.

## 7. Settings (`/settings`)

| Tab         | Contents                                                                                                                                                                      |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| General     | Theme (dark / light / system), density (comfortable/compact), reduce motion, default search mode, rerank flag                                                                 |
| Index       | `GET /api/stats` — repos / chunks / vectors / last sync / unstars pending cleanup; **Rebuild index** (confirm + SSE progress, reuses the sync UI); "prune soft-deleted repos" |
| Sync        | Schedule display (from Alchemy config; read-only in v1), link to `/sync`, "sync on app open if stale > 24 h" toggle                                                           |
| Access      | Signed-in identity when available (`ctx.access` — ⚠️ may be `undefined` behind the static-assets router, see §8.5), endpoint URL, "Sign out" (Access logout URL)              |
| Danger zone | Clear local prefs (localStorage), full re-embed, remove all non-starred repos — each behind a typed confirmation                                                              |

## 8. Technology decisions

### 8.1 Serving: Worker `assets` prop, not Pages

**Verified in the installed `alchemy@2.0.0-beta.77`:** `Cloudflare.Worker` supports `assets` (string | `AssetsProps` with `directory`, `notFoundHandling`, `runWorkerFirst`, `htmlHandling`, `base`, plus `headers`/`redirects` sourced from `_headers`/`_redirects` files) and `Cloudflare.Website.Vite` **does not exist in beta.77** (the alchemy.run frontend docs describe a newer release) — so the `assets` prop is the only beta.77 path, and it happens to be the right one:

```ts
export default Cloudflare.Worker(
  "StarwatchWorker",
  {
    main: import.meta.url,
    assets: {
      directory: "../../apps/webui/dist",
      notFoundHandling: "single-page-application", // deep links → index.html
      runWorkerFirst: ["/api/*"], // API first; everything else = assets
    },
  } /* … */,
);
```

One deploy, one origin (no CORS, no second URL, cookies work for Access/SSE). `runWorkerFirst: ["/api/*"]` means **all app endpoints move under `/api/`**: without an explicit worker-first rule, a _browser navigation_ to a non-asset path (`Sec-Fetch-Mode: navigate`, compat date ≥ 2025-04-01) is served `index.html` **without invoking the Worker** — great for client routes, wrong for API routes. Non-navigation `fetch()` calls always reach the Worker, but explicit rules keep the routing predictable; move the current `/health`, `/db/time` stubs under `/api/` while wiring this up. Static assets on Workers support up to 100k files / 25 MiB each on Paid (limits, Sep 2026). Security headers (CSP, `X-Content-Type-Options`) ship as a `_headers` file in `dist/`. Pages remains supported but adds a second project, a second origin, and a second deploy target for zero benefit ⚠️ Pages not deprecated, just redundant here.

### 8.2 Vite 8 + React 19 + TypeScript

`vite@8.3.0` (Rolldown-based), `react@19.3.0` / `react-dom@19.3.0`, `@vitejs/plugin-react@6.1.1`, `typescript@7.0.2` (already the repo pin). Vite 8 requires Node ≥ 20.19. `apps/webui/vite.config.ts` stays minimal — no `@cloudflare/vite-plugin` (Alchemy manages the Worker; the plugin is explicitly incompatible with Alchemy's integration). Dev: `alchemy dev` boots the whole stack with Vite HMR and real bindings.

### 8.3 Data fetching: `@effect/atom-react`, not TanStack Query

**Recommend `@effect/atom-react@4.0.0-rc.112` + `AtomHttpApi`** (verified: the package's peers are `effect ^4.0.0-rc.112`, `react >=19 <20`, `scheduler` — add `scheduler` explicitly under pnpm ⚠️). Rationale:

- The typed client is _derived from the same `HttpApi` spec_ the Worker implements (`packages/contracts`) — queries, params, errors, and stream responses are compile-checked end-to-end; TanStack Query would need hand-written types/parsers duplicating the schemas.
- `AtomHttpApi.Service` gives `query()` atoms with caching/`timeToLive` and `mutation()` `AtomResultFn`s with `reactivityKeys`, so "assign group → invalidate repo + facet atoms" is declarative.
- `AsyncResult` maps 1:1 onto the UI states (Initial / Success / Failure) for skeletons and error surfaces without a second result abstraction.
- It's the same Effect runtime as Worker/CLI — typed errors cross the wire instead of becoming `unknown`.
- Cost: smaller ecosystem and no devtools as polished as TanStack Query's; SSR hydration is unused (SPA). TanStack Query 5.102.8 remains the fallback if the atom API chafes — cheap to swap because components consume hooks, not the client ⚠️ rc API may shift.

### 8.4 Live progress: SSE (typed), polling as fallback

Verified in rc.112: `HttpApiSchema.StreamSse({ data })` makes the success type `Stream<SyncEvent>` for the client; `HttpApiClient.SuccessType` special-cases it; `Atom.pull` turns a stream into a `Writable<PullResult>` atom. Sketch:

```ts
export const SyncEvent = Schema.Union([/* phase | counts | done | error | ping */]);
export const syncEvents = HttpApiEndpoint.get("syncEvents", "/api/sync/events", {
  success: HttpApiSchema.StreamSse({ data: SyncEvent }),
});
// handler: return Stream.fromQueue(queue) — fed by the Workflow, file-backed in D1/R2
// client:  const progress = Atom.pull(client.sync.syncEvents({}))
```

SSE beats polling for a 1–40 min backfill (instant phase changes, no wasted requests) and costs nothing extra on Workers. Reconnect + `Last-Event-ID` replay is optional ⚠️ — v1 re-fetches `status` on reconnect. EventSource-style cookies make Access transparent.

### 8.5 Auth: Cloudflare Access (GitHub IdP)

**Recommend Cloudflare Access**, wired via Alchemy's `access` prop (verified in beta.77: `policies`, `sessionDuration`, `allowedIdps`, `autoRedirectToIdentity`, `previews`). Zero Trust plus a GitHub OAuth app as IdP (documented flow), with one allow policy for the owner's GitHub account/email.

The alternative is a bearer token in localStorage: it must be injected into `fetch` wrappers, breaks `EventSource` (no headers), leaks under XSS, and needs rotation — all to protect a single-user app that the edge already gates, static assets and SSE included.

Two caveats. Worker-level Access does not support WebSockets (irrelevant: SSE is plain HTTP). And `ctx.access` is **not forwarded to the user Worker when static assets are attached** (documented 2026-08-18) — so don't depend on identity in v1; if needed later, expose identity under a `runWorkerFirst` path. Local dev: simulate with `dev: { access: { aud, identity } }`.

**Reconciling with docs/05 §6.2 (CLI token model):** the `sw_…` bearer remains the _application-level_ credential for CLI/scripts, but machine clients must also present Cloudflare **service-token headers** (or hit an explicitly bypassed path) — otherwise they get the login page instead of JSON. Browser sessions plus SSE stay the simplest path for the WebUI. The CLI/MCP surface should plan for service tokens in v2 ⚠️ and docs/05 §6.3's `/auth/exchange` needs a gate-aware call path.

### 8.6 Avatars

Use `https://avatars.githubusercontent.com/u/{id}?s=64&v=4` directly: verified `cache-control: max-age=300` + strong ETag (the `?s=64` resize param is conventional ⚠️), CDN-fast, no Worker subrequest cost. Fallback chain on `onError`: `https://github.com/identicons/{login}.png` (verified 200, cached ~1 year) → CSS monogram. Add `loading="lazy"` + `referrerPolicy="no-referrer"` + `decoding="async"`. A Worker/R2 proxy buys nothing for a personal single-user app (it adds ~3.3k subrequests once, then cache hits) and can be added later if a strict `img-src 'self'` CSP is wanted ⚠️.

### 8.7 Accessibility, responsive, dark mode

- **A11y**: search bar is a proper `combobox` with `listbox` suggestions; results are a selection-list with roving tabindex; `aria-live="polite"` announces result counts and sync phases; dialogs trap focus; every DnD action has a keyboard equivalent; visible focus rings; `prefers-reduced-motion` disables progress animation.
- **Responsive**: desktop-first (single user, likely desktop). Below ~1024 px the filter rail becomes a right-side drawer; below ~640 px cards stack, search is sticky, tap targets ≥ 44 px, and selection actions move into a bottom sheet.
- **Dark mode**: `data-theme="dark|light"` on `<html>` + CSS custom properties; system default via `prefers-color-scheme`; an inline pre-hydration script reads `localStorage` to avoid FOUC; `color-scheme` set for native form controls. CSS Modules + variables; no CSS framework needed at this size ⚠️.

## 9. Prior art (patterns worth borrowing)

**GithubStarsManager** (AI-star-manager, Electron/web) proves that a category sidebar with colors, drag-reorder, and _locking_ (so AI/sync never overwrites user organization) is the workhorse of star management — plus a per-card "Find similar" action and a Settings panel that warns "rebuild the index after changing embedding models". **Starcat** (macOS) shows the three-column shell done well, FTS5 + embeddings with RRF and chunk-level citations (`⇧⌘K` RAG workspace), smart collections ("Needs review", "No tags"), and a clean separation between the public star and the private knowledge base. **Astral** is the minimal ancestor: tags, drag-to-tag, bulk assign, and a very legible list UI. **Sourcegraph's search UI** is the best model for our search page: filters as first-class chips that can be clicked from results ("interactive filters"), language/repo metadata shown inline, keyboard-first navigation, and streaming results with a result-count header. starwatch should steal: lockable user categories, click-to-filter facets, selection-first bulk assignment, and chunk-reason snippets — while skipping their AI-summary surface in v1.

## 10. Component inventory

| Component                                      | Purpose                                                                |
| ---------------------------------------------- | ---------------------------------------------------------------------- |
| `AppShell`                                     | Header + outlet + toast host + shortcut provider                       |
| `HeaderBar`                                    | Logo, search trigger, `SyncChip`, theme toggle, settings link          |
| `SyncChip`                                     | Compact sync state in the header (synced / syncing% / paused / failed) |
| `SearchBar`                                    | Combobox input, debounce, scope label, `⌘K` handling                   |
| `SearchModeToggle`                             | auto/keyword/semantic/hybrid segmented control                         |
| `FilterRail`                                   | Container for facets + "clear all" + active-filter chips               |
| `FacetGroup`                                   | Collapsible facet section with live counts                             |
| `LanguageFacet` / `LanguageDot`                | Top-N language chips; Linguist-colored dot                             |
| `StarsHistogram` / `StarsRange`                | Bucketed histogram + dual-thumb range/number inputs                    |
| `GroupFacet`                                   | Multi-select group chips                                               |
| `TopicAutocomplete`                            | Tag input backed by `GET /api/suggest/topics`                          |
| `DateRangeFacet`                               | Starred-date range + presets                                           |
| `ArchivedToggle`                               | hide / include / only                                                  |
| `SortSelect`                                   | relevance / stars / recently starred / recently pushed                 |
| `ResultList`                                   | Selection state, `j/k`, bulk-select mode                               |
| `ResultCard`                                   | Repo name, description, meta row, snippet, matched-by badge, actions   |
| `Snippet`                                      | Sanitized highlighted text (~200 chars)                                |
| `MatchedByBadge`                               | keyword / semantic / both indicator                                    |
| `GroupChips`                                   | Read-only group membership chips                                       |
| `Pagination`                                   | Page controls + page-size selector (URL-driven)                        |
| `SkeletonCard`                                 | Loading placeholder                                                    |
| `EmptyState` / `NoResultsState` / `ErrorState` | Recovery-oriented empty/error surfaces                                 |
| `ShortcutHelp`                                 | `?` overlay listing keys                                               |
| `RepoDetailPage`                               | Header, metadata, README, groups, similar                              |
| `ReadmeView`                                   | Sanitized markdown renderer + relative-link rewriting + image opt-in   |
| `MetadataBlock`                                | Stars/forks/license/topics/branch/dates grid                           |
| `CloneUrlCopy`                                 | HTTPS/SSH clone URL with copy + toast                                  |
| `GroupEditor`                                  | Popover checklist for repo membership                                  |
| `SimilarRepos`                                 | Summary-vector neighbors list                                          |
| `UnstarBanner`                                 | Soft-deleted warning + removal action                                  |
| `GroupsPage` / `GroupRow`                      | Manager list with reorder affordances                                  |
| `GroupFormDialog`                              | Create/rename + color/icon picker                                      |
| `SmartRuleEditor`                              | Form-based AND-rule builder for smart groups                           |
| `BulkAssignBar`                                | Appears on multi-select: add/remove group actions                      |
| `SyncPage` / `SyncProgress`                    | Status card, phase label, progress bar, counters                       |
| `SyncHistoryTable`                             | Past runs with outcome + counts                                        |
| `RateLimitPanel`                               | Countdown to GitHub reset time                                         |
| `SettingsPage` / `SettingsTab`                 | Tabbed settings shell                                                  |
| `DangerZone`                                   | Confirm-gated destructive actions                                      |
| `Toast` / `ConfirmDialog`                      | Feedback + destructive confirmations                                   |
| `ThemeProvider`                                | Theme resolution, persistence, FOUC guard                              |

## 11. Open questions

1. **Cross-doc deltas from the parallel drafts** — (a) docs/04 §6.1 lists routes without the `/api` prefix; this spec mounts them under `/api/*` (and the search/response shapes follow docs/05 §4.4 `--json` envelope incl. `matchedBy[]`). (b) docs/05 §6.2's CLI `sw_…` token still needs an Access service-token path to reach the Access-protected Worker. Confirm both before implementation.
2. **Facet counts cost** — computing "count if I add this filter" semantics means several `GROUP BY`s per query against D1. Trivial at 3.3k rows, but confirm latency budget within R7 (<500 ms).
3. **Auto-mode explainability** — do we surface which mode `auto` picked on every result page, or only on hover?
4. **SSE back-pressure** — one worker instance streams to one browser; no fan-out. Confirm behavior when the user closes the tab mid-sync (Workflow continues; stream just ends).
5. **Sync schedule editing** — Alchemy owns cron in config; should Settings be read-only or write a `settings` row that the cron reads?
6. **README images** — default off (privacy) or on (fidelity)? Proposal: off with a per-repo "show images".
7. **Router** — TanStack Router vs React Router 8: pick at implementation; URL schema in `packages/contracts` makes either swappable.
8. **Access + previews** — protect Workers preview URLs too (`previews: true`, default) so no unauthenticated staging; confirm against `alchemy dev` workflow.
9. **`/api` prefix migration** — decide the migration for the existing `/health`/`/db/time` stubs (move under `/api/` vs. add to `runWorkerFirst`), and whether docs/04's route table gets an explicit `/api` prefix.
10. **Query latency instrumentation** — surface `tookMs` + leg timings in the UI (dev-only badge?) to keep R7 honest.

## Sources (load-bearing, verified 2026-09-13)

- Alchemy `assets`/`access` on `Cloudflare.Worker`, absence of `Website.Vite`, `WorkerAccessApplication` shape: installed `alchemy@2.0.0-beta.77` sources (`src/Cloudflare/Workers/Worker.ts`, `WorkerAccess.ts`, `Assets.ts`), plus <https://alchemy.run/cloudflare/frontend/vite-spa> (newer API, not beta.77).
- Effect SSE + atoms: installed `effect@4.0.0-rc.112` (`unstable/httpapi/HttpApiClient.ts`, `HttpApiSchema.ts`, `unstable/reactivity/AtomHttpApi.ts`, `Atom.ts`) and `@effect/atom-react@4.0.0-rc.112` (npm metadata: peers `react >=19 <20`).
- Workers limits/duration/streams: <https://developers.cloudflare.com/workers/platform/limits/> · <https://developers.cloudflare.com/workers/static-assets/> · <https://developers.cloudflare.com/workers/static-assets/routing/single-page-application/> · <https://developers.cloudflare.com/workers/runtime-apis/streams/>.
- Cloudflare Access for Workers + static-assets `ctx.access` caveat: <https://developers.cloudflare.com/workers/configuration/cloudflare-access/>; GitHub IdP: <https://developers.cloudflare.com/cloudflare-one/identity/idp-integration/github/>.
- Frontend versions: npm registry (`vite@8.3.0`, `react@19.3.0`, `@vitejs/plugin-react@6.1.1`, `react-markdown@10.1.0`, `rehype-sanitize@6.0.0`, `dompurify@3.4.15`, `typescript@7.0.2`).
- Avatars/identicons cache headers: live `curl -I` against `avatars.githubusercontent.com/u/583231` and `github.com/identicons/octocat.png`.
- Prior art: <https://github.com/AmintaCCCP/GithubStarsManager> · <https://github.com/starcat-app/Starcat> · <https://github.com/astralapp/astral> · <https://sourcegraph.com/search>.
