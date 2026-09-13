# 09 — Public-Data Indexing & Service Limits

> Status: **draft for discussion** · 2026-09-13 · Every claim marked "verified" was checked live (read-only) against `api.github.com`, the GraphQL API and `raw.githubusercontent.com` as `coldter` on this date; ⚠️ marks low-confidence items to re-check at implementation time. Companions: [00](00-requirements.md) · [03](03-sync-and-limits.md) (own-account sync, token basics, error taxonomy) · [04](04-groups.md) (Lists semantics) · [07](07-search-contract.md).

This doc owns: indexing **arbitrary users' public stars** with one service-side token — endpoint semantics, GitHub Lists visibility for other users, README fetching at scale without per-user tokens, the token model, cache-and-serve policy, capacity math, and edge cases. Own-account sync semantics stay in [03].

The pivot assumption is "public data only, one service token". The research below says: **that works, but the token's 5,000 req/h is the binding budget** — so every design choice must push work onto free paths (`raw.githubusercontent.com`, ETag/304, cross-user dedupe) and the queue must be token-budget-aware.

## 0. Headline findings

| # | Finding (verified 2026-09-13 unless marked) | Consequence |
|---|---|---|
| 1 | `GET /users/{login}/starred` is public for any user; `Accept: application/vnd.github.star+json` works for other users (sindresorhus item carried `starred_at`) | We can index arbitrary public stars with one token |
| 2 | **`User.lists` exists** and is queryable via `user(login: X)` — not just `viewer.lists`. developit's 25 public lists + items were read in one query for **1 GraphQL point** | Public Lists are importable for arbitrary users |
| 3 | Private lists are visible only when the querying token **is** that user (coldter case: 22 total incl. 5 private). Every list read for 4 other accounts was `isPrivate: false` | Other users' private lists are not exposed; treat "public lists only" |
| 4 | `raw.githubusercontent.com` costs **0 API quota** (no `x-ratelimit-*` headers), serves strong ETags, 304s, Range, `max-age=300`, UTF-8 as-is | README backfill becomes bandwidth/subrequest-bound, not API-bound |
| 5 | Renamed logins are a trap: `/users/{old}` 404s; `/users/{old}/starred` may 404 **or silently return `[]`** (`kamranahmedse` → `nilbuild`, 1,769 stars) | Key users by numeric `id`; never trust `[]` without a profile 200 |
| 6 | Private-profile users return `[]` from `/starred` to everyone but themselves (docs) ⚠️ no live example found | "0 stars" and "private profile" are indistinguishable; UX must label "no public stars" |
| 7 | Multiple tokens/accounts cannot legally pool quota: ToS §H "You may not share API tokens to exceed GitHub's rate limitations". GitHub App installation tokens are 5,000/h (max 12,500/h) and can't be installed on arbitrary users | One 5k/h budget, full stop (short of a paid GitHub agreement) |
| 8 | Anonymous requests are 60/h **per IP** — on Workers the egress IP is shared Cloudflare infrastructure | Anonymous is never usable in production |
| 9 | Caching public stars + READMEs and serving search is acceptable under the ToS/AUP **if** we attribute, don't resell data, and respond promptly to removal requests (AUP §7–8, ToS D.8/H) | Ship with purge + attribution from day 1 |

## 1. Arbitrary-user public endpoints

### 1.1 `GET /users/{login}` — profile preflight

| Property | Value | Evidence |
|---|---|---|
| Auth | Token or anonymous | live |
| Returns | Public User for users **and orgs**; `id`, canonical `login`, `avatar_url`, `public_repos`, `followers`, `type`, `user_view_type`, `starred_url` | `/users/github` → `type: "Organization"` |
| Case | Login path is case-insensitive; response `login` is canonical (`COLDTER` → `coldter`) | live |
| 404 | Unknown, deleted, suspended, and **renamed** logins | live (3 cases) |
| Private profile | `followers`/`following` are `0` unless requesting as that user (docs) | ⚠️ docs-only |
| Cost | 1 core request; docs list `304` only for `GET /user`, so 304 support for the public variant is ⚠️ untested (assume yes, key the ETag on the full URL) | docs + ⚠️ |
| Durable ID | `GET /user/{account_id}` (note: singular `user`, numeric id) returns the current profile/login after a rename | `/user/77358146` → `coldter` |

