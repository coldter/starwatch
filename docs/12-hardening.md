# 12 — Hardening: Abuse, Quota Governance & Cost Guardrails

> ⚠️ **Superseded for the $0 launch by [14-abuse-protection.md](14-abuse-protection.md)** — free-primitive budgets, DO governors, quota-unit alarms, degradation ladder. Where this doc and [14] conflict before a paid upgrade, **[14] wins**; this doc remains the reference for the paid topology (Workers Paid CPU, paid Analytics Engine/Logs, zone-level WAF/Bot Fight Mode, Flagship, dollar budgets). Free-launch deltas: §0.0.

> Status: **draft for discussion** · 2026-09-13 · Cloudflare capabilities re-verified against live docs on this date; ⚠️ marks low-confidence items to re-check at implementation time.
> Scope: starwatch as a **public anonymous service** — anyone can trigger indexing for any public GitHub user, and anyone can run hybrid searches against it. This doc owns abuse mitigation, the shared GitHub token budget, per-query cost budgets, spend guardrails, privacy/legal hygiene, and runbooks (paid topology), and assumes/extends [00](00-requirements.md)–[07](07-search-contract.md). Companions: [08](08-public-service-ux.md) (UX), [09](09-public-data-and-limits.md) (GitHub budget), [10](10-multitenant-architecture.md) (architecture), [13](13-free-tier-feasibility.md)/[15](15-free-semantic-search.md) (free tier), [14](14-abuse-protection.md) (the $0 authority).
>
> **Updated 2026-09-13 (free-tier pivot):** see §0.0 for the deltas that apply while on Workers Free.

## 0. Assumptions & trust model

### 0.0 Free-tier deltas applied

- **Cost target:** $0 baseline on Workers Free; "abuse that costs > a few $/mo" becomes "abuse that exhausts free quotas" ([13 §4.2](13-free-tier-feasibility.md)); the $5/mo base returns only after the paid upgrade.
- **Admission:** `daily_new_indexes` becomes a **weighted** cap — ≤10 units/day (`w(u) = 1 + ceil(stars/1000)`), not 25 new indexes ([14 §3.6](14-abuse-protection.md)/[§4](14-abuse-protection.md)) — and the bind points are D1 rows written, Workflow steps and AI neurons before GitHub windows ([13 §2(b)](13-free-tier-feasibility.md)).
- **Caps:** free-mode caps are authoritative in [14 §3.6](14-abuse-protection.md): `MAX_STARS = 10,000`, newest-**1,500** semantic window, 64 KB/repo + 20 MB/user FTS, 50 full/warm indexed users. The larger values below are paid-topology defaults.
- **Alarms:** quota units (rows read/written, steps, neurons, dims, requests), not dollars — soft 50–80 %, hard 95 % + kill switches ([14 §3.5](14-abuse-protection.md)/[§5.3](14-abuse-protection.md)); Analytics Engine (100k points/day) and Workers Logs (200k events/day) are usable free with sampling ([14 §2.1](14-abuse-protection.md)).
- **Flags:** kill switches live in a Durable Object (`FeatureState`), not Flagship ([14 §0.1](14-abuse-protection.md)).
- **Edge:** `ratelimits` binding + Turnstile on index starts (day 1, not v1.1) replace WAF/Bot Fight Mode until a zone exists ([14 §2.2](14-abuse-protection.md)).
- **Sync:** per-user Workflows must chain ≤250-repo instances (free cap 1,024 steps/instance); the `GithubGovernor` (§2.1) still owns the 5,000/h token but admission is CF-headroom-first ([13 §2(b)](13-free-tier-feasibility.md), [15 §2.5](15-free-semantic-search.md)).
- **Semantic:** repo-level R2 blobs + in-Worker kNN replace Vectorize on free ([15 §1](15-free-semantic-search.md)); §3–§4 below are the paid path.

| #   | Assumption                                                                                                                                                                                                                  | Consequence                                                                                         |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| A1  | Anonymous public web UI + public HTTP API (`/api/search`, `/api/similar`, `/api/sync`, `/api/stats`)                                                                                                                        | Every endpoint is hostile-input and hostile-volume; no endpoint may trust a client-supplied cap     |
| A2  | One shared GitHub token (5,000 req/h core, 900 pts/min secondary)                                                                                                                                                           | GitHub budget is a **global serial resource**; all jobs must be admitted and paced by one authority |
| A3  | Public data only: star metadata + READMEs of public repos                                                                                                                                                                   | No private-repo indexing, no user OAuth, no secret in public responses                              |
| A4  | Owner/admin surface (kill switches, purge, cost ledger) stays behind Cloudflare Access                                                                                                                                      | Admin actions are authenticated; public surface never is                                            |
| A5  | $0 while on Workers Free (§0.0); the ~$5/mo baseline + single-digit marginal target ([00 R15](00-requirements.md)) is the paid-mode ceiling after upgrade ([13](13-free-tier-feasibility.md), [14](14-abuse-protection.md)) | Abuse that exhausts a finite free quota is a security incident, not a scaling event                 |
| A6  | Attackers can mint GitHub accounts and stars cheaply                                                                                                                                                                        | Popularity/star count is **not** a trust signal and must not buy priority or budget                 |

**Current CF primitives inventory (verified 2026-09-13):**

