# 03 — Sync Interaction Spec & GitHub API Rate-Limit Dossier

> ⚠️ **Pivot notice (2026-09-13):** this document predates the public multi-tenant pivot. See [08-public-service-ux.md](08-public-service-ux.md)–[12-hardening.md](12-hardening.md) for the current design and [11-assumptions-delta.md](11-assumptions-delta.md) for exactly what changed.

> Status: **draft for discussion** · 2026-09-13 · Endpoints, scopes, rate limits and ETag behavior verified live against `api.github.com` on this date (account `coldter`); ⚠️ marks low-confidence items to re-check at implementation time. Companions: [00](00-requirements.md) · [01](01-search-and-index.md) · [02](02-stack-and-pipeline.md).

This doc owns: every GitHub API call starwatch makes, its quota cost, ETag/304 semantics, error handling, token choices, and the sync run state machine. Lists *consumption* is covered here only at the quota level; list→group UX lives in [04](04-groups.md).

## 0. Headline numbers

| Step | Endpoint | Requests at N=3,277 | Requests at live N=3,448 ⚠️ | Rate class |
|---|---|---|---|---|
| Login + profile | `GET /user` | 1, once | 1, once | REST core |
| Star listing, full sweep | `GET /user/starred?per_page=100` | **33 pages** | **35 pages** | REST core |
| README backfill | `GET /repos/{o}/{r}/readme` | **3,277** | **3,448** | REST core |
| Lists (groups) | GraphQL `viewer.lists` | ~1–3 points | ~1–3 points | GraphQL points |
| Nightly incremental, typical | listing sweep + changed READMEs | ~40–70 | ~40–70 | REST core |
| **Backfill total** | | **3,310 ≈ 66% of one 5,000/h window** | **3,483 ≈ 70%** | fits one window |

- ⚠️ **Count discrepancy.** [00](00-requirements.md) says 3,277 stars; live `gh api user/starred` on 2026-09-13 returns **3,448** (35 pages of 100; `Link: rel="last"` page 35). Anonymous `/users/coldter/starred` shows 3,446 public; the authenticated token sees **2 private stars**. Formulas below are parametric in N; concrete numbers show the spec's N=3,277 and live N=3,448 where they differ. Reconcile before finalizing ETAs.
- **304s are free** when the request is correctly authorized — verified live: `x-ratelimit-used` stayed at 82 across 3 consecutive conditional requests (matches docs, see Sources). A 404 does consume quota (observed).
- Conditional requests require every request parameter to be identical, or GitHub treats it as a different representation and returns a fresh ETag.
- GitHub's July 2026 access restrictions apply to `/repos/{o}/{r}/stargazers` (the *list of people who starred a repo*), **not** to `/user/starred`. starwatch is unaffected — but do not confuse the two.
- Bigger risks than the primary quota: secondary limits (concurrency/CPU/points-per-minute), stale ETag assumptions (the listing embeds volatile fields like `stargazers_count`), and private-resource visibility (private stars, SSO, org token policy).

## 1. Rate-limit model (what actually throttles us)

### 1.1 Primary limits (per authenticated user, shared by all tokens/apps on that account)

| Resource | Limit | Applies to | Reset semantics |
|---|---|---|---|
| REST `core` | **5,000 req/h** | `/user/*`, `/repos/*`, `/rate_limit`, everything non-search | Sliding window from the token's first request of the window; read `x-ratelimit-reset` (epoch seconds) — do **not** assume clock-hour |
| REST `search` | 30 req/min | `/search/*` (unused by sync) | 60 s |
| GraphQL | **5,000 points/h** | `graphql` endpoint; cost ≈ connections/100, min 1 | Same sliding-window behavior |