**Preflight rule:** always resolve `login → {id, canonical login}` first. A 200 here is the only proof the account exists; everything downstream is keyed on `id`.

### 1.2 `GET /users/{login}/starred` — the star listing

Live-verified semantics:

| Property | Value |
|---|---|
| Auth | Token or anonymous (anon sees public only) |
| `Accept: application/vnd.github.star+json` | Works for arbitrary users; each item is `{starred_at, repo}` (verified `sindresorhus/parse-sse`, starred 2026-07-09) |
| Sort | `sort=created` (when starred; default) or `updated`; `direction=asc|desc`; use `created+asc` for tail-only change detection, same as [03 §(d)](03-sync-and-limits.md) |
| Pagination | `per_page` ≤ 100; `Link` `rel="next"/"last"`; after page 1 the canonical URL switches to `/user/{id}/starred` — **always follow `Link`** |
| 404 | Unknown/gone user (authenticated) — verified |
| 304 | Supported even though the docs list only `200`; authenticated 304 is **free** (`x-ratelimit-used` stayed 153 across a conditional request) |
| Anonymous cache headers | `cache-control: public, max-age=60, s-maxage=60`, weak `W/` ETag, `x-ratelimit-limit: 60` |
| Authenticated cache headers | `cache-control: private, max-age=60, s-maxage=60`, strong ETag, `Vary: Accept, Authorization, …` |
| Payload hygiene | Repo objects include a token-specific `permissions` object; **strip it before storing** (it describes the service token, not public data) |
| Count in one request | `per_page=1` + `Link rel="last"` gives the star total without walking pages (coldter anon: page 3,446 = 3,446 public stars) |

### 1.3 Service token vs unauthenticated

| Aspect | Anonymous | Service token |
|---|---|---|
| Primary quota | 60/h per IP (shared Cloudflare egress) | 5,000/h (verified 5,000; `x-ratelimit-resource: core`) |
| Conditional 304 | ⚠️ assumed to count against the 60/h (unverified, requests confounded) | **Free** (verified) |
| ETag strength | weak (`W/`) | strong |
| Private-profile users | `[]` | `[]` (unless authenticated *as* that user) |
| Private repos | never | repos **visible to the token** — including the token owner's own private stars when indexing the owner's login (verified: coldter 3,448 with token vs 3,446 anonymous) |
| Reasonable role | never in prod | all production reads |

> **Privacy rule:** the service token must have no private-repo access (fine-grained PAT, no repository grants). Otherwise "index @coldter" would surface the service owner's private stars. This is the one place where "public data only" can silently leak.

### 1.4 Users with many stars