| Primitive                         | What it is                                                                                                                                                                           | Limits that bind us                                                                                                                                                                                                                                                                                 | Where used                                                    |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Workers `ratelimits` binding      | In-Worker token bucket, same infra as WAF rate limiting rules; config `{namespace_id, simple:{limit, period}}`, call `env.X.limit({key}) → {success}`                                | `period` must be **10 or 60 s only**; counters are **per Cloudflare location**, eventually consistent, "not an accurate accounting system"; config counts are not dashboard-visible ⚠️ no documented max bindings/limit value                                                                       | Per-IP burst control on search/trigger                        |
| WAF rate limiting rules           | Zone-level rules in the new security dashboard: expression + characteristics + period + mitigation                                                                                   | **Requires a proxied zone (custom domain)**; Free: **1 rule, 10 s window/counting, IP only, 10 s mitigation**; Pro: 2 rules, windows ≤ 1 min, fields + method/UA; custom counting expression from Business up                                                                                       | Later (needs custom domain)                                   |
| Turnstile                         | Privacy-preserving challenge; client widget + **mandatory server-side Siteverify**                                                                                                   | Free plan: **20 widgets, unlimited challenges**, 10 hostnames/widget, 7-day analytics; token valid **300 s, single-use**; Enterprise only adds ephemeral IDs/branding                                                                                                                               | Sync triggers, purge challenge, optional search-after-N       |
| Bot Fight Mode (Bots Free)        | Challenges simple bots from hosting/headless browsers; domain-wide, zone-required; includes Block-AI-bots, AI Labyrinth, managed `robots.txt`                                        | No fine-grained control; can challenge legitimate API clients ⚠️ test CLI path                                                                                                                                                                                                                      | Later (needs custom domain)                                   |
| Workers Cache                     | Response cache in front of the Worker; **tiered by default**, **request collapsing** per cache key per colo                                                                          | Key = entrypoint + **path + query string (order-sensitive)** + Worker version + `ctx.props` (service-binding calls); `Authorization`/`Set-Cookie` auto-bypass; `cf.cacheKey` honored only on same-account loopback; `ctx.cache.purge({tags, …})`; billed at standard request rate, CPU only on miss | Anonymous search/browse caching                               |
| Cache API (`caches.default`)      | Programmatic per-colo cache, explicit key, 512 MB/object, 1,000 calls/request, no request collapsing; not available when fronted by Access ([03 §2c](03-sync-and-limits.md))         | Secondary fallback where an explicit hash key is needed                                                                                                                                                                                                                                             | Keyword/browse cache fallback                                 |
| Durable Objects (SQLite)          | Single-threaded coordinator with transactional storage; alarms                                                                                                                       | 1M req + 400k GB-s/mo included; storage $0.20/GB-mo                                                                                                                                                                                                                                                 | GitHub token budget, global search budget, abuse counters     |
| Cloudflare Queues                 | Durable job buffer; batch ≤ 100 msgs, 128 KB/msg, **25 GB backlog/queue**, 5,000 msg/s, retention ≤ 14 d, 250 concurrent push consumers                                              | Backlog metrics via `queuesBacklogAdaptiveGroups`, `queueConsumerMetricsAdaptiveGroups`, `queueMessageOperationsAdaptiveGroups`, and `metrics()` (realtime `backlog_count`)                                                                                                                         | Sync-request admission control                                |
| AI Gateway (+ Workers AI binding) | `env.AI.run(model, input, {gateway:{id, cacheKey, cacheTtl, skipCache, metadata}})`; per-gateway **fixed/sliding rate limiting** → 429; exact-match response caching; cost analytics | Caching exact-match only; rate limit is **uniform per gateway**, not per user                                                                                                                                                                                                                       | Global semantic cap, embedding/rerank cost tracking + caching |
| Cloudflare Flagship               | Feature flags with a native Workers binding (`env.FLAGS.getBooleanValue("x", false, {userId})`), KV-backed, dashboard-managed                                                        | ⚠️ New (docs 2026-06); plan availability/pricing unverified                                                                                                                                                                                                                                         | Kill switches                                                 |
| Analytics Engine                  | `writeDataPoint()` from Workers + SQL API                                                                                                                                            | Paid: 10M points/mo + 1M read queries included (not yet billed as of Apr 2026); **free: 100k points/day + 10k read queries/day** ([14 §2.1](14-abuse-protection.md))                                                                                                                                | Custom metrics/abuse forensics (sample aggressively on free)  |
| Workers Logs                      | Invocation logs                                                                                                                                                                      | Paid: 20M events/mo + $0.60/M, 7-day retention                                                                                                                                                                                                                                                      | Debug/audit                                                   |

Cost anchors used below: bge-m3 $0.012/M tokens (1,075 neurons/M); reranker $0.003/M tokens; Workers AI free tier 10,000 neurons/day; Vectorize $0.01/M queried dims + $0.05/100M stored dims/mo; Workers 10M req + 30M CPU-ms included, then $0.30/M req + $0.02/M CPU-ms.

## 1. Abuse vectors → mitigations

**Layering rule:** edge controls (`ratelimits`, Bot Fight Mode) absorb crude floods; **Durable Object budgets are authoritative** for anything that costs real money or GitHub quota; Turnstile gates work that is worth challenging. Never rely on a client-side or per-colo counter for a global budget.

| #   | Vector                                      | Primary mitigation                                                          | Backstop                                                |
| --- | ------------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------- |
| V1  | Sync-trigger flood (thousands of usernames) | Turnstile + per-IP binding + queue admission + dedupe                       | Global daily new-index cap; DO budget                   |
| V2  | Huge-star account (50k–200k stars)          | Page cap (5,000 stars listed), README cap (1,500 newest), chunk/vector caps | Metadata-only above cap; per-user cost ledger           |
| V3  | Query flooding (semantic + rerank)          | Per-IP binding + DO global semantic bucket + AI Gateway rate limit          | Degraded keyword-only mode                              |
| V4  | Cache-busting (`&_=random`)                 | Canonical key via loopback entrypoint; ignore unknown params                | Per-IP budget; request collapsing                       |
| V5  | Scraping our API                            | `robots.txt` + `X-Robots-Tag` + no bulk-export endpoint + caps              | IP/ASN rate limits; Bot Fight Mode later                |
| V6  | Griefing/heavy users                        | Per-username ledger + eviction + no priority for size                       | Global caps + kill switches                             |
| V7  | Coordinated bots (distributed IPs)          | Global DO buckets + aging/FCFS fairness + Turnstile escalation              | ASN heuristics in Analytics Engine; WAF ASN rules later |

