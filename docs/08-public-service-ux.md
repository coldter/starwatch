# 08 — Public Service UX

> ⚠️ **Free-tier override (2026-09-13):** zero-budget launch constraints in [13-free-tier-feasibility.md](13-free-tier-feasibility.md)–[15-free-semantic-search.md](15-free-semantic-search.md) supersede cost/tier assumptions in this doc (e.g. daily budgets, no polling, precomputed collections).

> Status: **draft for discussion** · 2026-09-13 · Authoritative for the **public multi-user service** mode. Docs [05](05-cli.md)/[06](06-webui.md) remain canonical for self-host/admin mode; where they conflict with this doc, **this doc wins for public behavior**. Technical foundations: [03 §4.4](03-sync-and-limits.md) (sync state contract, SSE), [04](04-groups.md) (groups), [07](07-search-contract.md)/[15](15-free-semantic-search.md) (search quality; docs 16–18 pending). Free-tier budgets and admission: [13](13-free-tier-feasibility.md)/[14](14-abuse-protection.md); public-data limits: [09](09-public-data-and-limits.md). ⚠️ = verify at implementation time.
>
> **Updated 2026-09-13 (free-tier pivot):** budgets, caps, semantic path and progress transport reconciled with [09](09-public-data-and-limits.md)/[13](13-free-tier-feasibility.md)/[14](14-abuse-protection.md)/[15](15-free-semantic-search.md); see §2.5.

**Promise:** type a GitHub username → full-text search over that user's **public** stars in seconds; semantic search keeps improving while you read. No account, no per-user GitHub token. GitHub Lists become collections (**public Lists verified importable for arbitrary users**, [09 §2](09-public-data-and-limits.md)). The queue and budgets are **honest product surfaces**, not hidden failures.

## 1. First-use flow & state machine

### 1.1 Flow