| Question | Answer | Evidence |
|---|---|---|
| Max pages? | No documented cap. Deep pagination verified to a 9,845-star account (`yoshuawuyts`): page 99/99 was the last; page 100/101 returned `200` with `[]` (not 422) | live |
| >10,000 stars | No live account found to test ⚠️. GitHub itself reports its web stars list breaks >10,000 stars+topics (community #147863); GraphQL exposes `StarredRepositoryConnection.isOverLimit` = "Is the list of stars for this user truncated? This is true for users that have many stars" (threshold undocumented ⚠️) | docs + community |
| Worst case | 20,000 stars = 200 pages = 4% of one hourly budget; a full sweep is fine | math |
| Policy | Cap a snapshot at **200 pages (20k stars)**; if `Link rel="next"` persists, mark the user `over_limit`, index the first 20k, and surface partial coverage instead of failing | proposed |

## 2. GitHub Lists for arbitrary users — YES (public lists)

### 2.1 Schema (introspected live)

- `User.lists(first/last/after/before) → UserListConnection` — **exists on `User`**, so `user(login: X) { lists { … } }` is valid for any user, not only `viewer`. GraphQL description: "A user-curated list of repositories".
- `UserList` fields: `id, slug, name, description, isPrivate, createdAt, updatedAt, lastAddedAt, items, user` (same shape as [04 §2.1](04-groups.md)).
- `UserListItems` is a union with exactly one member: `Repository`.
- `StarredRepositoryConnection` fields: `edges, nodes, pageInfo, totalCount, isOverLimit` — **no list information anywhere on stars**.

### 2.2 Live results (all read-only)

| Account | `lists.totalCount` for us | Notes |
|---|---|---|
| `coldter` (token owner) | **22** — 17 public, 5 private | Private lists visible because `user(login)` == viewer |
| `developit` | **25**, all `isPrivate: false`, largest 30 items, sample items resolved | Full snapshot of 25 lists + all item counts + `starredRepositories.totalCount` = **1 GraphQL point** |
| `shuding` | 16 | all public |
| `jasonlong` | 5 · `simonw` 2 · `sindresorhus` 1 · `chibicode` 1 · `cassidoo` 1 | adoption is uneven |
| `torvalds` | 0 | empty is a normal answer |
| `antfu`, `gaearon`, `kentcdodds`, … | 0 | most accounts never create lists |

**Visibility rule:** `isPrivate: true` appeared only when the querying identity was the owner. Across 4 other accounts, every visible list was public. We cannot directly prove private lists are hidden for others with a single token ⚠️, but the field description and observed data support: **other users see public lists only**.

### 2.3 Pagination and cost

- Lists: one page is enough in practice (GitHub cap is 32 lists/account per [04 §2.2](04-groups.md) ⚠️); `pageInfo.hasNextPage` still checked.
- Items: standard connection `first/last/after/before` (≤100); huge lists paginate.
- Cost follows the GraphQL formula (Σ connection requests ÷ 100, min 1). A whole-account snapshot observed at **1 point**; even 100 list-item pages = 1 point. 1,000 imported users ≈ 1,000 points ≈ 20% of one hourly GraphQL budget.

### 2.4 Membership is not in stars

Verified by schema (no list fields on edges/repos) and by [04 §2.1](04-groups.md). Membership must be reconstructed by enumerating `lists → items` and joining on repo `id` — the same algorithm [04](04-groups.md) uses for the owner.

### 2.5 Product implications

1. **Public Lists import works for arbitrary users** — use them as search filters/context ("from Alice's *Rust tools* list").
2. **Private lists cannot be imported** (correct: no consent-less access) and a user whose lists are all private simply shows none.
3. Lists remain a **public preview** with a 32-list cap; treat import as optional enrichment, never a required sync step. Absent/empty/unavailable lists must not fail a user's indexing.
4. Include `list_id ↔ repo_id` join rows keyed by numeric repo id, mirroring [04 §4.5](04-groups.md).

## 3. READMEs at scale without per-user tokens

### 3.1 `raw.githubusercontent.com` facts (live header checks)

| Request | Result |
|---|---|
| `…/Effect-TS/effect/main/README.md` | `200`, `text/plain; charset=utf-8`, 8,255 B, strong ETag, `cache-control: max-age=300`, `accept-ranges: bytes`, `via: 1.1 varnish`, **no `x-ratelimit-*`** |
| `…/python/cpython/main/README.rst` | `200`, 8,912 B, same header shape |
| `…/Effect-TS/effect/main/DOES_NOT_EXIST.md` | `404`, `text/plain`, 14 B |
| Conditional `If-None-Match: <etag>` | `304`, ETag echoed, still no rate-limit headers |
| `Range: bytes=0-99` | `206`, `content-range: bytes 0-99/8255` |
| CJK README (`labuladong/fucking-algorithm`) | `200`, 39,156 B, UTF-8 bytes served as-is |
| `…/{owner}/{repo}/HEAD/README.md` | `200` — `HEAD` is accepted as a ref |
| 12 parallel GETs | all `200` in ~0.44 s; no 429 observed |
| Renamed repo path (`vuejs/vue-next/...`) | `200` (raw resolved an old name in one check ⚠️) |

**No API quota, no `X-RateLimit` accounting.** It is still GitHub infrastructure: keep concurrency ≤5, send a real User-Agent, and treat undocumented abuse throttling as possible ⚠️.

### 3.2 Exact path vs variant resolution

`raw` needs an exact `ref` + `path`. GitHub's preferred-README order is `.github/` → repo root → `docs/` (docs), with names like `README.md`, `readme.md`, `README.rst`, `README`, `README.txt` and case variants. Two ways to resolve:

| Method | API cost | Behavior |
|---|---|---|
| **Guess raw paths** | **0** | Try the ordered candidate list against the known `default_branch`; each miss is 404 traffic only |
| `GET /repos/{o}/{r}/readme` | **1 core** (304 free on repeat) | Authoritative variant resolution; returns `name`, `path`, `size`, `sha`, `download_url` (raw URL at the default branch) |

Live confirmation that guessing alone is not enough: `vercel/next.js` uses root `readme.md` (lowercase) and workers-sdk/sentry/rust/node all resolved to root `README.md`; `.github/README.md` and `docs/README.md` exist in the wild. The REST call is the only way to be *sure*.

> ⚠️ Do **not** persist `download_url`: contents docs say download URLs expire and are meant for single use. Store `path` + `default_branch` and construct `https://raw.githubusercontent.com/{full_name}/{default_branch}/{path}` ourselves.

### 3.3 Recommended fetch algorithm

For each repo in the user's listing (metadata already carries `full_name`, `default_branch`, `size`):

```
if size == 0 or readme_state == 'missing' and fresh: skip
1. Known path:  raw GET {full_name}/{default_branch}/{readme_path}, If-None-Match: {raw_etag}
     304 → touch; 200 → store bytes+etag; 404 → path changed, go to 2
2. Probe (0 API) in GitHub's display order .github → root → docs, filename variants within each:
     .github/README.md → README.md → readme.md → README.rst → README
     → docs/README.md → then .txt/rst case variants
     hit → store path+etag (stop)
3. Miss: GET /repos/{o}/{r}/readme with token
     200 → store path/size/sha (+ bytes if we want to skip a raw fetch)
     404 → readme_state='missing', recheck 30–90d (1 req each)
     403/451 → readme_state='unavailable' (disabled/DMCA), back off
```

- Expected API cost per **new repo** ≈ **0.1 requests** (only step-3 misses); expected network cost ≈ 1–2 raw requests.
- Roughly 98% of repos have a README ([07 §1](07-search-contract.md)), dominated by the candidate list above.
- README ETag/`sha` is the content source of truth; `pushed_at` stays the cheap trigger to *start* the check, as in [03 §(h)](03-sync-and-limits.md).
- Default-branch rename breaks a cached path: raw 404 → step 2/3 re-resolves; store `default_branch` per snapshot.

### 3.4 Size and encoding

| Limit | Value | Source |
|---|---|---|
| Contents API (and `/readme`) JSON | ≤1 MB full features; 1–100 MB only `raw`/`object`; >100 MB unsupported | REST docs |
| GitHub-rendered README | content beyond **500 KiB** truncated | "About READMEs" docs |
| Our processing cap | **1 MB**; truncate beyond, mark `too_big` | [03 §(f)](03-sync-and-limits.md) |
| Largest live READMEs seen | 232 KB (doc 07 sample), 211 KB in this pass | live |
| Non-UTF-8 legacy files | decode UTF-8 with replacement; CJK verified clean; GBK/Shift-JIS edge cases exist ⚠️ | live + ⚠️ |

raw has no documented size cut-off and supports Range (`206`), so "very large README" is our own cap, not GitHub's.

## 4. Service token model

### 4.1 One token, minimum privilege

| Choice | Verdict |
|---|---|
| **Fine-grained PAT, no permissions, no repository access** | ✅ recommended. Public data needs no permissions; guarantees the token owner's private stars stay invisible |
| Classic PAT, no scopes | ✅ works for public data, but every classic PAT on the account is broadly scoped by design; fine-grained is stricter |
| Classic PAT with `repo` | ❌ would expose the owner's private stars if the owner's login is indexed |
| Device-flow OAuth app (per-user) | ❌ rejected by the "no per-user tokens" decision |

⚠️ Not yet verified: that a **zero-permission fine-grained PAT** can call `/users/{login}/starred` and GraphQL `user.lists` (we validated with an OAuth token scoped `gist, read:org, repo, workflow`). Test both at implementation; fallback is a no-scope classic PAT or adding the documented minimal permission.

### 4.2 Why more tokens / GitHub Apps don't help

| Idea | Reality |
|---|---|
| Add PATs from other accounts | ToS §H: "You may not share API tokens to exceed GitHub's rate limitations." Also ToS B: one free account per person; machine accounts are one per person. **Prohibited** |
| GitHub App installation token | 5,000/h minimum; scales +50/h per repo and +50/h per user beyond 20, capped at **12,500/h**; only for accounts that install it. Can't be installed on arbitrary public users → no scaling for our workload |
| GitHub App user-to-server token | Debits that user's 5k budget — i.e., per-user tokens, rejected |
| OAuth app `client_id:client_secret` public-data requests | Documented at **5,000/h per OAuth app** (separate bucket). Applicability to `/users/*/starred` + GraphQL is ⚠️ untested; registering many apps to pool 5k buckets is against the spirit (and likely the letter) of the terms |
| GitHub Enterprise Cloud app limits (15,000/h) | Paid, org-scoped; not a launch option |
| Anonymous | 60/h per shared Cloudflare egress IP — useless |

### 4.3 Exhaustion semantics and handling

- Primary exhausted: `403` or `429` with `x-ratelimit-remaining: 0`; wait until `x-ratelimit-reset` (UTC epoch). Verified shapes: anonymous body `{"message":"API rate limit exceeded for <IP>…"}`; search-exhaustion headers `x-ratelimit-limit: 10, -remaining: 0, -used: 10, -resource: search, -reset: …`.
- Secondary: `403/429` + "secondary rate limit" message, optional `retry-after` seconds; ≤100 concurrent (we use 5), ≤900 REST points/min, ≤2,000 GraphQL points/min, ≤90 s CPU per 60 s.
- Missing User-Agent: `403 Request forbidden by administrative rules…` (verified) — always send `starwatch/<ver> (+https://…/starwatch)`.
- Handling reuses [03 §1.3](03-sync-and-limits.md): pause + `sleepUntil(reset+30s)`, exponential backoff, halve concurrency on secondary hits.
- **Public-service specifics:** one abusive visitor can burn the whole 5k/h by requesting thousands of never-seen users. Queue every index request, enforce per-IP/session quotas, cache hits for free, and return "queued, ~X min" instead of 5xx.

## 5. Cache-and-serve policy

### 5.1 Is caching + serving allowed?

Yes, with obligations. Relevant GitHub terms (not legal advice — a launch-time legal read is an [open question](#8-open-questions)):

| Rule | Meaning for starwatch |
|---|---|
| ToS §H | API abuse/excessive frequency can suspend access; no token pooling; no downloading data for spam or selling personal information |
| AUP §7 | "Scraping" means HTML extraction; **API collection is explicitly different**. Research/archival uses are called out; other uses must still respect §8 |
| AUP §8 | Anyone collecting data from GitHub must "respond promptly to complaints, removal requests, and 'do not contact' requests" |
| ToS D.8 | Public repo content is intentionally accessible to everyone; the Terms don't restrict lawful access to it |
| ToS D.5/D.7 | Public repos grant a nonexclusive license to view/fork; attribution/moral rights stay with authors → always credit + link the source repo |
| robots.txt | `github.com` disallows HTML scraping paths (`/search`, `/*q=`, `/*/raw/`, `/*/*/stargazers`) and points bots at the API; `api.github.com/robots.txt` and `raw.githubusercontent.com/robots.txt` are 404 (no crawl rules). We only use API + raw — no HTML ingestion |

Cache headers themselves signal GitHub's intent: anonymous responses are `public, max-age=60` (cacheable); authenticated responses are `private, max-age=60` (not for shared caches). Our D1 cache is an API-client cache, the pattern the REST best-practices doc recommends — keep the two auth modes in separate cache keys and never mix their results.

### 5.2 Recommended TTLs

| Data | Store | TTL / refresh |
|---|---|---|
| User profile (`id`, canonical login) | D1 | 7 d; resolve on every index request; on 404 → negative 24 h |
| Star listing (pages + ETags) | D1 | per-user "indexed_at"; re-sync on demand if older than 24 h (eager-lazy); dormant users 7 d |
| Repo metadata | D1 | refreshed with any listing; README content is ETag-authoritative |
| README path + raw ETag + sha | D1 | no TTL; conditional raw GET on `pushed_at` change |
| README bytes | R2 + D1 text | keep latest; prior versions not required |
| Lists snapshot | D1 | 24 h (GraphQL snapshot ≈1 point) |
| "0 public stars" / private profile | D1 | 24 h negative cache |
| README missing | D1 | recheck 30–90 d |
| Unstarred rows | D1 | soft delete 90 d ([03 §(g)](03-sync-and-limits.md)) |
| Search responses | — | do not cache; optionally ≤60 s normalized cache ⚠️ |

### 5.3 What NOT to store or serve

- The service token, or anything derived from it (never in D1/logs/errors).
- Token-scoped fields: `permissions` objects, `temp_clone_token`, rate-limit headers per user.
- Personal data beyond what the product needs: **no emails**, no follower graphs, no IP retention beyond abuse limits.
- **Never** private repos/stars of the token owner or orgs (excluded by a zero-permission token; add a belt-and-braces filter on `repo.private === false`).
- Raw README HTML for rendering — snippets/markdown only, sanitized per [06 §4](06-webui.md).

### 5.4 Deletion, purge, attribution

| Event | Action |
|---|---|
| User deletes/renames on GitHub | 404 → stop serving *immediately*, show "no longer available"; re-resolve via numeric id first (rename) |
| User requests removal | self-serve delete or a `removal@…` contact; purge D1 rows + vectors + R2 within 24 h; honor "do not contact" |
| Repo goes DMCA/disabled | `403/451` from raw/REST → mark `unavailable`, drop content, keep metadata shell with a link |
| Content rendering | every repo card links to `github.com/{full_name}`; repo page shows license + "README © owner, served from GitHub"; search results say "Data from GitHub" |
| Retention after account deletion | purge after a ≤30-day grace window (undo) at most |

## 6. Capacity math (one 5,000 req/h token)

### 6.1 Request cost per user

Let `N` = stars, `P = max(1, ⌈N/100⌉)` listing pages, `X` = repos **new to the global index** (cross-user dedupe), and assume ~10% of new repos need the one-request REST README fallback:

```
API requests ≈ 1 (profile) + P (listing) + 0.1 × X (README misses, 304s free)
GraphQL      ≈ 1 point per user snapshot (unlimited lists/items)
Raw fetches  ≈ X + path probes/misses (0 API quota)
```

Worked examples against a **4,500 req/h indexing budget** (10% reserved for re-syncs/health):

| New user | N | overlap | API req | **Users/hour** | Users/day (sustained) |
|---|---|---|---|---|---|
| Light | 100 | 50% | 7 | ~640 | ~15,000 |
| Typical | 500 | 70% | 21 | ~215 | ~5,100 |
| Heavy | 1,000 | 70% | 41 | ~110 | ~2,600 |
| coldter-scale | 3,448 | 70% | 140 | ~32 | ~770 |
| Extreme | 10,000 | 70% | 401 | ~11 | ~270 |

Burst note: one coldter-scale backfill (35 listing pages + ~103 README fallbacks + raw fetches) takes **~2–4 minutes** and 3% of the hourly quota — one user is never a quota problem; a *crowd* is.

### 6.2 Re-sync cost

`U users × P pages` per TTL, and many pages return 304 for free. At 10,000 indexed users averaging 1,000 stars: **100k requests/week ≈ 600 req/h** at a 7-day TTL (~13% of budget), or ~140 req/h at 30 days. Cross-user dedupe means a repo is README-fetched and embedded **once** no matter how many users star it — this is the single biggest lever in the whole design.

### 6.3 Non-API ceilings (where the real wall is)

| Resource | Rough capacity | Notes |
|---|---|---|
| Workers AI free tier | 10k neurons/day ≈ 9.3M tokens/day ÷ ~2.5k tokens/repo ≈ **~3,700 new repos/day** free ([01 §8](01-search-and-index.md)) | Beyond free: $0.012/M tokens ≈ $30/1M repos — cheap but not free |
| Vectorize | 7 chunks/repo; index limit 20M vectors ([01 §3.2](01-search-and-index.md), [Vectorize limits](https://developers.cloudflare.com/vectorize/platform/limits/)) | ~2.8M repos before a second index/shard question |
| D1 + R2 | 5 GB / 10 GB allowances | corpus metadata is tiny; READMEs ~6 KB avg |
| Cloudflare subrequests | per-invocation cap ([02 §3](02-stack-and-pipeline.md)) | batch raw fetches; one repo per workflow step if needed |

**Practical launch ceiling:** ~**1,000–3,000 new users/day** (≈30–110/hour during traffic hours), dominated by README/embedding ingest rather than API quota for small profiles; the token budget binds first for heavy profiles.

### 6.4 Queue and burst design

1. **Global token bucket** (Durable Object) shared by all jobs: acquire before each GitHub call; read `x-ratelimit-remaining` and adjust.
2. **Queue every user indexing** (Cloudflare Queue or Workflow per user): priority *first-time user > lazy refresh > nightly re-sync > README rechecks*.
3. **Per-IP + per-session quotas** on the "index this user" endpoint; cached users are instant and free.
4. **Reserve** ~500 req/h for re-syncs and health; never start a backfill below the reserve.
5. **Pause, don't fail:** on `remaining = 0`, Workflow sleeps to reset+30 s and shows "resuming at HH:MM UTC" (same UX as [03 §4.3](03-sync-and-limits.md)).
6. **Measure and store** per-run `api_used`, `raw_fetches`, `dedupe_ratio`, so capacity planning uses live data, not this doc's assumptions.

## 7. Edge cases

| # | Case | Detection (verified unless ⚠️) | Handling |
|---|---|---|---|
| 1 | 0 stars | `200 []` from `/starred`, profile 200 (natfriedman, jxck, enaqx verified) | Cache "no public stars" 24 h; never an error |
| 2 | Private profile | Profile 200, `followers 0`, `/starred` `[]` (docs) ⚠️ | Same UX as 0 stars: "no publicly visible stars"; consider `user_view_type`/followers hints ⚠️ |
| 3 | Renamed login | `/users/{old}` 404; `/starred` 404 **or `200 []`**; numeric id still resolves via `/user/{id}` | Resolve profile first; key by `id`; if an existing id 404s, re-check `/user/{id}` next run; never index `[]` without a profile 200 |
| 4 | Deleted / suspended | Profile 404, `/starred` 404 (observed for `sarah_edo`; renamed vs deleted is not distinguishable from the API ⚠️) | Mark unavailable, negative-cache, purge after grace window |
| 5 | Case variants | `COLDTER` works; response gives canonical `login` | Canonicalize on write; URL-key users by lowercase login + id |
| 6 | Org login | `/users/{org}` 200 `type: Organization`; `/users/github/starred` → `200 []` | Reject with "not a user account" (orgs can't star) unless org support is added |
| 7 | >5k stars | Deep pagination verified to 9,845 | No special case; budget pages individually |
| 8 | >10k stars | No live account ⚠️; web UI known to break >10k | Cap 20k/200 pages, mark `over_limit`, partial coverage label |
| 9 | Empty repo (`size 0`) | Listing metadata | Skip README, index metadata |
| 10 | Archived repo | `archived: true` | Index normally; archived penalty is a search concern ([07 §5.3](07-search-contract.md)) |
| 11 | Disabled / DMCA repo | `disabled: true` or raw/REST 403/451 ⚠️ | Metadata shell + link; do not retry aggressively; drop README content |
| 12 | Non-Latin README | UTF-8 CJK verified (39 KB), bge-m3 multilingual ([01 §3.2](01-search-and-index.md)) | Decode UTF-8 with replacement; keep FTS trigram notes from [07 §7](07-search-contract.md) |
| 13 | Huge README | `size` in `/readme` response / byte length | Cap 1 MB, truncate, `too_big` |
| 14 | README path moved / branch renamed | raw 404 on cached path | Re-resolve via probe list then REST `/readme` |
| 15 | Repo renamed/transferred | Listing `full_name` changes, `id` stable ([03 §(f)](03-sync-and-limits.md)) | Key everything by repo `id` |
| 16 | User has only private lists | `lists.totalCount = 0` for us ⚠️ | Lists enrichment is optional; indexing never fails |
| 17 | Service owner's own login | Token sees private stars (verified) | Zero-permission token + `private === false` filter; alternatively skip indexing the owner account |
| 18 | Rate limits | 403/429 shapes verified for primary + search + no-UA | Global token bucket, pause/resume, backoff ([03 §1.3](03-sync-and-limits.md)) |
| 19 | GitHub outage | 5xx/timeouts | Backoff, degraded search, status-page check ([03 §(i)](03-sync-and-limits.md)) |
| 20 | New user stars a repo mid-index | Snapshot is the listing read at run start | Defer to next run; tail-page diff is cheap ([03 §(g)](03-sync-and-limits.md)) |

## 8. Open questions

1. **Private-profile detection** — is there any API signal (`user_view_type`, followers delta) that separates "private profile" from "0 stars"? Find a known private-profile account and test before writing UX copy.
2. **Token verification** — does a zero-permission fine-grained PAT really read `/users/{login}/starred` and `user(login).lists`? Test with the production token path.
3. **>10k stars** — REST cap vs GraphQL `isOverLimit` threshold; find/borrow a 10k+ account to verify deep pagination and full counts.
4. **OAuth client-credentials bucket** — is the documented 5,000/h OAuth-app public-data budget usable for these endpoints, and is adding it legitimate, or spirit-of-the-terms pooling?
5. **Lists dependency** — preview API with a 32-list cap; do we import on every sync or only on first index + manual refresh?
6. **Abuse controls** — per-IP quotas, queue caps, and whether "index user X" needs a CAPTCHA/backoff under flood; who can trigger a re-sync.
7. **Purge UX** — self-serve removal page vs email; retention window after deletion (proposed: 30 days).
8. **Cache TTLs** — 24 h eager-lazy refresh: how stale is acceptable, and do we surface "indexed 3 h ago / refresh" affordances?
9. **Owner account** — skip indexing `coldter` entirely, or index with a public-only token?
10. **Legal/policy review** — a public multi-tenant index over GitHub data (ToS §H, AUP §7–8, Privacy Statement, GDPR erasure/deletion requests) before launch; also the README-mirroring + embedding question (derived data policy in §8 of the AUP).
11. **Capacity telemetry** — publish real dedupe ratio / tokens per repo after the first 100 users; replace §6's assumptions.
12. **Multi-index scaling** — Vectorize 20M vectors ≈ 2.8M repos; decide shard strategy before importing at that scale.

## Sources (load-bearing)

Internal: [00-requirements.md](00-requirements.md) · [01-search-and-index.md](01-search-and-index.md) · [03-sync-and-limits.md](03-sync-and-limits.md) · [04-groups.md](04-groups.md) · [07-search-contract.md](07-search-contract.md).

Live checks (2026-09-13, read-only, as `coldter`):
- `/users/{login}` (case, org, 404s), `/user/{account_id}` durable ids (`77358146` → coldter; `4921183` → nilbuild), rename quirk (`kamranahmedse` 404 profile vs `200 []` starred; nilbuild 1,769 stars).
- `/users/{login}/starred`: `star+json` for `sindresorhus`; ETag/304 free (authenticated), weak ETag and `cache-control: public` (anonymous); coldter anon 3,446 / authed 3,448; deep pagination on `yoshuawuyts` (page 99/99) and `nilbuild`.
- GraphQL introspection + queries: `User.lists`, `UserList`, `UserListItems`, `StarredRepositoryConnection.isOverLimit`; `coldter` 22 lists (5 private), `developit` 25 public lists + items at cost 1; 15+ accounts checked for list counts.
- `raw.githubusercontent.com` headers: `README.md`/`README.rst`/CJK/missing/304/Range/HEAD/12-parallel; `/repos/{o}/{r}/readme` `path` resolution for 5 repos.

External:
- Starring endpoints (semantics, media types, private-profile note, status codes): <https://docs.github.com/en/rest/activity/starring?apiVersion=2022-11-28>
- Users endpoints (`GET /users/{login}`, `GET /user/{account_id}`, private profile): <https://docs.github.com/en/rest/users/users?apiVersion=2022-11-28>
- REST rate limits (5k users, 60 anon, app scaling 5k→12.5k, secondary points, 403/429): <https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api>
- Contents/README endpoint (raw default, 1 MB/100 MB rules, `download_url` expiry): <https://docs.github.com/en/rest/repos/contents?apiVersion=2022-11-28>
- README preference order (`.github` → root → `docs`; 500 KiB render truncation): <https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-readmes>
- GraphQL rate limits/points: <https://docs.github.com/en/graphql/overview/rate-limits-and-query-limits-for-the-graphql-api>
- Terms of Service §H (API), D (content license/lawful access), B (one account): <https://docs.github.com/en/site-policy/github-terms/github-terms-of-service>
- Acceptable Use Policies §7–8 (API vs scraping, removal requests): <https://docs.github.com/en/site-policy/acceptable-use-policies/github-acceptable-use-policies>
- Robots policy (HTML paths disallowed; API pointer): <https://github.com/robots.txt>
- >10k-star web UI bug (community, Dec 2024): <https://github.com/orgs/community/discussions/147863>
- Lists are public preview: <https://docs.github.com/en/get-started/exploring-projects-on-github/saving-repositories-with-stars>