### 1.1 V1 — Sync-trigger floods

- **Validate before spending anything.** `login` must match `^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$`; reject reserved names (`settings`, `orgs`, `explore`, …); reject if the public profile 404s (1 cheap request, cached 24 h). Do this **before** Turnstile/siteverify cost is incurred where possible.
- **Turnstile on `POST /api/sync`** (client widget; server calls `https://challenges.cloudflare.com/turnstile/v0/siteverify` with `secret`, `response`, `remoteip`, optional `idempotency_key`; verify `success && hostname === expected && action === "sync"`). Tokens are single-use and expire in 300 s — no replay.
- **Edge burst:** `ratelimits` binding `SYNC_IP` `{limit: 3, period: 60}` keyed by salted IP hash; a second binding `{limit: 10, period: 60}` per `login` for trigger spam across IPs.
- **Admission control (authoritative).** `POST /api/sync` only writes a row to `sync_requests` and enqueues to the `sync-queue` Queue. A single `SyncScheduler` DO consumes admission: if `daily_new_indexes < cap` and `queued < max_queued` and `active < 2`, it starts the per-user Workflow; otherwise the request stays queued or is rejected with `503 + Retry-After` when the queue is over cap.
- **Dedupe + cooldown.** `sync_requests.login` is `PRIMARY KEY`; a pending/in-flight row returns `202 {run_id, state, position}` instead of starting a second job. Re-index allowed only after 24 h (`last_success_at`) or when the user's data is stale by > 7 days; evicted users may re-trigger once.
- **Queue caps.** Own cap `max_queued = 200` (Queue hard limit is 25 GB backlog, ~200k messages) — enforce ours well below it and alert at 10% of the Queue backlog metric (`queuesBacklogAdaptiveGroups`, `messages`).
- **UI when saturated:** the trigger page shows `position`, `ETA` (from rolling throughput), and if over cap a 503 page: “starwatch is at indexing capacity today — try again after 03:00 UTC”. The API returns `Retry-After: 3600`.

### 1.2 V2 — Huge-star accounts

- Listing is `GET /users/{login}/starred?per_page=100&sort=created&direction=desc` (public; **not** affected by the 2026-06-30 stargazers restriction, which covers `/repos/{o}/{r}/stargazers` — never call that). 100k stars = 1,000 listing pages = 20% of an hourly window before a single README.
- **Caps (proposed defaults, configurable):** `MAX_LIST_PAGES = 50` (5,000 stars) → 50 requests; `MAX_README_FETCHES = 1,500` (newest-first by `starred_at`); beyond that the user is `index_state = 'metadata'`; README truncation at 1 MB; `MAX_CHUNKS_PER_REPO = 40`; `MAX_VECTORS_PER_USER = 25,000`. **Free-mode caps are authoritative in [14 §3.6](14-abuse-protection.md):** `MAX_STARS = 10,000`, semantic window newest 1,500, 64 KB/repo + 20 MB/user FTS, 50 full/warm users; the values in this bullet are paid-topology defaults.
- **Cost of a capped index:** 50 listing + 1,500 README + ~200 embed/upsert calls ≈ 1,750 requests (~35% of one window) and ~~3M embedding tokens (~~$0.04). At `active_jobs ≤ 2` and `daily_new_indexes ≤ 25`, GitHub budget and AI spend stay bounded.
- The UI marks capped users: “metadata-only index for accounts with > 5,000 stars”.
- Cooldown for capped users is longer (7 days) because a re-check still costs 50 listing requests.

### 1.3 V3 — Query flooding

- **Per-IP binding** (salted hash, rotated daily): `SEARCH_IP` `{limit: 30, period: 60}` for keyword/browse, and a second binding `{limit: 6, period: 60}` for hybrid/semantic/similar. Bindings are per-colo — they catch local floods, the DO catches the rest.
- **Global semantic bucket** in `SearchBudget` DO: refill 300 tokens/min (burst 60); every hybrid/semantic query takes 1 token, rerank takes 1 more. Exhaustion → degraded mode (§3.2), not 500.
- **AI Gateway backstop:** gateway rate limit 600 req/min (fixed or sliding, uniform for the gateway) so that a bug in our own accounting cannot run away; a gateway 429 immediately flips the Worker into keyword-only.
- **Anonymous requests are cheap to serve from cache** (§3.3) — a flood of identical queries is collapsed by Workers Cache before the Worker runs.
- Serve `429` with `Retry-After` and `X-Starwatch-Limit: <binding>` so CLI (`05`) can print an actionable message; never leak the exact remaining count.

### 1.4 V4 — Cache-busting

- Naive response caching keyed on the raw URL is undone by `?q=x&_=$RANDOM`. Two defenses:
  1. **Parse strictly.** Search accepts only the documented params from [07 §4.5](07-search-contract.md); unknown params are ignored (and a `400` returned when `strict=1` for debug). Param order and casing are canonicalized; the canonical string + index version + embed model version is hashed to the cache key.
  2. **Loopback caching.** Public `/api/search` is a gateway entrypoint (caching disabled) that normalizes the request and calls the cached `SearchBackend` entrypoint via `ctx.exports` with `cf: { cacheKey: <sha256> }`. Workers Cache honors `cf.cacheKey` on same-account loopback, so busting URLs still map to one entry. Tag responses `Cache-Tag: search,index-{version}` and purge by tag after each sync.
- **Don't over-cache:** only anonymous requests with no `Authorization`; only GET; TTL 60 s (browse) to 300 s (keyword/hybrid); never cache when the index is mid-change or a user has a per-user overlay.
- If loopback caching proves awkward, fall back to Cache API with the same explicit hash key at the cost of losing tiering and request collapsing ⚠️.