1. **Landing** (`/`): one input. Accepts `login`, `@login`, `github.com/login`, or a profile URL; case-insensitive, resolved to canonical login.
2. **Instant preview** (≤ 300 ms debounce): `GET /users/{login}` (1 req, cache 10 min) → avatar/name/bio. Star count needs a second probe: `GET /users/{login}/starred?per_page=1` and read `Link: rel="last"` (the trick from [03 §4.1](03-sync-and-limits.md)) → exact count. Both cached; repeat lookups are free.
3. **Preview card** shows avatar, name, star count, and index state (from our DB). The card's CTA is state-dependent (below).
4. **Search** navigates to `/u/{login}?q=…`. A query on an unindexed user starts Tier 0 automatically (a typed query is intent — §2.2) and streams results in as the listing lands.

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  ★ starwatch                                About · Limits · API ↗ · GitHub ↗│
│                                                                              │
│                  Search anyone's GitHub stars.                               │
│       Full-text + semantic search over public starred repos. No account.     │
│                                                                              │
│      ┌────────────────────────────────────────────────────────────────┐      │
│      │  [ @ alice                                        ]  [ Search → ]│      │
│      └────────────────────────────────────────────────────────────────┘      │
│         Try: @sindresorhus · @torvalds · your own username                   │
│                                                                              │
│      ┌── preview ─────────────────────────────────────────────────────┐      │
│      │  ( ◕ )  Alice Example · @alice                                 │      │
│      │         Software engineer · 3,448 public stars                  │      │
│      │         ● Indexed 2 h ago · 22 collections · semantic 100%      │      │
│      │         [ Search 3,448 stars ]    [ Refresh ]                   │      │
│      └────────────────────────────────────────────────────────────────┘      │
│                                                                              │
│   Index queue: 2 running · 4 waiting · ~11 min · 214 users indexed           │
│   Public stars only. Private stars are never fetched or stored.              │
└──────────────────────────────────────────────────────────────────────────────┘
```

State variants of the preview card (same slot, different copy):

```
 not indexed   │ ( ◕ )  @alice · 3,448 public stars
               │ [ Index & search ]  Metadata in ~10 s; semantic fills in after.
 indexing      │ ( ◕ )  @alice · 3,448 public stars     ◐ Loading stars 1,203/3,448
               │ [ Search what's loaded ]   [ Cancel ]
 partial       │ ( ◕ )  @alice · 3,448 public stars     ◐ Indexing 42%
               │ [ Search now ]   [ Cancel indexing ]
 fresh         │ ( ◕ )  @alice · 3,448 public stars     ● Indexed 2 h ago
               │ [ Search 3,448 stars ]  [ Refresh ]
 stale         │ ( ◕ )  @alice · 3,448 public stars     ⚠ Indexed 3 d ago
               │ [ Search 3,448 stars ]  [ Refresh now ]
 queued        │ ( ◕ )  @alice · 3,448 public stars     ◷ Queued #3 · ~12 min
               │ [ Search metadata now ]   [ Leave queue ]
 paused        │ ( ◕ )  @alice · 3,448 public stars     ⏸ GitHub limit · 14:32 UTC
               │ [ Search metadata now ]
 not found / no stars / too many stars → §1.2 copy, same card slot
```

### 1.2 State machine

```
  resolve /users/{login} ──► not_found ──(user edits input)──► resolve
          │
          ▼
   ┌────────────┐   entry (submit / first query)   ┌───────────────┐
   │ never      │ ────────────────────────────────► │ listing (T0)  │
   └────────────┘                                   └───────────────┘
          │ 0 stars                                     │        │
          ▼                                             │        │ GitHub limit / budget
      no_stars            first query & capacity        │        ▼
          │ star count > cap                          ▼     paused ──► resumes (auto)
          ▼                                   ┌───────────────┐
      too_many_stars                          │ partial (T1)  │──── done ──► fresh
                                              └───────────────┘              │ >24 h
                                                   │ queued (T0/T1 full)    ▼
                                                   └──► starts when a     stale
                                                        slot frees        │ Refresh
  any active state ── failure ──► error ──(auto retry at {time} | Retry now)
```

| State                  | Entered when                                | Exact copy (headline · body)                                                                                                                                                                                    | Primary action               |
| ---------------------- | ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| never indexed          | profile resolves, no rows for login         | "Index @{login}'s stars" · "Metadata search in ~10 seconds. Semantic search fills in over the next few minutes — no account needed."                                                                            | Index & search               |
| listing (`syncing` T0) | Tier 0 started                              | "Loading @{login}'s stars… {done}/{total}" · "Search works as soon as the list is in. About {eta} left."                                                                                                        | Cancel (starter only)        |
| partial (`syncing` T1) | Tier 0 done, Tier 1 running                 | "Semantic indexing {pct}%" · "Search now — results get better as we finish ({done}/{total} repos indexed)."                                                                                                     | Search now · Cancel indexing |
| fresh                  | semantic coverage = 100%, < 24 h            | "Indexed {relative}" · "{stars} stars · {collections} collections · semantic 100%"                                                                                                                              | Refresh (quiet)              |
| stale                  | last complete index ≥ 24 h                  | "Indexed {relative} — may be missing recent stars" · "Refresh to pick up new stars and README changes."                                                                                                         | Refresh now                  |
| queued                 | job enqueued, no slot yet                   | "You're #{pos} in the indexing queue" · "We index one account at a time to respect GitHub's API. Metadata search already works."                                                                                | Leave queue                  |
| rate-limited-paused    | service GitHub quota exhausted; reset known | "Waiting on GitHub's rate limit" · "Indexing resumes automatically at {time} (in {countdown}). Nothing is lost." + subtype "We've hit today's indexing budget — resumes at 00:00 UTC; your queue spot is held." | Search metadata now          |
| not-found              | `/users/{login}` → 404                      | "We couldn't find a GitHub user named \"{input}\"" · "Check the spelling — usernames use letters, numbers and single hyphens."                                                                                  | (input focused)              |
| no-stars               | user resolves, public star count = 0        | "@{login} hasn't starred any public repos" · "starwatch indexes public stars only."                                                                                                                             | Search another user          |
| too-many-stars         | count > 10,000 (`MAX_STARS`, §2.1)          | "@{login} has {n} public stars" · "That's above our {cap}-star limit. We can index the {cap} most recently starred; older stars stay out of search."                                                            | Index newest {cap}           |
| error                  | any terminal step failure                   | "Indexing hit a snag" · "We'll retry automatically at {time}. {detail}"                                                                                                                                         | Retry now · Details          |
| visitor-limited        | per-IP start budget exceeded                | "You've started several indexes recently" · "Try again in {n} minutes, or search a user we've already indexed."                                                                                                 | —                            |

Rules: every state renders the **search bar and current results** if any index exists (never a dead end); "not found" never clears typed input; state, not error, is the default for throttling.

### 1.3 Freshness semantics

Two independent coverages are shown separately, never as one ambiguous percent:

- **Metadata coverage** — `pages_done/pages_total` during listing; then always 100%.
- **Semantic coverage** — repos embedded / **semantic-window size** (the newest 1,500 repos on free, i.e. `min(star count, 1,500)`, [14 §3.6](14-abuse-protection.md)); grows only in Tier 1.

## 2. Eager-lazy indexing UX

### 2.1 Tier model

| Tier | Name          | Work                                                                                                                                   | Wall clock (quiet system)                                                                         | Search available                                  |
| ---- | ------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| 0    | Listing       | star pages (100/page, `created asc`) → repos + FTS metadata rows; ETag-aware                                                           | first hits ~2–5 s; complete 10–60 s for 35 pages (~3.4k stars), < 10 s for most users             | lexical + filters + browse; chip `metadata only`  |
| 1a   | Recent lane   | repo-level embeddings for the newest ~300 repos — first slice of the **1,500-repo semantic window** ([15](15-free-semantic-search.md)) | 1–3 min                                                                                           | hybrid over the newest slice; "semantic over N/M" |
| 1b   | Backfill lane | remaining repos in the semantic window (up to newest 1,500), repo-level embeddings                                                     | 10–30 min for 3.4k stars; on free, deferred across days ([13 §2(b)](13-free-tier-feasibility.md)) | hybrid coverage grows; results improve live       |
| 2    | Steady state  | re-list (ETags; 304s free) + changed READMEs only; refresh ≤ 24 h active users; similar works                                          | 1–2 min typical                                                                                   | full hybrid + `similar`                           |

Lane priority: 1a of **every** queued user runs before any 1b (fairness; everyone gets semantic on recent stars fast). Preemption happens only at repo-batch boundaries. Per-batch pause on GitHub secondary limits ([03 §1.3](03-sync-and-limits.md)); partial state is always searchable.

Caps: listing `MAX_STARS = 10,000` (100 pages); the semantic window is the newest **1,500** repos ([14 §3.6](14-abuse-protection.md)) embedded repo-level ([15 §2.1](15-free-semantic-search.md)). Above the window: metadata-only; above `MAX_STARS`: metadata for the newest 10k (`too-many-stars`). Rationale: 10k READMEs ≈ two GitHub windows and ~3.5M distilled-README tokens; the window is the free-quota fair share, and metadata listing stays cheap.

### 2.2 Auto-start policy (comparison, then recommendation)

| Option                                 | Behavior                                                                                                                                                         | Pros                                                                                                                     | Cons                                                                                                                          | Verdict         |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- | --------------- |
| A — auto everything on first page view | listing + semantic start when any `/u/{login}` loads                                                                                                             | zero friction                                                                                                            | shared links, SEO crawlers, and drive-by traffic trigger unbounded work; indexes accounts nobody searched; cost unpredictable | ✗               |
| B — manual buttons for both tiers      | nothing runs until clicked                                                                                                                                       | predictable; strong intent                                                                                               | first impression is an empty page; two clicks before any value; exactly what the request asks to improve                      | ✗               |
| **C — intent-gated eager-lazy** ✅     | Tier 0 auto on interactive entry (landing submit, or first query on an unindexed user); Tier 1 auto on the **first query** if capacity; explicit Refresh anytime | value in seconds; semantic starts exactly when someone wants results; crawler-safe (bots don't type); cost follows usage | one more state to explain (queue)                                                                                             | **recommended** |

Rules:

1. **Passive page views never start work.** A crawler or a chat-preview fetch sees the current state and a button.
2. Tier 0 may also start on an explicit profile-page click (`Index & search`), even without a query.
3. Tier 1 starts automatically on the first executed query for that user when `queue_depth(T1) < 5` and free-quota headroom exists (neurons / rows written / Workflow steps, [14 §3.3](14-abuse-protection.md)); otherwise the job is **enqueued** with an honest position (no rejection, no silent deferral).
4. Manual `Refresh` always enqueues; it never jumps the queue. Within cooldown it degrades to a Tier 0 re-list or shows the next allowed time.
5. Every index is shared by all visitors ("community index"): one job per user, idempotent attach (`POST` returns the existing job instead of duplicating). Cancellation is starter-only via a key.

### 2.3 Queue, budgets, cooldowns

| Guard                     | v1 initial value (tunable)                                                                                                                                                                                                      | Behavior on exceed                                    |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| Tier 0 concurrency        | **1 job**, separate queue                                                                                                                                                                                                       | short wait, position shown                            |
| Tier 1 concurrency        | **1 job** (lane 1a preempts 1b at batch boundaries)                                                                                                                                                                             | queue with position + ETA range                       |
| Per-IP index starts       | 2 per 60 s; 5/day, of which ≤3 new usernames/day ([14 §3.2](14-abuse-protection.md))                                                                                                                                            | `visitor-limited` copy, HTTP 429 + `Retry-After`      |
| Per-IP searches           | 30/min keyword · 6/min semantic/similar; 300 + 60/day (session: 150 + 30/day) ([14 §3.2](14-abuse-protection.md))                                                                                                               | 429; UI keeps last results, toast with retry time     |
| Daily Tier 1 budget       | **free-quota headroom**: min(neurons, Workflow steps, D1 rows written left) ([13 §4.2](13-free-tier-feasibility.md)); embeddings ≤6,000 neurons/day, query embeds + rerank ≤4,000 neurons/day ([14 §4](14-abuse-protection.md)) | `rate-limited-paused` subtype "daily indexing budget" |
| SSE connections           | 3/IP; **SSE only — 3 s polling is forbidden on free** (a backfill poll ≈40 req/tab against the 100k req/day budget, [13 §2(f)](13-free-tier-feasibility.md))                                                                    | close on `done`; reconnect with a status refetch      |
| Re-list cooldown (Tier 0) | 15 min/user (auto), manual same ([14 §3.2](14-abuse-protection.md))                                                                                                                                                             | "Up to date — checked 4 min ago"                      |
| Tier 1 refresh cooldown   | 24 h/user                                                                                                                                                                                                                       | "Indexed 2 h ago; semantic refresh available in 22 h" |
| Full rebuild              | 7 days; admin/operator only                                                                                                                                                                                                     | hidden unless self-host                               |

Cancellation:

- `POST /api/u/{login}/index` returns `{jobId, cancelKey, queue: {position, etaSeconds}}`; the browser stores `cancelKey` in localStorage, the CLI prints it and stores it under `jobs.{login}` in config.
- `DELETE /api/u/{login}/jobs/{jobId}` with `{cancelKey}`: queued → removed instantly; running Tier 0 → stops at the current page; running Tier 1 → stops at the batch boundary. Partial indexes are kept and remain searchable.
- Only the initiator can cancel. Copy states this: "Cancel indexing (only the person who started it sees this button)."

Honesty rules (the UX contract for a busy queue):

1. An ETA is always a range and rounds **up**; if queue depth > 10, replace it with "busy — we'll start as soon as a slot frees" instead of a fabricated number.
2. Never animate a progress bar that isn't moving; paused states replace the bar with the reason and a resume time.
3. Queue position and global depth are visible on the landing page and the user page — the wait is a feature of a free service, not an error.
4. Rate-limit and budget pauses are normal states, styled calm, never red.
5. If semantic indexing is queued or disabled, the search still returns metadata results with an explicit coverage note; degradation is described, not concealed.

### 2.4 Progress wireframes

```
Header chips (change in place, never block the page):
  ◐ Loading stars 1,203/3,448     ◐ Indexing 42%     ◷ Queued #3
  ⏸ Paused · GitHub limit         ⚠ Indexing failed  ● Indexed 2 h ago

Tier 0 — listing:
┌──────────────────────────────────────────────────────────────────────────────┐
│  ◐ Loading @alice's stars…  1,203 / 3,448                                    │
│  ███████████░░░░░░░░░░░░░░░░  35%    Search works as soon as the list is in. │
└──────────────────────────────────────────────────────────────────────────────┘

Tier 1 — partial (search stays fully usable):
┌──────────────────────────────────────────────────────────────────────────────┐
│  ◐ Semantic indexing 42% · 1,450 / 3,448 repos        ETA ~9 min [ Cancel ]  │
│  ██████████░░░░░░░░░░░░░░░░░  Search now — results get better as we finish.  │
└──────────────────────────────────────────────────────────────────────────────┘

Queued / paused / complete / failed:
┌──────────────────────────────────────────────────────────────────────────────┐
│  ◷ Queued · #3 of 4 · starts in ~12 min                                      │
│  We index one account at a time to respect GitHub's API. Metadata search     │
│  already works.                                             [ Leave queue ]  │
├──────────────────────────────────────────────────────────────────────────────┤
│  ⏸ Waiting on GitHub's rate limit · resumes 14:32 UTC (in 3 m 41 s)          │
│  Nothing is lost — indexing continues automatically.                         │
├──────────────────────────────────────────────────────────────────────────────┤
│  ● Indexed 2 h ago · 3,448 stars · 22 collections · semantic 100%            │
│  ⚠ Last attempt failed · retrying automatically at 15:00 UTC   [ Retry now ] │
└──────────────────────────────────────────────────────────────────────────────┘
```

### 2.5 Free-tier deltas applied

The $0 launch ([13](13-free-tier-feasibility.md)–[15](15-free-semantic-search.md)) changes this UX's operating envelope; the states and copy above are unchanged:

- **Concurrency 1 + 1** (one listing, one semantic) and global knobs of **500 searches/day, 100 semantic queries/day, 50 sync triggers/day, ≤10 weighted new users/day** ([14 §4](14-abuse-protection.md)).
- **Semantic path:** repo-level 512d vectors in a per-user R2 blob + in-Worker kNN ([15 §2](15-free-semantic-search.md)) replaces per-user Vectorize namespaces; the semantic window is the newest **1,500** repos and listing is capped at `MAX_STARS = 10,000` ([14 §3.6](14-abuse-protection.md)).
- **Daily budget is free-quota headroom**, not a share of the GitHub quota; GitHub's 5,000 req/h window runs 300 reserved → 4,700 usable, paced ≤700/min ([14 §3.4](14-abuse-protection.md)).
- **SSE only; no progress polling** ([13 §2(f)](13-free-tier-feasibility.md)); close streams on `done`.
- **A started run is stamped active before `POST /sync` answers.** The workflow's own first write lands a few hundred ms later, so the handler writes `phase: "listing"` itself. Otherwise a client that opens the events stream right after the response reads a terminal snapshot, stops watching, and never sees the finished run's fresh `last_synced_at` — the freshness chip then stays at the old age until a reload. `last_synced_at` is the cooldown anchor, so the start stamp must not move it.
- **Every active phase heartbeats.** The star list writes `phase`/counters per fresh page; the README/embedding pass writes `readmesFetched` (from `countStats`) every few batches plus the last one. So `updated_at` is a liveness signal, and the README counter moves during the longest phase instead of jumping at the end.
- **An abandoned run is recoverable.** A run killed at a platform limit leaves an _active_ phase behind, and the phase guard would then answer 409 forever (a permanent spinner, until the next day's chain). `POST /sync` therefore asks the engine whether the instance behind that phase is alive (`listing-{login}` / `refresh-{login}-{day}`) and only reports `SyncInProgress` when it is. A quiet-and-dead run may be restarted, skipping the cooldown: the failed attempt already spent that window, and leaving the row active would block every retry. The UI mirrors the same 5-minute heartbeat window to say "No progress for 8 minutes" with _Check again_ / _Start again_.
- **A full re-list that cannot chain its Tier 1 pass settles instead of stranding.** The refresh instance id is unique per run now (ownership lives in `run_instance_id`), so a failed `create` means the account is genuinely free; the listing then writes `phase: "ready"` so the index is usable and the semantic pass can be retried, instead of claiming "Index updated" while the vectors are still missing.
- **One sync per account per 24 hours.** The public service cannot tell users apart, so the _account_ is the budget: `DEFAULT_SYNC_COOLDOWNS` uses `SYNC_WINDOW_SECONDS` (24 h) for both the re-list and the full-refresh window, and the WebUI disables both sync buttons with a countdown while the window is closed. The window is closed only for a _settled_ index: a `ready`/`idle` row inside 24 hours. Every other phase (`listing`, `fetching-readmes`, `embedding`, `paused`, `failed`) means the last attempt did **not** finish — a transient GitHub limit, a platform kill, a crash — so it is retryable immediately; blocking those for a day is what turned one bad run into a day-long outage. A _successful_ re-list that found nothing new still starts the window: it cost a full GitHub page sweep. The WebUI derives its disabled state from the same rule (`isRunIncomplete` in the worker, mirrored in `webui/src/lib/state.ts`), so it never greys out a button the API would accept.
- **Per-IP daily trigger budget.** On top of the 5/60 s burst limiter, `POST /users/:login/sync` counts against `sync_budget` (migration 0003, 50 attempts per IP per UTC day, `DAILY_SYNC_TRIGGERS_PER_IP`). The counter increments on _every_ attempt including refused ones, so the row is what actually happened; the shape it stops is one caller cycling through many accounts.
- **Re-check means "ask GitHub again"**: the header's re-check button posts a metadata re-list (`full: false`), never a client-only refetch. The per-account daily window is the honest answer to a too-early click — unless the previous run did not finish, which is retryable immediately.
- **Collections are precomputed per `index_version`** (D1 or Cache API) rather than scanned per request ([13 §4.2](13-free-tier-feasibility.md)).
- **Indexed-user soft cap 50 full/warm** with LRU demotion/eviction ([14 §3.6](14-abuse-protection.md), [10 §6](10-multitenant-architecture.md)).

## 3. Search experience per username

### 3.1 URLs

```
/u/{login}                                        profile + recent stars (browse)
/u/{login}?q=tui+for+git&lang=Rust&group=tui      scoped search (URL = source of truth)
/u/{login}?q=…&sort=stars&page=2                  all 07/06 params, names unchanged
/u/{login}/collections                            collections overview (GitHub Lists + generated)
/u/{login}/r/{owner}/{name}?q=…                   repo detail; Back returns to results
```

Canonical redirects: wrong-case login → canonical; `?user=` inside `/u/` ignored; every search URL is copy-paste shareable with no sign-in.

### 3.2 Context switcher

- Header pill `[ @alice ▾ ]`: current user, then up to 10 recent users from **localStorage** (login + freshness, nothing personal server-side), then "Index another user…".
- `user:bob` (or leading `@bob`) inside the search bar switches context and searches the remaining text on `/u/bob?q=…`; the pill updates and a breadcrumb shows the switch. No secret syntax beyond this.
- "My stars" = enter your own username once; it becomes the first recents entry. No account, no `@me` magic (we cannot verify identity — and must not pretend to).

### 3.3 Single-user context (v1) vs multi-user/global (v2)

**Recommend a single account per search context for v1.** Every ranking rule in [07](07-search-contract.md) assumes one corpus; searching across accounts needs cross-corpus ranking, duplicate-repo handling, and coverage accounting per corpus, and it changes the mental model from "search _their_ memory" to a repo directory. Implementation fits v1 nicely: one semantic index per login — an **R2 vector blob keyed by login** on the free path ([15 §2](15-free-semantic-search.md)) or a **namespace per login** (`u{user_id}`) on the paid path ([10 §3](10-multitenant-architecture.md)); D1 rows are scoped by `login` + `repo_id`. v2: a global scope across indexed logins (fan-out with cross-corpus RRF and dedupe) — experimental, never the landing default.

### 3.4 Search page header / freshness area

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ starwatch  [ @alice ▾ ]  [ tui for git                     ⌘K ]   [?] [ ☾ ]  │
├──────────────────────────────────────────────────────────────────────────────┤
│ ( ◕ ) alice · 3,448 stars · mostly Rust, Go        ● Indexed 2 h ago   [ ⇗ ] │
│ [ Recently starred ] [ Rust 318 ] [ tui 44 ] [ Work ] [ Archived gems 12 ]   │
│ ◐ Semantic indexing 42% (1,450/3,448 repos)  ⓘ        [ Refresh index ]      │
├───────────────┬──────────────────────────────────────────────────────────────┤
│ FILTERS       │ 48 results · 47 ms · hybrid · semantic coverage 42%          │
│ Language 318  │ ┌──────────────────────────────────────────────────────────┐ │
│ Stars  ▁▃▅▇   │ │ ▸ ratatui/ratatui  ● Rust  ★ 12.4k   [Rust 318] [tui]    │ │
│ Collections   │ │   "a [tui] for [git] with side-by-side diffs"            │ │
│  #Work #tui   │ │   [keyword] [semantic]                 similar ↗  open ↗ │ │
└───────────────┴──────────────────────────────────────────────────────────────┘
```

Freshness chips (exact labels; always visible, click → sync panel):

| Condition     | Chip                                                        | Detail on click/hover                           |
| ------------- | ----------------------------------------------------------- | ----------------------------------------------- |
| fresh         | `● Indexed 2 h ago`                                         | stars, collections, semantic 100%               |
| stale         | `⚠ Indexed 3 d ago`                                         | "may be missing recent stars" + Refresh         |
| Tier 0        | `◐ Loading stars 1,203/3,448`                               | ETA, cancel (starter only)                      |
| Tier 1        | `◐ Indexing 42%`                                            | "semantic covers N/M repos (newest first)", ETA |
| metadata only | `◦ Metadata search only`                                    | "enable semantic indexing" CTA                  |
| queued        | `◷ Queued #3 · ~12 min`                                     | leave queue                                     |
| paused        | `⏸ Paused · GitHub limit 14:32` / `⏸ Paused · daily budget` | resume time, explanation                        |
| failed        | `⚠ Indexing failed · retry`                                 | last error, auto-retry time                     |

States:

- **Loading**: skeletons plus live listing count; result list renders progressively (`~` prefix on counts until Tier 0 completes); one auto-rerun when listing finishes ("New results loaded" toast), then no rerun spam during Tier 1.
- **Empty query**: profile hero + **Recently starred** list (every star, recently starred first, paged) with the public Lists rail and corpus stats (`3,448 repos · 1,495 embedded`) beside it. This is the discovery surface, not a blank page.
- **No results**: keep filters visible; remove-filter suggestions ([06 §3](06-webui.md)); if semantic coverage < 100%, add "Semantic indexing is 42% done — results may improve in ~9 min"; offer one-click `keyword`/`semantic` switch.
- **Semantic unavailable / cover 0%**: render metadata results with `◦ metadata only`; `similar` explains "needs semantic indexing" with a start button.
- **Errors**: preserve context and last results; banner + Retry; never blank the page.

Sharing: "Copy link" copies the canonical `/u/{login}?q=…`; page `<title>` = "{login}'s stars — search N repos · starwatch"; `og:title`/`og:description` per user (query variants included); no share-bar clutter. Share cards (dynamic OG images) are v1.5 (§6).

## 4. Groups as first-class context

### 4.1 GitHub Lists import (primary when readable)

- At Tier 0 completion, one GraphQL call attempts public Lists for the user; private lists are never visible to us and are never hinted at.
- **Verified (2026-09-13, [09 §2](09-public-data-and-limits.md)):** `user(login).lists` returns any user's **public** Lists — developit showed 25 public lists + items in one GraphQL query (1 point); `isPrivate` lists appeared only for the token's own account. Import public Lists only. GraphQL refuses anonymous requests, so this step **requires `GITHUB_TOKEN`**; the per-user `lists_state` row (`never | ok | empty | error`, migration 0006) records the outcome so the rail can say "no public Lists" only when GitHub actually answered that. A failed read keeps the stored lists, and `POST /users/:login/groups/refresh` re-imports on demand without waiting for the daily sync window.
- Import matches `nameWithOwner` → repo id; unmatched members (unstarred since) are dropped. Re-imported on each Tier 0 refresh; **read-only forever** (no writes to GitHub).
- Provenance is explicit: chip prefix `▤` = GitHub List; `✦` = generated. Store `group.source` (`github_list | generated`) and `remote_list_id` if present.

### 4.2 Generated collections (always shipped, the real fallback)

Precomputed per `index_version` and cached (D1 or Cache API) — a request-time 3.4k-row scan is a D1 read-budget trap ([13 §4.2](13-free-tier-feasibility.md)) — zero extra API calls, deterministic, unmoderated:

| Collection       | Rule                           | Why                                |
| ---------------- | ------------------------------ | ---------------------------------- |
| Recently starred | `starred_at` within 90 days    | best "current interests" browse    |
| Top languages    | top 8 languages by repo count  | one-click narrowing                |
| Popular topics   | top 12 topics by repo count    | thematic discovery                 |
| Most starred     | stars desc, min 1k             | "greatest hits"                    |
| Archived gems    | archived = true AND stars ≥ 1k | something unique search is good at |

If a user has no public Lists (empty or unavailable), `collections` renders these; copy: "No public Lists found — showing auto-generated collections." Never fabricate list-shaped groups.

### 4.3 User-created groups — decision

- **v1: no anonymous writes.** Anyone could otherwise deface someone else's page; ownership is unverifiable, and moderation would dwarf the feature. Read-only is honest and useful.
- **v2: owner-verified curation** via GitHub OAuth (login must equal the page login) with a `✓ owner` badge; smart rules reuse [04 §4.2](04-groups.md). Anonymous edit-token links are rejected (leak-prone, unrecoverable). Global collaborative tagging is rejected (spam magnet).
- Local-only "my selection" filters (localStorage) can ship in v1.5 without server writes; they are not shareable and are labeled as such.

### 4.4 In results

- Result cards show collection chips (max 3 + "+2") with provenance icon; clicking a chip applies `group=` (multi-select OR, per [04 §5.2](04-groups.md)).
- The filter rail lists collections with counts; `#Work` from a GitHub List and `✦ Rust 318` from generation are visually distinct, never conflated.
- Active group filter renders as a removable chip and a "in {group}" breadcrumb above results; the search page says "in Work" in plain words.
- Group filters compose with all [07 §4.1](07-search-contract.md) filters; ranking is untouched (filters, not boosts), except the existing query-mentions-group boost.
- Degradation: if Lists import fails mid-flight, chips disappear and `group=` params for missing groups are dropped with a one-line notice — search never errors because a group vanished.

## 5. Interface deltas

### 5.1 docs/05-cli.md

| Current                        | Public-service delta                                                                                                                                                                                                                                                           |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `login` / `logout` device flow | **Removed from the public surface.** Reads need no credential. `starwatch admin login` stays for self-host/operator only.                                                                                                                                                      |
| no user concept                | **`-u, --user <login>`** on `search`, `similar`, `show`, `sync`, `status`, `groups`; env `STARWATCH_USER`, config `defaultUser`. Missing context → error with `--user alice` hint (or recents list).                                                                           |
| `sync` starts a local run      | `sync --user <login> [--tier listing\|semantic\|full]` starts/attaches a **remote shared job**, prints queue position, then tails SSE; `--cancel <jobId> --key <cancelKey>`; `--json` adds `queue: {position, etaSeconds}`. Cooldowns surface as clear messages, not failures. |
| `status` = personal index      | `status --user <login>` (per-user state/coverage) and `status --global` (queue, budgets, GitHub quota).                                                                                                                                                                        |
| `groups` full CRUD             | Read-only `groups list                                                                                                                                                                                                                                                         | show --user <login>`in v1; writes move to v2 owner flow. Search`--group` flags unchanged. |
| `doctor` checks auth           | Drops token checks; adds user resolution, queue state, endpoint latency.                                                                                                                                                                                                       |
| config `token`, `apiUrl`       | Remove `token`; add `defaultUser`; `apiUrl` defaults to the public service. `sw_…` only for `admin`.                                                                                                                                                                           |
| §6.2 token model               | Public CLI is anonymous, fair-use rate-limited per IP; identify with `X-Starwatch-Client: cli/{version}`. No deployment tokens are issued to public users.                                                                                                                     |
| exit codes                     | Unchanged; 429 → existing `RATE_LIMITED`; an accepted/queued sync exits `0` (it was accepted; state is in output).                                                                                                                                                             |
| `search --json` envelope       | Adds `user` and `index: {state, semanticCoverage, lastIndexedAt}` alongside the [05 §4.4](05-cli.md) fields.                                                                                                                                                                   |

### 5.2 docs/06-webui.md

| Current                        | Public-service delta                                                                                                                                                                                                                                              |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cloudflare Access auth (§8.5)  | **Removed.** Public site; per-IP rate limiting + **mandatory Turnstile on index-start endpoints** (free tier: unlimited challenges; [14 §3.3](14-abuse-protection.md)/[§6](14-abuse-protection.md)). Admin stays behind Access on a separate path/hostname.       |
| `/` is the search page         | `/` becomes the **public landing**; search moves to `/u/:login`; add `/u/:login/collections`, `/u/:login/r/:owner/:name`, `/queue`, `/about`.                                                                                                                     |
| `/settings`, `/groups` manager | Removed for public users; settings → read-only `/about` (what we store — public data only; budgets; status; opt-out/removal contact). `/groups` becomes a read-only collections explorer.                                                                         |
| SPA has "no SEO need"          | **Reversed.** `/u/*` is shareable and crawler-facing: per-user `<title>`/meta/OG, canonical, sitemap of indexed users, `robots.txt`; Worker HTML-head injection for `/u/*`, then SPA. Dynamic OG share cards = v1.5.                                              |
| Sync UI is personal (§6)       | Per-user freshness chip + progress panel + queue position; landing shows global queue. "Sync now" → "Refresh index" with cooldown-aware copy; cancel uses the starter key. SSE schemas/endpoints reuse [03 §4.4](03-sync-and-limits.md); add `/api/queue/events`. |
| Search page includes URL state | Kept, plus user context in the URL; "Save search as group" → "Copy link" (v1) / local saved searches (v1.5); no server-side saves for anonymous users.                                                                                                            |
| Repo detail incl. group editor | Read-only chips; `similar` gated on semantic coverage with a start CTA; unstar banner irrelevant (only current public stars are ever indexed).                                                                                                                    |
| Per-IP abuse UX                | New: polite 429 card, `Retry-After` countdown, "search users we've already indexed" fallback, no captcha on first offense.                                                                                                                                        |
| Component inventory (§10)      | Add `LandingHero`, `UserSwitcher`, `ProfileHero`, `FreshnessChip`, `IndexProgressPanel`, `QueueBanner`, `CollectionChips`, `ShareMenu`; remove `SettingsPage`, `GroupEditor`, `BulkAssignBar`, `DangerZone`.                                                      |
| Responsive (§8.7)              | Public audience: mobile support is in-scope from day 1 (landing + search readable at 390 px), not desktop-first.                                                                                                                                                  |

Also a delta for [03](03-sync-and-limits.md): its per-user fine-grained PAT, `starwatch login`, and private-star indexing describe **self-host mode only**. Public mode uses one zero-permission service credential for public data ([09 §4.1](09-public-data-and-limits.md) recommends a no-permission fine-grained PAT; the final credential choice is open question 1) and never stores per-user GitHub credentials.

## 6. Additional UX suggestions (evaluated)

| Idea                                                                                     | Value                                          | Cost                          | Verdict  |
| ---------------------------------------------------------------------------------------- | ---------------------------------------------- | ----------------------------- | -------- |
| **Profile discovery strip** (recent, top, language/topic mix, "Surprise me")             | High: turns every user page into a destination | Near-zero (Tier 0 data)       | **v1**   |
| **Address-bar search** (OpenSearch XML) + **bookmarklet** ("Starwatch this GitHub user") | High: habitual loop; shareable install         | Hours                         | **v1**   |
| **Recently indexed directory** `/recent` (not a leaderboard)                             | Medium: discovery, SEO                         | Low; privacy/opt-out caveat   | **v1.5** |
| **Share cards** (dynamic OG image per user/query)                                        | High: social distribution                      | Medium ⚠️ (Workers image gen) | **v1.5** |
| **Saved searches** — URL-first now; localStorage list; server-side only with identity    | Medium                                         | Low local / high server       | **v1.5** |
| **Compare two users** (`/compare/{a}/{b}`: shared, only-A, only-B)                       | High wow; doubles query cost; needs dedupe UI  | Medium-high                   | **v2**   |
| **Embeddable "search my stars" badge** for READMEs                                       | Distribution loop                              | Low-medium; spam surface      | **v2**   |
| Public API + MCP server over the same contract                                           | Power users/agents                             | Medium (native to stack)      | **v2**   |
| Browser extension                                                                        | Low over address-bar integration               | High                          | ✗        |

Short list to actually build, in order: (1) discovery strip, (2) OpenSearch + bookmarklet, (3) `/recent`, (4) share cards, (5) compare users (v2).

## 7. Open questions

1. **Service GitHub credential & quota policy** — GitHub App installation token on our own app/public repos vs fine-grained PAT vs a token pool (multi-account pooling risks ToS violation and is the wrong lever). The queue sizing, caps and daily budget all depend on this answer; raise cache/ETag efficiency before adding credentials.
2. **`User.lists` for arbitrary users — resolved (2026-09-13).** Public Lists are readable for any account ([09 §2](09-public-data-and-limits.md)); private lists are owner-only. Generated collections (§4.2) remain the fallback for accounts with no public lists.
3. **Star cap — resolved for the $0 launch.** `MAX_STARS = 10,000` with a newest-1,500 semantic window ([14 §3.6](14-abuse-protection.md)); revisit special-casing 10k+ accounts only on the paid path.
4. **Auto-start thresholds** — `queue_depth < 5` and ≤10 weighted new users/day ([14 §3.6](14-abuse-protection.md)/[§4](14-abuse-protection.md)) are initial defaults; tune against real quota data, and decide whether queue overflow should defer to off-peak instead of enqueueing.
5. **SEO/privacy** — index `/u/{login}` by default? Offer per-user `noindex`/removal on request (public data, but cached copies are ours). Robots policy for `/recent`.
6. **Abuse protection — resolved for the $0 launch.** Per-IP/day budgets + mandatory Turnstile on index starts; search stays uncaptchaed ([14](14-abuse-protection.md)). Escalation path: [14 §3.5](14-abuse-protection.md).
7. **Global/multi-user search (v2)** — fan-out over per-user indexes (R2 blobs, or paid Vectorize namespaces) with cross-user RRF/dedupe, or a separate `login`-partitioned index? Measure fan-out cost first.
8. **Cancellation ownership** — starter-only cancel is simple but means shared indexes can be killed by one visitor; should the page owner (verified later) or a quorum be able to cancel/keep?
9. **Retention/eviction — resolved for the $0 launch.** Indexed-user soft cap 50 full/warm with LRU demotion, then eviction ([14 §3.6](14-abuse-protection.md), [10 §6](10-multitenant-architecture.md)); announcement windows are set, the exact retention promise is still open.
10. **Re-list cadence — resolved for the $0 launch.** On-demand with a 24 h per-account window (an unfinished run is retryable at once) ([14 §3.2](14-abuse-protection.md)); no nightly sweeps on free ([10 §7](10-multitenant-architecture.md)). Nightly hot-page refresh is a paid-mode option.
11. **Domain/branding — resolved for the $0 launch.** `.workers.dev`, no zone (so no WAF/Bot Fight Mode behind it; [13 §3](13-free-tier-feasibility.md)); custom domain is a paid/abuse-driven decision.

**Verification note:** `User.lists` non-viewer readability **verified** in [09 §2](09-public-data-and-limits.md) (public lists readable; private owner-only). Under the free-tier pivot Vectorize is not in the launch path ([15 §1](15-free-semantic-search.md)) — semantic runs on repo-level R2 blobs + in-Worker kNN, with per-user namespaces (`u{user_id}`) retained as the paid path ([10 §3](10-multitenant-architecture.md)). GitHub endpoint costs/ETag behavior as verified in [03](03-sync-and-limits.md); dynamic OG image generation remains ⚠️.