Headers on every response: `x-ratelimit-limit`, `-remaining`, `-used`, `-reset`, `-resource` (`core`/`search`/`graphql`). `GET /rate_limit` does not count against primary (but counts against secondary — don't poll it more than ~1×/5 min; prefer response headers).

- Unauthenticated: 60 req/h per IP (`search` 10/min). Never unauthenticated in production.
- A token with no scopes can still read public data; scopes/permissions only add private access. Classic PAT, OAuth token, GitHub App user token, and fine-grained PAT all debit the **same** 5,000/h bucket.
- Timeouts: GitHub kills requests >10 s (502/504); GraphQL timeouts additionally deduct points for the next hour.

### 1.2 Secondary limits (the ones 3.4k backfill requests can trip)

Documented values ([REST limits], [GraphQL limits]):

| Rule | Limit | Our exposure |
|---|---|---|
| Concurrent requests | **100 max** (REST + GraphQL shared) | We cap at **5** (Workers allows 6 outbound connections) |
| Points/min per endpoint | **900** REST / **2,000** GraphQL | Pacing ≤700 req/min keeps us clear |
| Server CPU | ≤90 s CPU per 60 s real time (≤60 s GraphQL) | Trivially satisfied by README fetches |
| Content generation | 80/min, 500/h (mutating calls) | We are read-only → N/A |
| OAuth token creation | 2,000/h per app | N/A unless device flow is added |

Secondary limits are undocumented in detail and can trigger for undisclosed reasons. Practical envelope for starwatch: **concurrency 5, sustained ≤700 req/min, burst ≤12 req/s for README phase, always read `retry-after`**.

### 1.3 Error taxonomy and handling

| Symptom | Meaning | Action |
|---|---|---|
| 403/429 + `x-ratelimit-remaining: 0` | Primary exhausted | Persist cursor, `step.sleepUntil(x-ratelimit-reset + 30s)`, set state `paused_rate_limit` |
| 403/429 + message contains "secondary rate limit" | Secondary hit | Honor `retry-after` (seconds) if present; else wait ≥60 s; exponential backoff; halve concurrency for the next window |
| 401 | Token expired/revoked | `needs_auth` terminal state; surface "run `starwatch login`" |
| 403 + `Resource not accessible by personal access token` | Missing fine-grained permission | Check `X-Accepted-GitHub-Permissions` header; fix token, `needs_auth` |
| 404 on a repo we expect | Gone, private without access, or renamed path not canonical | Follow 301 `Location` first; then treat as visibility loss, not deletion (see §5) |
| 403 + SSO (see `X-GitHub-SSO`) | Token not SSO-authorized for an org | Re-authorize token; retry after user action |
| 301 | Renamed/moved repo | Follow to `https://api.github.com/repositories/{id}`; id is stable |
| 410 | Unsupported API version | Bump `X-GitHub-Api-Version` |
| 422 | Malformed params (e.g. bad `per_page`) | Bug; do not retry |
| 5xx / timeout | GitHub incident | Exponential backoff (cap ~10 attempts), mark run `error`, next cron retries |

Retry config per Workflows step: `retries { limit: 8, delay: dynamic (rate-limit-aware), backoff: exponential }`, `throw NonRetryableError` for 401/403-permission/422. Workflows defaults: 5 retries, 10 s, exponential, 10 min timeout per attempt — override explicitly.

### 1.4 API version and headers

Pin `X-GitHub-Api-Version: 2022-11-28` (current default, supported until 2028-03-10) or move to `2026-03-10`; either way **pin explicitly**, because the version participates in the ETag identity. Fixed headers for every call: `Authorization: Bearer …`, `Accept: application/vnd.github+json` (star listing adds `star+json`), `User-Agent: starwatch/<ver> (+https://github.com/coldter/starwatch)`, version header.

## 2. Per-step dossier

### (a) Login / auth

No API quota for device flow endpoints (github.com, separate from api.github.com). One `GET /user` per login to verify identity and read `x-oauth-scopes` / `X-Accepted-GitHub-Permissions`. Device flow limits: user code valid **900 s**; **50 user-code submissions/hour/app**; poll no faster than `interval` (≥5 s) or get `slow_down` (+5 s per violation); `authorization_pending`/`slow_down`/`expired_token`/`access_denied` are the expected errors. Token creation itself has per-app limits (10 tokens/user/app/scope; 10 tokens/hour). See §3 for which token.

### (b) User profile

`GET /user` → 1 core request, cached in D1 `profile` (login, name, avatar_url). Refresh only on login or manual `starwatch sync --refresh-profile`; never per sync. Unauthenticated `GET /users/{login}` works as fallback (60/h) but is not needed.

### (c) Avatar display / proxy

Endpoint: `https://avatars.githubusercontent.com/u/{user_id}?v={n}&s={px}` — a **CDN**, not the API; **0 API quota**. Verified response headers: `cache-control: max-age=300`, `etag`, `last-modified`, `access-control-allow-origin: *`, `cross-origin-resource-policy: cross-origin` (Fastly/Varnish: `via`, `x-cache`). Sizes: `s=` 16…460; requests above the stored native size return that size (s=1000 == s=460 bytes, verified). `v=` is the cache-busting version segment. Fallback: GitHub serves an identicon automatically for accounts without avatars, and `https://github.com/identicons/{login}.png` exists with `max-age=1y` — handle broken avatar images with a local initials placeholder rather than another fetch.

**Recommendation: hotlink directly.** CORS `*` means the WebUI needs no proxy; browsers cache 5 min; no Worker cost. Add CSP `img-src 'self' https://avatars.githubusercontent.com`.

Optional proxy (only for privacy/CSP unification): `caches.default` with normalized key `https://starwatch.internal/avatar/{user_id}?s=96`, stored with an overridden `Cache-Control: max-age=86400, immutable`. Caveats: Cache API is **per data center** (use KV for global consistency), `cache.put` is incompatible with tiered caching, and Cache API is unavailable when the Worker is fronted by Cloudflare Access ⚠️. R2 is overkill (~3.3k avatars ≈ 10–25 MB) unless we later need offline/absolute privacy. Decision deferred to WebUI doc.

### (d) Full star listing

```
GET /user/starred?per_page=100&page={n}&sort=created&direction=asc
Accept: application/vnd.github.star+json   ← adds starred_at
```

- **Cost**: 1 core request/page; 33 pages (N=3,277) / 35 (N=3,448); 0.7% of a window. 304 responses are **free** (authorized, verified).
- **Sort semantics**: `sort=created` = when *you* starred it (`starred_at`, default direction `desc`); `sort=updated` = when the repo was last *pushed to* — unstable ordering, never use for ETag caching. Use `created + asc`: new stars append at the tail, so only the last page changes on a normal day.
- **Pagination**: trust `Link` (`rel="next"`, `rel="last"`) — never construct URLs. `per_page` max 100.
- **Payload**: with `star+json`, each item is `{ starred_at, repo: {...} }`. Pin the media type in the ETag key; without it you get a different representation.
- **ETag reality check**: the page body includes volatile fields (`stargazers_count`, `pushed_at`), so pages will often return 200 even with no star changes. That's fine — a full sweep is ~0.7% of quota. Treat ETags as a resume/optimization mechanism, not the design premise. Unchanged responses still save bandwidth/CPU.
- **Private stars**: `/user/starred` returns private repos the token can see (2 of 3,448 today). A token without private access silently omits them — compare totals at login and warn (see §3).

### (e) GitHub Lists (GraphQL only)

```graphql
query { viewer { lists(first: 100) { totalCount pageInfo { hasNextPage endCursor }
  nodes { id name isPrivate items(first: 100) { pageInfo { hasNextPage endCursor } nodes { ... on Repository { id nameWithOwner } } } } } } }
```

- **Cost**: documented formula = sum of connection requests ÷ 100, rounded up, minimum 1. `lists` = 1 request; each list's `items` = 1 per page. 22 lists → ~1 point; all 22 × one items page → ~1 point (min). Verified live: `rateLimit.cost: 1` for the list query and lists are readable (including private ones) with the `gh` token.
- **No ETags/304s in GraphQL**, and mutations cost 5 points — read nightly or on demand only.
- **Scopes ⚠️**: docs do not state a GraphQL scope requirement for `viewer.lists`; verified working with scopes `repo, read:org, gist, workflow`. Fine-grained-equivalent permission for Lists is unverified — test with the production token; fallback is adding `read:user` to a classic OAuth token.
- Full sync semantics (list membership changes, list ordering) are out of scope here; store `list_id ↔ repo_id` join rows and diff like stars.

### (f) README fetch

```
GET /repos/{owner}/{repo}/readme         ← canonical, use full_name from the latest listing
Accept: application/vnd.github.raw+json  ← raw body is the documented default for this endpoint
If-None-Match: "<stored etag>"
```

- **Cost**: 1 core request; 304 = free; 404 **does** count (observed) → cache "missing" for 30 days.
- URL hygiene: always use the canonical `full_name`; stale names 301 to `/repositories/{id}` (verified: `sst/opencode` → `975734319`). Follow redirects (docs mandate it), but re-key by repo `id`.
- **Size**: the contents API documents ≤1 MB (full features), 1–100 MB (only `raw`/`object` media types), >100 MB unsupported. The `/readme` endpoint's own behavior for >1 MB is ⚠️ untested (largest probed README: 258 KB). Workaround if 403/too-large: fetch via `raw.githubusercontent.com` (no API quota, ETag works, works for private repos with a token) or mark `readme_state='too_big'` and index metadata only. Also cap our own processing at ~1 MB; truncate beyond.
- **404 cases**: no README, empty repo (no commits), deleted/private repo. Distinguish using the listing: `size == 0` → empty repo, skip; not in listing → deleted; else missing README.
- **Concurrency**: ≤5. Pacing: README phase is the only burst — target ≤700 req/min sustained.

### (g) Incremental refresh (page ETags, invalidation)

Store `star_pages(page PK, etag, fetched_at, item_count)` with a `etag_key = hash(url + accept + api_version)`. Nightly: sweep pages 1..last (last known), conditional GETs; if the final page has 100 items, probe page+1 (new stars may have created a page).

| Invalidation event | Pages returning 200 (`created asc`) |
|---|---|
| New star appended | Last page only (+ new page at every 100-crossing) |
| Unstar removed anywhere | The removed item's page **and all subsequent pages** (suffix shift) |
| Rename / description / topics change | Containing page |
| Any repo on the page gains/loses a star (`stargazers_count`) | Containing page — common; expect many 200s |
| Different params/media/version in request | Everything (different representation) |

- Unstar detection requires the **full sweep**; a single page cannot prove absence. After a complete sweep, `is_starred=0` for DB ids not present; delete vectors; keep rows 90 days.
- If a page fails terminally, keep old rows, mark the run degraded (not `error`), and re-run the sweep next night. Do not mark any repo unstarred from a partial sweep.
- New-star snapshot rule: the listing fetched at run start defines the run's snapshot. Stars added mid-backfill are picked up by the next run (cheap: the tail page).

### (h) Metadata refresh trigger policy

| Trigger | Check | Action |
|---|---|---|
| New repo id (new star) | none | Full pipeline: README → chunk → embed → upsert |
| `pushed_at > readme_checked_at` | Conditional README (ETag) | 304 → just touch `readme_checked_at` (free); 200 → re-chunk, re-embed changed hashes |
| `readme_state='missing'` and `checked < now-30d` | unconditional retry | Still 404 → push date forward |
| `readme_state='error'` (5xx/timeout) | next run | Retry with backoff |
| `default_branch` changed | unconditional | Refetch (rare) |

README **ETag is the source of truth** for content; `pushed_at` is only the cheap trigger that avoids 3,448 nightly conditional probes. Since 304s are free, an always-conditional sweep is *possible* (~0.7% quota + secondary exposure) but pointless — a README cannot change without a push. Known false-negative: none in practice; force-pushes still update `pushed_at`.

### (i) Misc calls / limit detection

- `/rate_limit`: free on primary, counts secondary. Poll at most 1×/5 min, cache the response in D1 for the UI; otherwise read response headers opportunistically.
- Store per-run counters (`api_used`) and the last observed `remaining/reset` in `sync_runs` so the CLI/WebUI can warn before a long phase.
- `X-Accepted-GitHub-Permissions` and `X-GitHub-SSO` response headers are part of error diagnostics, not normal flow.
- GitHub status (`https://www.githubstatus.com/api`, different host, free) can distinguish our bug from an outage before erroring a run.

## 3. Token options

All options debit the same user quota (5,000/h REST, 5,000 points/h GraphQL). Verified fine-grained mapping: `GET /user/starred` requires account permission **Starring: read** (`starring=read`), no additional permissions.

| Option | Scopes/permissions | Expiry | Private stars | Org/SSO | Verdict |
|---|---|---|---|---|---|
| **Fine-grained PAT** ✅ recommended | `starring=read` (+ repository access if private stars are indexed) | user selects; ≤366 days via template, "none" allowed unless org policy caps it | only repos the token can access | org owner may require approval; fine-grained PATs are authorized at creation (no separate SSO step) | least privilege, no OAuth app needed, simplest storage |
| Classic PAT | `repo` for private stars (no scope needed for public) | user-set, recommended; auto-revoked after 1 year unused | yes, with `repo` | must be SSO-authorized per org; orgs can disable classic PATs | broad scope (`repo` = all private repos) |
| OAuth app via **device flow** | `public_repo` (public starring/reading) or `repo` (private) | non-expiring by default; 8 h if app enables expiring tokens or `offline_access` requested (+refresh token) | needs `repo` | orgs can block OAuth apps for org resources | best UX, broader scopes, extra app registration |
| GitHub App user token | account permission **Starring** ⚠️ (verify) | **8 h**; refresh token 6 months; owner can configure never-expire | needs repo access grants | app must be installed/approved; refresh machinery required for nightly cron | overkill for single user |

**Private-stars visibility caveat**: a token that cannot see a private repo silently omits it from `/user/starred`; there is no flag distinguishing "not starred" from "not visible". At login, compare the token's total star count vs. an expected count and warn if lower. Today: 3,448 total vs 3,446 public → 2 private stars.

**SSO caveat**: for SAML SSO orgs, classic PATs require per-org "Configure SSO → Authorize" after creation; fine-grained PATs are authorized during creation (or pending org approval — public-only until approved). If private org stars are expected but missing, check `X-GitHub-SSO` diagnostics and the token policies. Linked-identity users can only use authorized credentials for that org.

**Lifetime/revocation**: unused PATs are auto-revoked after 1 year; pushing a token to a public repo/gist revokes it; users/apps can revoke at any time; our sync must treat any 401/403-permission as `needs_auth`, not retry forever.

## 4. Sync interaction design

### 4.1 Onboarding: `starwatch login`

**Recommendation: fine-grained PAT as the sync credential (v1).** Rationale: least privilege (`Starring: read`), no OAuth app registration to maintain, no 8-hour refresh machinery (GitHub App) and no broad `repo` scope that device flow needs for private stars. Device flow becomes attractive at MCP/multi-machine time (v2).

> ⚠️ **Cross-doc conflict:** [05](05-cli.md) §6.3 currently makes device flow the default `starwatch login` UX and issues a `sw_…` deployment token via `/auth/exchange`. That decides *how the CLI authenticates to the Worker*; this doc decides *which GitHub credential sits in the Worker secret*. Both can coexist: `login --token` can deliver the fine-grained PAT, or device flow can deliver an OAuth token (broader scopes). Resolve in Open question 3. This doc only specifies where the **GitHub** credential lives: a Worker secret, never D1/local files.

```
$ starwatch login
  1. Open https://github.com/settings/personal-access-tokens/new
       ?name=starwatch&description=Read+my+stars&starring=read&expires_in=180
     (also printed as a prefilled URL; add repository access if private stars are wanted)
  2. Paste token (hidden input; never echoed, never in shell history):
  3. Verifying: GET /user ... ok (coldter)
     Stars visible: 3,448 (expected 3,448)   ← 1 listing request using Link rel=last
     Rate limit: 5,000/h core, reset 11:22 UTC
  4. Storing in Worker secret GITHUB_TOKEN (wrangler secret put / CF API) ... done
     Local copy: not stored (CLI delegates everything to the Worker)
```

| Storage option | Verdict |
|---|---|
| **Worker secret** (env binding, encrypted at rest, not readable back) | ✅ required by [00 R14]; `secrets.required` in wrangler fails deploys when missing |
| D1 | ❌ any query/console can read it |
| Local config file | ❌ plaintext disk; optional OS keyring only if the CLI ever calls GitHub directly |
| `.dev.vars` / `.env` | local dev only; gitignored |

Front the login/status endpoint with the user's own admin auth (Cloudflare Access or a bootstrap secret); the CLI needs Cloudflare credentials anyway for deploy. Rotation: re-run `starwatch login`; revocation: delete the secret + revoke token on GitHub, run shows `needs_auth` until then. Expiry UX: nightly sync's first listing detects 401 → run state `needs_auth` → CLI/WebUI banner "GitHub token rejected or expired — run starwatch login"; cron keeps failing fast (no retry storm).

### 4.2 First backfill: phase model

One Workflow instance per run: id `sw-sync-{run_id}` (≤100 chars; retention 30 days on Paid). Every phase is idempotent and checkpointed in D1; `step.sleep`/`sleepUntil` don't count toward the 10,000-step limit; waiting instances don't consume concurrency.

| Phase | Work | Request cost | Checkpoint | ETA @ conc. 5 |
|---|---|---|---|---|
| 1 `listing` | 35 pages → upsert repo metadata, write metadata-only FTS rows, `star_pages`, diff | 35 | per page (`star_pages.page+etag`) | ~30–60 s (paced) |
| 2 `planning` | worklist = new + `pushed_at`-changed + retry-due; snapshot id | 0 | worklist table | seconds |
| 3 `fetching` | batches of 25: README (ETag) → R2 archive (optional) → chunk+hash → D1 batch (repo + chunks + FTS, `index_state`) | ≤3,448 (304s free) | per batch (25) | **~5–15 min** (3448 × 0.4–1.0 s ÷ 5) |
| 4 `embedding` | ≤100 chunks/call (bge-m3) → Workers AI | ~200 AI calls | per embed batch | ~3–10 min |
| 5 `vectorizing` | upsert ≤1,000/batch, delete removed ids (async visibility) | ~25 calls | per upsert batch | ~1–2 min |
| 6 `finalizing` | counters, `index_state='full'`, run summary | 0 | — | <1 s |

**Realistic wall clock 15–40 min**; worst case +≤60 min if the hourly window is already partly consumed — preflight `x-ratelimit-remaining` ≥ ~3,600 before starting, else `paused_rate_limit` until reset. Backfill writes ~10–15k subrequests (README 3.4k + D1/R2/Vectorize counts as subrequests) > the 10,000 default → **set `limits.subrequests ≥ 50_000`** in wrangler. Step count ~35 + ~138 + ~200 + finalize ≪ 10,000.

**Searchable during backfill**: yes — `index_state` is `metadata` (after phase 1), `readme` (phase 3), or `full` (phase 5). Lexical search works from phase 1; semantic recall grows until phase 5. Result cards get an "indexing" marker and `stats` shows coverage `1,203/3,448 (35%)`.

**Partial failure per phase**: phase 1 page failure → step retry, terminal failure errors the run (already-fetched pages are committed; resume from cursor). Phase 3 per-repo failure → record `readme_state='error'`, continue; retried next run. Phase 4/5 batch failure → retry, then skip batch; affected chunks stay `embedded=0` and are retried next run (no corruption). Cancel = `instance.terminate()` + run state `cancelled`; retry = `create` new instance with same checkpoint cursor or `restart({ from: … })` semantics (cached step results before that step are reused).

**Snapshot semantics**: all stars present at run start belong to this run; stars added after the listing completes are deliberately deferred to the next run (tail-page diff makes this cheap). No mid-run re-listing.

### 4.3 Incremental sync

Schedule: nightly cron (default **03:00 UTC**, adjustable) + `starwatch sync` manual + `starwatch sync --full` re-backfill. Flow: sweep listing (conditional ETags) → diff new/unstarred/renamed → worklist → batch fetch/chunk/embed → finalize. Steady state: ~40–70 requests/night (most README checks 304 → free), ~0.6M embedding tokens/month.

- **Unstar**: after a complete sweep, ids absent from the listing → `is_starred=0`, `unstared_at`, delete vectors, FTS delete, keep row 90 days.
- **Re-star**: same repo id → reactivate row; if README ETag matches, skip re-embedding entirely. Same `full_name` with a different id → new row; old row stays soft-deleted.
- **Staleness**: `last_success_at` in a `sync_meta` row; CLI/WebUI show a badge if >48 h ("stale — last sync 2 days ago"). Per-repo staleness = `readme_checked_at`.
- **Pause/resume UX**: on quota exhaustion → state `paused_rate_limit`, `resume_at = reset+30s`; copy: CLI `⏸ GitHub rate limit reached — 812/5,000 left; resuming automatically at 11:23 UTC (~4 min)`, WebUI same string in the status banner; the Workflow hibernates (no compute cost, no concurrency slot).

### 4.4 Sync status contract (define, don't implement)

State machine (canonical states requested, plus two error sub-states):

```
idle ──cron|cli──► listing ──► fetching ──► embedding ──► idle (success)
                      │            │  ▲
                      │            ▼  │ step.sleepUntil(reset+30s)
                      │      paused_rate_limit
                      ▼
                    error (needs_auth | cancelled | incident)
```

`sync_runs` (D1) — DDL draft:

```sql
CREATE TABLE sync_runs (
  id INTEGER PRIMARY KEY, instance_id TEXT UNIQUE, kind TEXT, -- backfill|incremental|manual
  state TEXT NOT NULL,            -- idle|listing|fetching|embedding|paused_rate_limit|needs_auth|error|cancelled|done
  snapshot_at TEXT, started_at TEXT NOT NULL, finished_at TEXT, heartbeat_at TEXT,
  pages_done INTEGER DEFAULT 0, pages_total INTEGER,
  repos_total INTEGER, repos_done INTEGER DEFAULT 0,
  readme_200 INTEGER DEFAULT 0, readme_304 INTEGER DEFAULT 0, readme_404 INTEGER DEFAULT 0,
  chunks_total INTEGER DEFAULT 0, chunks_embedded INTEGER DEFAULT 0, vectors_upserted INTEGER DEFAULT 0,
  api_used INTEGER DEFAULT 0, rate_remaining INTEGER, rate_reset_at TEXT,
  resume_at TEXT, retry_after_s INTEGER, error_step TEXT, error_code TEXT, error_message TEXT,
  summary_json TEXT
);
-- repos sync columns: synced_at, is_starred, unstared_at, readme_state, readme_etag, readme_sha,
-- readme_size, readme_checked_at, index_state (metadata|readme|full|error)
```

`GET /api/sync/status` JSON (CLI polls; shared with the WebUI stream):

```json
{ "run_id": 42, "state": "fetching", "kind": "incremental", "started_at": "…", "heartbeat_at": "…",
  "progress": { "pages": {"done": 35, "total": 35}, "repos": {"done": 812, "total": 3448},
                "readme": {"ok": 120, "not_modified": 690, "missing": 2}, "chunks": {"embedded": 5400, "total": 19700} },
  "eta_seconds": 480, "paused": null, "rate_limit": {"remaining": 4120, "limit": 5000, "reset_at": "…"},
  "error": null, "last_success_at": "…" }
```

- **CLI**: `starwatch sync` starts and tails by default ([05](05-cli.md) §3.2; Ctrl-C detaches, run continues); it polls `/api/sync/status` every 2 s (1 s during `listing`), prints transitions + progress, and prints final counters on stdout; `--json` emits NDJSON `{seq, ts, type, data}` lines; exits non-zero on `error`/`needs_auth`.
- **WebUI**: `GET /api/sync/events` SSE, typed `HttpApiSchema.StreamSse` ([06](06-webui.md) §8.4); events `{_tag:"phase", name, done, total} | {_tag:"counts", added, removed, changed, chunks} | {_tag:"done", runId, summary} | {_tag:"error", message, retryable} | {_tag:"ping"}` with `{seq, ts, run_id}` envelope fields; ping every 15 s; on reconnect the client re-fetches `GET /api/sync/status` before resuming (v1) — `Last-Event-ID` replay is optional ⚠️; polling fallback every 3 s after two SSE failures. The same `SyncEvent` schema ships in `@starwatch/contracts` for CLI/WebUI.
- **Stall detection**: heartbeat older than 15 min while state is active → status shows "stalled"; next check reconciles against `instance.status()`.

## 5. Edge cases

| # | Case | Detection | Handling |
|---|---|---|---|
| 1 | No README | 404 | `readme_state='missing'`, retry ≤30 d; metadata still searchable |
| 2 | Empty repo | listing `size == 0`; 404 | Skip README, metadata only |
| 3 | README >1 MB | contents/readme 403 or size field ⚠️ | Skip/truncate, `too_big`; optional `raw.githubusercontent.com` refetch (no API quota) |
| 4 | Renamed repo | 301 → `/repositories/{id}` | Match by `id`; update `full_name`; refetch README under new name |
| 5 | Deleted repo | Absent from sweep (and/or 404) | Soft-delete after **complete** sweep; keep rows 90 d |
| 6 | Repo goes private | 404 while token lacks access / absent from listing | Keep row, flag `visibility_unknown`; never hard-delete on 404 |
| 7 | Unstar mid-sync | Later sweep diff | In-flight fetch is harmless; delete at next complete sweep |
| 8 | Same `full_name` re-starred | id match (same repo) vs new id | Same id → reactivate, skip re-embed if ETag unchanged; new id → new row |
| 9 | Rate-limit exhaustion mid-backfill | 403/429, remaining=0 | Cursor is committed per batch; `sleepUntil(reset+30s)`; resume |
| 10 | Revoked/expired token | 401 (or 404 for private-only) | `needs_auth`, halt, banner; no retries |
| 11 | Worker crash mid-step | stale heartbeat / instance status | Step retried (defaults 5×, we use 8×); writes idempotent by `repo.id`/chunk hash |
| 12 | GitHub outage/5xx | 502/503/504, timeouts, status API | Exponential backoff; run `error`; next cron retries; status page check |
| 13 | Secondary CPU/concurrency limit | 403/429 "secondary rate limit" | `retry-after` first; drop to concurrency 1–2 for 10 min; exponential |
| 14 | Org SSO | `X-GitHub-SSO`, missing private org stars, 403/404 | Authorize classic PAT per org (fine-grained authorized at creation); surface fix-IT action |
| 15 | Org blocks PATs/OAuth apps | 403/404 on org-owned resources | Use fine-grained PAT with org approval or GitHub App |
| 16 | Avatar CDN blocked | broken `<img>` | CSP allowlist; local initials placeholder; optional Worker/KV proxy |
| 17 | Star-list page shifted by unstar | suffix of pages returns 200 | Expected; sweep is still ≤35 requests; never infer unstars from one page |
| 18 | Stargazers-endpoint restrictions (Jul 2026) | N/A | We use `/user/starred`, not `/repos/{o}/{r}/stargazers`; no impact |

## 6. Open questions

1. **Count reconciliation**: 3,277 (docs) vs 3,448 (live). Which number is canonical for planning?
2. **Private stars**: index them? If yes, fine-grained PAT needs repository access (all vs selected) and the org-approval path may apply.
3. **Login method final call**: fine-grained PAT as sync credential (recommended) vs device flow with a registered OAuth app — [05](05-cli.md) §6.3 currently defaults the *CLI UX* to device flow; align once decided. If device flow, expiring tokens or not?
4. **Backfill trigger**: auto-start after first successful login, or explicit `starwatch sync --full`?
5. **Schedule**: 03:00 UTC nightly — or shift to match the token's rate-limit window so backfills never start pre-consumed?
6. **Missing-README retry cadence**: 30 days proposed; longer for genuinely empty docs?
7. **>1 MB READMEs**: raw.githubusercontent fallback (unbounded size) vs `too_big` metadata-only — confirm after finding a live example.
8. **Renamed repos**: keep old `full_name`s as searchable aliases for deeplinks and memory?
9. **SSE replay**: [06](06-webui.md) §8.4 chose SSE with reconnect-refetch for v1 — is `Last-Event-ID` replay worth adding for the WebUI (nice for long backfills) or is status-refetch always enough?
10. **Rate-limit alarm**: warn in CLI/UI when remaining <20% before a heavy phase — threshold?
11. **Lists**: nightly refresh vs on-demand; and do lists become a filter facet in v1?

## Sources (verified 2026-09-13)

- REST limits & secondary limits: <https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api>
- Best practices (304s free rule, stable sort, conditional requests): <https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api>
- Starring endpoints (`/user/starred`, `star+json`, sort semantics): <https://docs.github.com/en/rest/activity/starring?apiVersion=2022-11-28>
- July 2026 stargazers/watch restrictions (not `/user/starred`): <https://github.blog/changelog/2026-06-30-upcoming-access-restrictions-to-public-api-endpoints-and-ui-views/>
- Contents/README endpoint (media types, 1 MB/100 MB rules): <https://docs.github.com/en/rest/repos/contents?apiVersion=2022-11-28>
- Error taxonomy / `X-Accepted-GitHub-Permissions`: <https://docs.github.com/en/rest/using-the-rest-api/troubleshooting-the-rest-api>
- GraphQL rate limits and point math: <https://docs.github.com/en/graphql/overview/rate-limits-and-node-limits-for-the-graphql-api>
- Fine-grained permissions ("Starring"): <https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens>
- Managing PATs (expiry, `starring=read` prefill, org policy): <https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens>
- Token expiry/revocation: <https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/token-expiration-and-revocation>
- OAuth device flow (900 s codes, 50 submissions/h, `slow_down`): <https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps>
- OAuth scopes (`public_repo`/`repo`): <https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps>
- SSO authorizing PATs: <https://docs.github.com/en/authentication/authenticating-with-saml-single-sign-on/authorizing-a-personal-access-token-for-use-with-saml-single-sign-on>
- API versions (2022-11-28 default; 2026-03-10 current): <https://docs.github.com/en/rest/about-the-rest-api/api-versions>
- Workflows limits: <https://developers.cloudflare.com/workflows/reference/limits/> · API (`sleepUntil`, retries, restart, statuses): <https://developers.cloudflare.com/workflows/build/workers-api/> · retry defaults: <https://developers.cloudflare.com/workflows/build/sleeping-and-retrying/>
- Worker secrets: <https://developers.cloudflare.com/workers/configuration/secrets/>
- Cache API (per-colo, directives, Access caveat): <https://developers.cloudflare.com/workers/runtime-apis/cache/>
- Vectorize limits (upsert batch 1,000; 20M vectors): <https://developers.cloudflare.com/vectorize/platform/limits/>