### 1.5 V5 — Scraping our API

- `robots.txt`: `User-agent: *` → `Disallow: /api/`; `Allow: /`; sitemap for public pages. Add `X-Robots-Tag: noindex, nofollow` on API responses. This is etiquette + cost reduction, not protection (public repo data is already public).
- **No bulk export endpoint in v1**, no `limit > 100`, no unbounded pagination for semantic results (§3.4). The public API answers a question; it is not a dataset dump.
- Scrapers are tolerated at the same per-IP budget as users; aggressive ones get a longer mitigation via a second binding profile keyed by UA + IP hash, and — once a zone exists — a WAF rate limiting rule. Bot Fight Mode challenges simple bots domain-wide; test that it does not break the CLI/Access service-token path before enabling ⚠️.
- Attribution + ToS language (§5.4) makes the permitted use explicit.

### 1.6 V6 — Griefing/heavy users

- **Per-username cost ledger** in D1 (`user_costs(username, day, embed_tokens, rerank_tokens, vector_dims, github_requests, searches)`). If a user exceeds its daily share, its index is demoted (metadata-only / semantic off for that user) rather than deleted.
- **Eviction:** users with no search traffic for 180 days are purged (§5.5); indices over the global cap are evicted oldest-inactive first. Eviction is announced on the repo page before and after.
- No user can monopolize the queue: one active job + one queued job per username; owner/admin work is the only priority class.

### 1.7 V7 — Coordinated bots

- Distributed IPs defeat per-IP limits by design; the **global DO buckets** are the real defense (semantic/min, index-start/day, GitHub requests/hour).
- Analytics Engine events record `ip_hash`, `asn`, `ua_family`, `route`, `outcome`; an hourly cron looks for (a) > N distinct IPs hitting `/api/sync` with Turnstile failures, (b) > N% 429 ratio, (c) single ASN > X% of semantic spend. Matching patterns trigger manual tightening (flag + deploy) or, later, a WAF ASN rule (Pro+).
- Turnstile escalation: if the global abuse score is elevated, require Turnstile for all anonymous searches above N/day/IP (widget remains invisible for most humans).

### 1.8 Code-level hooks (sketch, exact shapes)

```jsonc
// wrangler.jsonc — edge bursts (per-colo, eventual), plus queue bindings
{
  "ratelimits": [
    {
      "name": "SEARCH_BURST",
      "namespace_id": "1201",
      "simple": { "limit": 30, "period": 60 },
    },
    {
      "name": "SEMANTIC_BURST",
      "namespace_id": "1202",
      "simple": { "limit": 6, "period": 60 },
    },
    {
      "name": "SYNC_BURST",
      "namespace_id": "1203",
      "simple": { "limit": 3, "period": 60 },
    },
  ],
  "queues": {
    "producers": [{ "binding": "SYNC_QUEUE", "queue": "sync-queue" }],
  },
  "durable_objects": {
    "bindings": [
      { "name": "GITHUB_QUOTA", "class_name": "GithubQuota" },
      { "name": "SEARCH_BUDGET", "class_name": "SearchBudget" },
    ],
  },
  "flagship": [{ "binding": "FLAGS", "app_id": "<APP_ID>" }],
}
```

```ts
// per-request gate (Effect: wrap in Effect.tryPromise in the cloudflare package)
const key = await saltedIpHash(req); // rotate salt daily; never store raw IP
const { success } = await env.SEMANTIC_BURST.limit({ key }); // 6/60s per colo
if (!success)
  return new Response(null, { status: 429, headers: { "Retry-After": "60" } });

// authoritative global budget (single DO)
const budget = env.SEARCH_BUDGET.get(env.SEARCH_BUDGET.idFromName("global"));
const gate = await budget.acquire({
  semantic: 1,
  rerank: mode !== "known-item",
});
if (!gate.ok) return degradedKeyword(req, { reason: "budget" });
```

```ts
// Turnstile: mandatory server-side validation before enqueueing a sync
const r = await fetch(
  "https://challenges.cloudflare.com/turnstile/v0/siteverify",
  {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      secret: env.TURNSTILE_SECRET,
      response: token,
      remoteip: ip,
    }),
  },
);
const v = await r.json();
if (!v.success || v.action !== "sync" || v.hostname !== PUBLIC_HOST)
  return badRequest();
```

## 2. Global GitHub quota governance

### 2.1 One authority: `GithubQuota` DO

All GitHub calls made on behalf of any user go through a single Durable Object instance (`idFromName("github")`) so counters are globally serial. State persisted in DO SQLite, mirrored to D1 for the UI:

- **Primary window:** authoritative `remaining`/`reset_at` from the last observed `x-ratelimit-*` headers (never assumed from wall clock). `reserve(200)` keeps a floor for owner/interactive syncs; anonymous work stops reserving when `remaining - n < 200`.
- **Secondary pacing:** token bucket 700 req/min (below the documented 900 pts/min) + concurrency semaphore `max_in_flight = 5`; on `403/429` with `retry-after`, the DO sets a global pause until that time and halves the refill for 10 min ([03 §1.3](03-sync-and-limits.md)).
- **Persistent concurrency slots:** jobs run in Workflow steps, each potentially a separate invocation, so slots are leased from the DO (lease TTL 60 s, renewed per batch) rather than process-local.
- **`acquire(n, klass)`** returns `{ok, waitMs}`; callers `Effect.sleep`/`step.sleepUntil` and retry. `observe(headers)` is called after every GitHub response.
- **Quota exhaustion:** DO sets `paused_until = reset + 30s`; in-flight steps checkpoint and sleep (`paused_rate_limit` state, [03 §4.4](03-sync-and-limits.md)); no retry storms. UI shows “paused — resumes 11:23 UTC”. DO alarm re-opens the budget even if no job is awake.

### 2.2 Fairness

**Decision: strict FCFS + aging, not popularity priority.** Star count is attacker-controlled (A6) and popular accounts are the most expensive (V2), so “priority to popular” is precisely backwards. Concretely:

1. Public jobs FCFS from the `sync-queue`, one active + one queued per user.
2. **Aging:** after 15 min queued, a job is promoted to the interactive lane (small max slots) so large backfills cannot starve small users.
3. **Owner reserve:** nightly owner sync has a reserved 800-request window at 03:00 UTC; anonymous work uses the rest.
4. **Recently searched** users get _re-prioritized on staleness_, not on popularity: a re-sync for a user whose index is > 7 days stale jumps the FCFS queue.
5. Starvation can't persist because every job is capped (V2) and the daily new-index cap is a global ceiling, not per-user.

### 2.3 Dedupe, cooldowns, caps

| Control         | Rule                                                                                                                                                                   |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dedupe          | `sync_requests.login` unique; `INSERT … ON CONFLICT` → join existing run; Queue consumers are idempotent by `login + requested_at`                                     |
| Cooldown        | initial index once; re-index after 24 h (normal) / 7 d (capped account); owner bypass                                                                                  |
| Queue depth     | own `max_queued = 200`; alert at backlog > 50 messages or > 500 MB (GraphQL/`metrics()`)                                                                               |
| Active jobs     | `active ≤ 2` public + 1 owner                                                                                                                                          |
| New indexes/day | Paid: `daily_new_indexes ≤ 25` (≈ $1 embedding + ~44k GitHub requests ≈ 9 hourly windows/day). Free ($0): ≤**10 weighted units/day** ([14 §4](14-abuse-protection.md)) |
| GitHub reserve  | anonymous work may not consume the last 200 requests of a window                                                                                                       |

### 2.4 What the UI shows

`GET /api/quota` returns `{ github: {remaining, reset_at, paused}, queue: {depth, position?, eta_s}, caps: {new_indexes_today, max}, state }`. The sync page renders queue position and ETA; under saturation it shows the 503 message from §1.1 and disables the trigger button. CLI `status` prints the same fields ([05 §3.1](05-cli.md)).

## 3. Query cost budgets

### 3.1 Budgets (proposed defaults, all server-side)

| Layer                         | Keyword / browse | Hybrid / semantic    | Similar       | Where enforced                                      |
| ----------------------------- | ---------------- | -------------------- | ------------- | --------------------------------------------------- |
| Per IP-hash burst             | 30/60 s          | 6/60 s               | 6/60 s        | `ratelimits` bindings                               |
| Per IP-hash sustained ⚠️      | 300/h, 1,000/day | 60/h, 200/day        | 60/h, 100/day | Sharded `AbuseCounters` DO per IP shard, daily keys |
| Per user (API key, v2)        | 60/min           | 30/min               | 30/min        | DO keyed by key id                                  |
| Global semantic               | —                | 300/min, burst 60    | 300/min       | `SearchBudget` DO                                   |
| Global rerank                 | —                | 120/min              | —             | `SearchBudget` DO                                   |
| Global AI requests (backstop) | —                | 600/min gateway-wide | —             | AI Gateway rate limit                               |

Budget refill uses monotonic time in the DO; the DO also records cumulative usage so `cost_ledger` stays authoritative even when Analytics Engine points are sampled.

### 3.2 Degraded mode — exact triggers

Enter **keyword-only** when any of:

1. AI Gateway returns 429, or Workers AI returns 429/5xx for embedding/rerank (after 1 retry with 250 ms backoff);
2. `SearchBudget.semantic_tokens ≤ 0` (global cap reached in this minute);
3. monthly AI spend ledger ≥ **50%** of the soft budget (rerank off) or ≥ **80%** (semantic off) — the same thresholds as §4.3;
4. p95 semantic latency > 1.5 s over the last 5 min (rolling, computed from Analytics Engine events) ⚠️ optional auto-trigger, default on.

Exit when the trigger is clear for 60 s (hysteresis). Responses carry `X-Starwatch-Mode: keyword; degraded=<reason>`; the WebUI shows the slim banner from [06 §3](06-webui.md); an explicit `--mode semantic` request returns `503` with the reason instead of silently degrading.

### 3.3 Response caching

- **Anonymous GET search/similar/browse** is cached by Workers Cache through the normalization loopback of §1.4: key = `sha256(canonicalParams + index_version + embed_model_version + rerank_flag)`. TTL: browse 60 s; keyword 300 s; hybrid 300 s; `similar` 300 s. Purge `Cache-Tag: index-{version}` after each successful sync so results never outlive the index.
- Same index snapshot ⇒ byte-identical browse responses (already [07](07-search-contract.md) Q6); caching makes that free.
- Cache hit stats from `Cf-Cache-Status`; target ≥ 60% for anonymous traffic; a sudden drop to < 20% with flat traffic is an abuse signal (V4/V7).
- CLI/Access requests carry `Authorization` → Workers Cache bypasses them automatically; their repeated queries are still deduped by the Cache API fallback ⚠️ if it proves worth it.

### 3.4 Server-side caps (never trust the client)

| Parameter        | Clamp                                                          |
| ---------------- | -------------------------------------------------------------- |
| `q`              | 512 chars / 64 tokens ([07 §7.6](07-search-contract.md))       |
| `limit`          | 1–50 hybrid/semantic; 1–100 keyword/browse                     |
| `--rerank-depth` | ≤ 50; passages ≤ 60                                            |
| `filters`        | ≤ 8 distinct facets, each ≤ 20 values                          |
| `page`           | hybrid/semantic ≤ 1 (top-50 ceiling); keyword keyset-paginated |
| `mode`           | unknown → `400`; `semantic` while degraded → `503`             |

## 4. Cost guardrails

### 4.1 Per-user index caps

Metadata-only above 5,000 stars; ≤ 40 chunks/repo; ≤ 25,000 vectors/user; ≤ 1 MB README/repo (truncate); embed only changed chunks (hash-based, [02 §5](02-stack-and-pipeline.md)); rerank never runs at index time. A capped index costs ≤ ~$0.04 one-time and ~$0.01/mo stored dims. **Free-mode caps are stricter and authoritative:** `MAX_STARS = 10,000`, semantic window newest 1,500 repos (repo-level vectors), 64 KB/repo + 20 MB/user FTS, 50 full/warm users ([14 §3.6](14-abuse-protection.md)); the 5,000-star/40-chunk/25k-vector values above are paid-topology defaults. Global ceiling `MAX_USERS = 1,000` ⇒ ≤ 25M vectors, which **exceeds Vectorize's 20M vectors/index** — decide the shard strategy before the first non-owner user (N indexes or lower per-user cap; retrofitting is a full re-upsert ⚠️).

### 4.2 Spend visibility

| Source                       | What it gives                                                                                 | Notes                                                                                                                  |
| ---------------------------- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `cost_ledger` (D1)           | Per-user/per-day tokens, dims, requests, computed $ using pinned rates                        | Authoritative for caps and alarms; small writes, batched                                                               |
| AI Gateway analytics + costs | Per-gateway request counts, errors, cost estimates, logs (`env.AI.aiGatewayLogId`)            | Best UI for AI spend; set `metadata: {user, route}` on every run ⚠️ cost figures are estimates                         |
| Workers AI dashboard         | Neuron usage/day (free-tier headroom)                                                         | No documented GraphQL dataset for neurons ⚠️ verify before dashboards depend on it                                     |
| GraphQL Analytics API        | D1 (`d1AnalyticsAdaptiveGroups`), Queues (`queuesBacklogAdaptiveGroups`, …), Workers requests | 31-day retention for D1 metrics                                                                                        |
| Cloudflare Notifications     | Usage-based billing alerts                                                                    | Requires **Professional plan or higher** + pay-as-you-go — likely unavailable on Workers Paid ⚠️; build our own alerts |

### 4.3 Alarms, soft/hard budgets

- **Budget model:** base $5 (plan) + marginal allowance $10/mo (proposed). Ledger projects month-end spend from a 7-day rolling rate.
- **Soft (50%):** notify (cron webhook + GitHub issue), turn off rerank for anonymous traffic.
- **Soft-high (80%):** semantic off for anonymous users; indexing paused for new users; owner-only search stays full.
- **Hard (100%):** all anonymous AI + sync triggers off; keyword/browse stay up; a human must raise the cap or flip the switch back. Enforced by the same flags as §4.4, checked at request time, so it takes effect without deploy latency.
- Alert delivery: hourly `starwatch-alerts` cron reads Analytics Engine SQL + D1 ledger + Queue GraphQL; posts to Slack/Discord/ntfy webhook and opens/closes a repo issue as the durable inbox.

### 4.4 Kill switches

Flagship flags (dashboard-flippable, no deploy), fetched per request with safe defaults:

| Flag              | Default  | Effect when false                                                  |
| ----------------- | -------- | ------------------------------------------------------------------ |
| `public_search`   | true     | Whole public API returns 503 (owner Access path unaffected)        |
| `semantic`        | true     | Hybrid falls back to keyword; explicit semantic → 503              |
| `rerank`          | true     | Skips rerank stage; latency and cost drop                          |
| `public_sync`     | true     | `POST /api/sync` returns 503; queued jobs still drain              |
| `index_new_users` | true     | Existing users can re-sync; no new usernames                       |
| `spend_mode`      | `normal` | `conservative` = caps at 50% targets; `frozen` = semantic+sync off |

Fallback when Flagship is unavailable or misconfigured: (1) DO `FeatureState` row read at request time (no deploy, single point of truth if Flagship down), (2) `wrangler` vars + deploy (minutes), (3) AI Gateway rate limit set to its minimum (immediate, coarse). Document the order in the runbook and test it once in staging ⚠️.

## 5. Data hygiene, privacy & legal light-touch

### 5.1 Public data only

Index only public repos: `/users/{login}/starred` returns public stars for any user; the shared token must not have private-repo grants, and the indexer must skip a private fork if one slips through (`repo.private === true` → store metadata but no README, no vectors, no snippet). The owner's own private stars are out of scope for the public service; if ever indexed, they stay behind Access and are excluded from public search.

### 5.2 Owner purge flow (no login)

1. `POST /api/purge {login}` → Turnstile-checked, rate-limited; returns `{challenge, expires_at}` (random 256-bit token, 24 h TTL).
2. Owner proves control by publishing the token where the public GitHub API can see it: **preferred** a public gist named `starwatch-purge.txt` authored by `login`, **or** the token appears in the profile bio. Both are verifiable with unauthenticated reads (`GET /users/{login}`, `GET /users/{login}/gists`), no OAuth needed.
3. `POST /api/purge/confirm {login, challenge}` verifies token↔account, then enqueues a purge job: D1 row + chunks + FTS entries deleted; `vectorize.deleteByIds(all user ids)`; R2 objects deleted; ledger kept as aggregates only. Completes within 24 h and is confirmed on the challenge page.
4. Fallback for edge cases (deleted account): a manual email address in the footer, same SLA. Abuse of the flow is capped (10 challenges/day/IP); a challenge never triggers more than one purge.

### 5.3 Eviction/deletion of inactive users

`users.last_searched_at` drives eviction: no reads for 180 days or global cap pressure → purge as above (announced on the repo page 14 days prior where possible). Unstarred repos inside a user index follow the 90-day soft-delete then hard purge rule ([03 §4.3](03-sync-and-limits.md)). IP hashes rotate daily and are deleted after 30 days; Workers Logs retention is 7 days.

### 5.4 Public pages: robots, XSS, headers, attribution

- `robots.txt` + `sitemap.xml` generated as static assets; `X-Robots-Tag: noindex` on API.
- **README is untrusted.** Server never renders stored README HTML; the WebUI uses `react-markdown` + `remark-gfm` + `rehype-sanitize` (GitHub schema), `skipHtml`, external links `rel="noopener noreferrer"`, remote images opt-in ([06 §4](06-webui.md)). If we ever server-render for social cards/bots, sanitize with the same schema before output. Snippets are pre-escaped with only `<mark>` ([07 §6](07-search-contract.md)).
- **CSP/security headers** via `_headers` on the static assets ([06 §8.1](06-webui.md)): `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' https://avatars.githubusercontent.com https://raw.githubusercontent.com data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'` plus `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy` minimal, HSTS. Escape all user-facing strings (repo descriptions, topics) — they are third-party content.
- **Attribution:** footer + about page: “Search over public GitHub stars. Data from GitHub. starwatch is not affiliated with or endorsed by GitHub.” Link the source repo and the GitHub ToS. No “GitHub” in the product name/logo; no implying partnership; star counts and metadata carry `source: github` in the JSON.

### 5.5 Flow-down from GitHub changes

If GitHub restricts `/users/{login}/starred` the way it restricted stargazers (2026-06-30), indexing public users stops working. Detection: 403/404 rate spike on the listing endpoint. Response: `index_new_users=false`, keep serving cached indices, add the status to the site banner. This is an accepted platform risk, not something code can route around.

## 6. Observability & runbooks

### 6.1 Metrics → source → alert

| Metric                                                      | Source                                                                           | Alert threshold (proposed)                                                    |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Queue depth / oldest message age                            | Queue `metrics()` + `queuesBacklogAdaptiveGroups`                                | > 50 msgs or > 30 min lag (warn); > 150 (page)                                |
| Sync success/failure by class, phase duration               | `sync_runs` + Analytics Engine `sync_result`                                     | 3 consecutive failures of the nightly owner sync; public failure rate > 20%/h |
| GitHub `remaining`/`reset`, 403/429, secondary hits         | DO state + `sync_runs`                                                           | remaining < 500 before 03:00 UTC; any secondary hit > 5/h                     |
| Semantic/rerank tokens, $/day, degraded activations         | ledger + AE `search_result`                                                      | degraded on > 5% of queries over 15 min; projected month > soft cap           |
| p50/p95 latency by mode, error rate by status               | AE `search_result` (or Logpush→Grafana/Axiom, [02 §7](02-stack-and-pipeline.md)) | p95 > 700 ms or 5xx > 1% over 5 min                                           |
| 429s by binding/route, Turnstile failures, distinct IPs/ASN | AE `abuse_event`                                                                 | 429 ratio > 20%/5 min; Turnstile failure > 50/min                             |
| Cost per endpoint/day                                       | ledger + AI Gateway analytics                                                    | week-over-week +50%                                                           |

Every event carries `route`, `outcome`, `ms`, `mode`, `ip_hash` (never raw IP), `user_login`, `index_version`; written with one `writeDataPoint()` per request in a `ctx.waitUntil` batch.

### 6.2 Runbooks

1. **GitHub token exhausted / secondary limit.** Confirm via `GET /rate_limit` (≤1/5 min) and headers; DO is already pausing. Check for a runaway job (`active_jobs`, recent `sync_runs`); cancel it (`instance.terminate()`), verify `reserve` floor held, let `paused_rate_limit` resume at reset. If repeated, lower per-window caps and raise the reserve.
2. **Vectorize/D1 degradation.** Vectorize errors/timeouts → semantic off automatically (§3.2); verify Cloudflare status page, keep keyword/browse serving from cache. D1 “overloaded”/slow → shed writes first (defer sync checkpoints), then disable browse facets; read replicas are a later fix. Both: post the site banner; never return empty results silently.
3. **Abuse spike.** Pull AE by ASN/UA/route; identify the cheapest effective tightening (429 profile → Turnstile escalation → `public_sync=false` for trigger abuse → `semantic=false` for query abuse). If a zone exists, add a WAF rule; if not, deploy new binding limits. Record the incident in the repo issue; add a regression test/eval note.
4. **Cost spike.** Check ledger by user/route and AI Gateway analytics. Freeze `rerank`, then `semantic`, then `public_sync`. Find the user responsible (ledger, AE) and demote/evict. Raise alarms earlier for next time. Never “wait and see” past the hard cap.
5. **Index corruption.** Symptoms: repo/vector count mismatch, FTS errors, golden-set regression ([07 §3.5](07-search-contract.md)) without a code change. Triage: compare `repos`/`chunks`/Vectorize counts; D1 Time Travel restore to a known point (30 days paid) for DB-side corruption; re-chunk + re-embed from R2 (no GitHub refetch) for vector-side corruption; re-upsert in batches by `repo_id`. Gate recovery with the golden set before re-enabling semantic.

## 7. v1 minimum hardening checklist (ship-blocking) vs later

**Ship-blocking (paid mode; the $0 launch checklist is [14 §6](14-abuse-protection.md)):**

1. Server-side caps (§3.4) + 15 s search timeout; no client-trusted limit.
2. `ratelimits` bindings on search (per IP-hash) and sync trigger.
3. `GithubQuota` DO: reserve, pacing, concurrency leases, pause/resume; `SyncScheduler` admission + dedupe + cooldowns + queue cap.
4. `SearchBudget` DO global semantic/rerank caps + AI Gateway rate limit; degraded keyword mode with the triggers from §3.2.
5. Turnstile on `POST /api/sync`; login validation.
6. Per-user index caps (§4.1); metadata-only path; global new-index/day cap.
7. Anonymous response caching via Workers Cache + canonical key + purge-on-sync tag.
8. Cost ledger + hourly alarm cron + soft/hard budget flags.
9. Kill switches (`public_search`, `semantic`, `rerank`, `public_sync`, `index_new_users`) with DO fallback path tested.
10. README sanitization, CSP/security headers, robots/sitemap/noindex, attribution.
11. Purge challenge flow + eviction job + IP-hash retention policy.
12. Dashboards (AE SQL saved queries) + runbooks above, linked from README.

**Later:** custom domain + WAF rate limiting rules + Bot Fight Mode; per-user API keys with quotas (CLI/MCP); priority lanes; second GitHub token pool (multiple PATs debit the same account bucket — no gain ⚠️, so this means a GitHub App or multiple accounts, not v1); D1 read replicas; per-ASN rules; budget notifications via Cloudflare Notifications (needs Pro+); automatic abuse scoring with Turnstile escalation.

## 8. Open questions

1. **Public scope — resolved.** Index any valid public username on demand; no allowlist ([08 §2.2](08-public-service-ux.md), [14 §3.3](14-abuse-protection.md)).
2. **Budget numbers — deferred to paid mode.** $10 marginal soft / $25 hard once upgraded; free-mode knobs are quota units in [14 §4](14-abuse-protection.md).
3. **Turnstile on search? — resolved for the $0 launch.** Sync/purge only; search stays uncaptchaed ([14 §6](14-abuse-protection.md)).
4. **Custom domain — resolved for the $0 launch.** `workers.dev`, no zone ([13 §3](13-free-tier-feasibility.md)); revisit only if abuse demands a WAF.
5. **API keys.** Still open (paid mode).
6. **Eviction policy — resolved for the $0 launch.** 50 full/warm user soft cap with LRU demotion/eviction ([14 §3.6](14-abuse-protection.md), [10 §6](10-multitenant-architecture.md)); aggregate-retention detail still open.
7. **Flagship dependency — resolved for the $0 launch.** DO `FeatureState` is primary; Flagship is a paid-mode option ([14 §0.1](14-abuse-protection.md)).
8. **GitHub App — resolved.** No scaling for arbitrary public users; one 5,000/h token with ETag/dedupe ([09 §4.2](09-public-data-and-limits.md)).
9. **Vectorize sharding — resolved for the $0 launch.** Not used on free ([15 §1](15-free-semantic-search.md)); paid path per [10 §3.2](10-multitenant-architecture.md).
10. **Retention.** 7-day logs / 30-day IP hashes / 90-day unstar / 180-day inactivity — confirm before publishing the privacy note (free-mode caps may shorten these; [14 §3.6](14-abuse-protection.md)).

## Sources (verified 2026-09-13)

- Workers Rate Limiting binding (exists; `ratelimits`, `simple.limit/period`, per-location, eventually consistent): <https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/> (docs updated 2026-04-23)
- WAF rate limiting rules + plan availability table: <https://developers.cloudflare.com/waf/rate-limiting-rules/> (updated 2026-08-25)
- Turnstile overview/plans + Siteverify token semantics (300 s, single-use): <https://developers.cloudflare.com/turnstile/> · <https://developers.cloudflare.com/turnstile/plans/> · <https://developers.cloudflare.com/turnstile/get-started/server-side-validation/>
- Workers Cache (tiered, request collapsing, pricing) + cache keys (`cf.cacheKey`, Authorization bypass, `ctx.cache.purge`): <https://developers.cloudflare.com/workers/cache/> · <https://developers.cloudflare.com/workers/cache/cache-keys/>
- Cache API headers/limits: <https://developers.cloudflare.com/workers/runtime-apis/cache/> · limits: <https://developers.cloudflare.com/workers/platform/limits/>
- Workers pricing (10M req + 30M CPU-ms included): <https://developers.cloudflare.com/workers/platform/pricing/>
- Workers AI pricing (10k neurons/day; bge-m3, bge-reranker rates) + limits (embeddings 3,000 req/min): <https://developers.cloudflare.com/workers-ai/platform/pricing/> · <https://developers.cloudflare.com/workers-ai/platform/limits/>
- AI Gateway rate limiting + caching + Workers binding (`gateway` options, `aiGatewayLogId`) + observability/costs: <https://developers.cloudflare.com/ai-gateway/features/rate-limiting/> · <https://developers.cloudflare.com/ai-gateway/features/caching/> · <https://developers.cloudflare.com/ai-gateway/usage/worker-binding-methods/> · <https://developers.cloudflare.com/ai-gateway/observability/>
- Durable Objects pricing (requests/duration/SQLite): <https://developers.cloudflare.com/durable-objects/platform/pricing/>
- Queues pricing + limits (25 GB backlog, 14-day retention, batch 100) + backlog metrics: <https://developers.cloudflare.com/queues/platform/pricing/> · <https://developers.cloudflare.com/queues/platform/limits/> · <https://developers.cloudflare.com/queues/observability/metrics/>
- Analytics Engine overview/pricing: <https://developers.cloudflare.com/analytics/analytics-engine/> · <https://developers.cloudflare.com/analytics/analytics-engine/pricing/>
- D1 limits + GraphQL metrics datasets: <https://developers.cloudflare.com/d1/platform/limits/> · <https://developers.cloudflare.com/d1/observability/metrics-analytics/>
- Bots plans (Bot Fight Mode free; Bot Management enterprise): <https://developers.cloudflare.com/bots/plans/> · <https://developers.cloudflare.com/bots/plans/free/>
- Flagship feature flags + binding: <https://developers.cloudflare.com/flagship/> · <https://developers.cloudflare.com/flagship/binding/> (docs 2026-06-30)
- Cloudflare Notifications availability (usage-based billing needs Professional+): <https://developers.cloudflare.com/notifications/notification-available/>
- GitHub: stargazer/watcher restrictions do **not** cover `/users/{login}/starred`: <https://github.blog/changelog/2026-06-30-upcoming-access-restrictions-to-public-api-endpoints-and-ui-views/> · rate limits unchanged ([03 Sources](03-sync-and-limits.md))
