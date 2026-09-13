# 04 — Groups (collections of starred repos)

> ⚠️ **Pivot notice (2026-09-13):** this document predates the public multi-tenant pivot. See [08-public-service-ux.md](08-public-service-ux.md)–[12-hardening.md](12-hardening.md) for the current design and [11-assumptions-delta.md](11-assumptions-delta.md) for exactly what changed.

> Status: **draft for discussion** · 2026-09-13 · GitHub Lists facts verified live against the GraphQL API (account `coldter`, read-only) on this date; ⚠️ marks low-confidence items to re-check at implementation time.
> Related: [00](00-requirements.md) §4 R4 · [01](01-search-and-index.md) §3.2 Vectorize constraints, §4 filters, §7 ranking · [02](02-stack-and-pipeline.md) §5 sync, §3 gotchas.

## 1. Recommendation at a glance

| Question | Decision |
|---|---|
| Source of truth | **Local-first**: D1 owns groups; GitHub Lists are optional, never required |
| Group kinds | **Manual** (stored membership) + **smart** (stored rules, evaluated live at query time) |
| Hierarchy | **Flat**, many-to-many — no folders (see §3.2) |
| Multiple `--group` | **OR** by default; `--group-all` switches to AND (§5.2) |
| GitHub in v1 | Read-only **one-time import** of the 22 existing lists into local groups |
| GitHub in v2 | Opt-in, per-group **one-way push mirror** (local → GitHub) |
| Marginal cost | **≈ $0** — a full membership snapshot is 1 GraphQL point; Vectorize filter is free |

Local-first is the only option that supports unlimited groups, smart rules, colors/order, and stays safe while GitHub Lists remain in public preview.

## 2. GitHub Lists research (feasibility)

### 2.1 What exists today (schema-verified live)

GraphQL only — **no REST endpoints** (checked against the official `api.github.com` OpenAPI description: no `/user/*list*` path). The types were added to the schema on **2023-11-30** and are still documented as *"Lists are currently in public preview and subject to change."*

| Operation | GraphQL shape (verified by introspection + live calls) | Notes |
|---|---|---|
| Read lists | `viewer.lists(first/last/after/before) → UserListConnection` | args are pagination only — **no `orderBy`** |
| Read items | `UserList.items(first/last/after/before) → UserListItems` | union `UserListItems = Repository` only |
| Create | `createUserList(input: {name, description, isPrivate}) → {list, viewer}` | returns the new `UL_…` id |
| Update | `updateUserList(input: {listId, name, description, isPrivate}) → {list, viewer}` | id stable across rename |
| Delete | `deleteUserList(input: {listId}) → {user}` | list gone; stars untouched |
| Set item membership | `updateUserListsForItem(input: {itemId, listIds, suggestedListIds}) → {item, lists, user}` | **replace semantics**: `listIds` = "the lists to which this item **should belong**" |
| Suggestions | `viewer.suggestedListNames → [UserListSuggestion!]!` (`{id, name}`) | GitHub-provided names, e.g. 🔮 Future ideas |

`UserList` fields: `id, slug, name, description, isPrivate, createdAt, updatedAt, lastAddedAt, items, user` — there is **no `position`** field, and `lastAddedAt` only tracks "created or last item added".

Observed on `coldter` (2026-09-13): **22 lists** (17 public, 5 private), **279 items total** (largest list 52), ordered by `lastAddedAt` **DESC**. One full snapshot (lists + all items) cost **1 GraphQL point** — the primary-cost formula is `⌈Σ connections / 100⌉` with a minimum of 1, so listing a whole account is effectively free.

Other verified behavior:

- **Membership is not exposed on stars.** `StarredRepositoryConnection`/`StarredRepositoryEdge` carry only `cursor, node, starredAt` (+ `isOverLimit` on the connection); `Repository` has no list fields. Any sync must enumerate lists → items and cross-reference by repo id.
- **Unstar removes the repo from every list** (GitHub staff confirmation) and adding to a list auto-stars; lists are a strict view over stars.
- Item ids for mutations are GraphQL node ids (`R_kgDO…`, also returned by REST `/user/starred` as `node_id`); `databaseId` (numeric) maps to `repos.id`.

### 2.2 Limits, scopes, costs

| Fact | Value | Confidence |
|---|---|---|
| Max lists per account | **32** | ⚠️ community-reported (multiple staff-adjacent threads), not in official docs |
| Max items per list | undocumented; 52 observed; long lists paginate in the UI | ⚠️ validate with a 500+ item list |
| Pagination | `first/last` 1–100; ≤500k nodes/call; 10 s timeout | docs |
| Query cost | min **1 point**; snapshot = 1 pt; nightly sync negligible vs 5,000 pt/h | docs + live |
| Mutation budget | 5 secondary points/request; ≤80 content-generating req/min; **≤500/h**; ≥1 s spacing advised | docs |
| Read scopes | ✅ works with a `gh` OAuth token holding only `gist, read:org, repo, workflow` (**no `user` scope**) | live |
| Write scopes | undocumented ⚠️ — conservative choice is classic PAT `user`; fine-grained PATs may call GraphQL (since 2023-04-27) but no "Lists" fine-grained permission is documented | ⚠️ test before building |
| Private lists | `isPrivate` is real (5 private lists on the account), though the help page only describes public lists | live |
| Availability | all users except enterprise managed users | 2021 changelog |

⚠️ The project's existing fine-grained PAT ("Starring: Read", 02 §5) may cover reads/import; a push mirror likely needs a second secret. Decide after a one-time staging mutation test (create → delete a throwaway list) at implementation time.

### 2.3 Feasibility: three options

| Option | Meaning | Pros | Cons | Verdict |
|---|---|---|---|---|
| **(a) GitHub = source of truth** | starwatch reads/writes lists; no local groups | zero dual-write; GitHub UI is the editor | 32-list cap; no smart rules/colors/order; preview API; per-item replace mutations; unstar coupling; search still needs a local sync anyway | ✗ |
| **(b) Optional mirror** | local first: import once; opt-in push per group | unlimited local groups + all features; reuses existing 279-item curation; GitHub UI for the mirrored subset; degrades safely | dual-write conflicts; mutation budget; preview-API risk; unstar coupling | ✅ **recommended** |
| **(c) Not used** | ignore Lists entirely | simplest, zero API risk | discards existing lists; no round-trip | ✗ (v1 runs a read-only variant of (b)) |

**Recommendation:** (b), staged — v1 ships local-first groups plus a **read-only one-time import** (cheap, immediately useful, no mutation risk); v2 adds an explicit per-group **push mirror** for the subset the user wants visible in GitHub's UI.

### 2.4 Migration path if GitHub changes the API

Groups stay fully functional because D1 is authoritative. Rules for the mirror adapter:

1. Isolate all Lists calls behind a `GithubListsService` (returns `RemoteList`/`RemoteMembership` domain types); no GitHub types leak into core.
2. Keep the last raw snapshot in D1 (`github_list_items`, §4.5) so mappings can be rebuilt without re-reading.
3. Version sync state per group (`ok | drift | missing | error`); on auth/schema breakage flip mirrored groups to `error`, surfaces a warning, and keeps local membership intact — never auto-delete.
4. If only mutations break, degrade to import-only; if only fields rename, the fix is one adapter file.

## 3. Product design

### 3.1 Group kinds

| Kind | Membership | Evaluated | Typical use |
|---|---|---|---|
| `manual` | rows in `group_members` | static, at write time | "weekend projects", "to try next" |
| `smart` | none stored; optional `q` + filter rules | live SQL/FTS at query time | `language:rust stars>=500 topic:tui archived:false` |

Manual XOR smart in v1. Mixed groups ("rule plus pinned/blocked repos") are a v2 idea — the override semantics cause confusion and are not worth it yet. Smart groups are inherently self-maintaining: metadata changes (language, stars, archived) move repos, which is the point.

### 3.2 Flat, not nested

Recommend **flat**:

- 3,277 repos need facets, not a filesystem; a repo can be in many groups (tags) which nesting cannot express either.
- Search is the primary navigation (docs/00 goal); chips + filters beat tree-walking.
- GitHub Lists are flat and the mirror cannot represent nesting; flat keeps local and remote isomorphic.
- Nesting adds slug paths, cycle rules, CLI/UI tree rendering, and mirror mismatch — real cost, little benefit at "tens of groups".
- `position` gives manual ordering; prefix naming ("work:rust") can emulate grouping visually if ever needed.

Revisit only if a real corpus of 100+ groups emerges.

### 3.3 Saved searches as groups

**Yes — a smart group with an optional `q` is the saved-search object.** No separate entity. The search parser (docs/01 §7 step 1) already produces `{text, filters}`; "Save as group" persists exactly that as `rules_json`. Metadata-only smart groups compile to pure SQL; `q`-bearing groups evaluate through `SearchService` (FTS/hybrid leg).

### 3.4 Group metadata

| Field | Type | Notes |
|---|---|---|
| `name` | display string | unicode + emoji allowed; max ~60 chars |
| `slug` | ascii id | unique; `[a-z0-9][a-z0-9-]*`, ≤40 chars, **stable after creation** (renames keep slug) |
| `color` | palette token or `#rrggbb` | UI dot/chip color |
| `icon` | one emoji (grapheme) | optional, shown in chips |
| `description` | string | optional, shown in group detail |
| `position` | integer | local ordering only (GitHub has none); reorder rewrites 100-step positions |
| `kind`, `rules_json` | see §4.2 | smart only |

### 3.5 Auto-suggested groups (v2)

Two complementary sources:

1. **GitHub's own suggestions** — `viewer.suggestedListNames` already returns `[UserListSuggestion]` (e.g. 🔮 Future ideas, 🚀 My stack) for the viewer; surface them as one-click group templates.
2. **Workers AI classification** — pass repo summary vectors/metadata (or compact README snippets) through a small LLM to propose 3–8 groups with member lists. Cost estimate: ~3.3k repos × ~250-token prompts ≈ 0.8M input tokens per full pass; within Workers AI daily free neurons, and **< $1** even outside it at small-model pricing. Run quarterly, opt-in, writes only to a `source='ai'` membership the user reviews. Not in v1.

## 4. Data model

### 4.1 DDL (migration `0002_groups.sql`)

```sql
CREATE TABLE groups (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  slug              TEXT    NOT NULL UNIQUE,
  name              TEXT    NOT NULL,
  description       TEXT    NOT NULL DEFAULT '',
  kind              TEXT    NOT NULL DEFAULT 'manual' CHECK (kind IN ('manual','smart')),
  rules_json        TEXT,                        -- required iff kind='smart'
  color             TEXT    NOT NULL DEFAULT 'slate',
  icon              TEXT    NOT NULL DEFAULT '',
  position          INTEGER NOT NULL DEFAULT 0,
  -- GitHub Lists mirror (v2; empty/0 in v1)
  github_list_id    TEXT UNIQUE,                 -- UL_… node id
  github_mirror     INTEGER NOT NULL DEFAULT 0,  -- 0=off, 1=push
  github_sync_state TEXT NOT NULL DEFAULT 'off'
                    CHECK (github_sync_state IN ('off','ok','drift','missing','error')),
  github_synced_at  INTEGER,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);

CREATE TABLE group_members (
  group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  repo_id  INTEGER NOT NULL REFERENCES repos(id)  ON DELETE CASCADE,  -- numeric GitHub id
  source   TEXT    NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','import','ai')),
  added_at INTEGER NOT NULL,
  PRIMARY KEY (group_id, repo_id)
);

CREATE INDEX group_members_repo        ON group_members(repo_id);
CREATE INDEX group_members_group_order ON group_members(group_id, added_at DESC, repo_id DESC);
CREATE INDEX groups_position           ON groups(position, slug);
```

Notes: D1 enforces foreign keys; membership rows require a matching `repos` row. **Migration applies in one `db.batch()`** (D1 has no transactions, 02 §3.4). Add `repos.node_id TEXT` if not present — REST `/user/starred` already returns `node_id`; it is the only thing `updateUserListsForItem` accepts.

### 4.2 Smart-rule serialization

Versioned JSON on `groups.rules_json`:

```json
{
  "version": 1,
  "q": "durable jobs",
  "match": "all",
  "filters": [
    { "field": "language",    "op": "eq",  "value": "rust" },
    { "field": "stars",       "op": "gte", "value": 500 },
    { "field": "topics",      "op": "has", "value": "tui" },
    { "field": "starred_at",  "op": "gte", "value": "2024-01-01" },
    { "field": "archived",    "op": "eq",  "value": false }
  ]
}
```

- Field vocabulary is exactly docs/01 §4 (`language, stars, topics, starred_at, archived, license`) plus optional `q`; operators `eq/ne/has/gte/lte/in`.
- `match: "all"` only in v1 (AND); per-field arrays already give OR within a field.
- Compile to SQL against `repos` (+ `json_each(topics_json)`), always with `is_starred = 1` unless `--include-unstarred`.
- Unknown fields/operators fail validation at write time (`group create/edit`), not at search time.
- ⚠️ Topic rules inherit the Vectorize array limitation from docs/01 §4: they constrain the D1 leg and post-filter the semantic leg.

### 4.3 Query patterns

| Need | Query |
|---|---|
| Group list + counts | `SELECT … FROM groups` + count join (3.3k rows, live count is fine; no cache needed) |
| Strict membership filter | `EXISTS (SELECT 1 FROM group_members m WHERE m.repo_id = repos.id AND m.group_id IN (…))` |
| Smart group members | `SELECT id FROM repos WHERE …` from compiled rules |
| Repo → groups (chips, `show`) | `SELECT group_id FROM group_members WHERE repo_id = ?` + smart rules evaluated for that repo |
| Page a large group | keyset on `(added_at DESC, repo_id DESC)` — limit ≤100 |

### 4.4 Lifecycle

| Event | Behavior |
|---|---|
| Repo **unstarred** | GitHub also removes it from any mirrored lists. Local membership **stays** in `group_members`; group queries join `repos.is_starred = 1` by default. If the repo row is purged 90 days later (02 §5), CASCADE removes memberships; re-starring within the window restores group membership for free. |
| Repo **renamed/transferred** | id-stable (`repos.id`, `node_id`); membership untouched, display name follows `repos.full_name`. |
| Repo **deleted** | sync soft-deletes; mirror push skips it; memberships die with the repo row after retention. |
| Group **deleted** | `DELETE FROM groups` cascades memberships (one batch); smart groups delete only the rule row. |
| Group **renamed** | slug immutable; mirror matches by `github_list_id`, so rename pushes cleanly (v2). |

### 4.5 Mirror state table (v2 only)

`github_list_items(github_list_id TEXT, repo_node_id TEXT, seen_at INTEGER, PRIMARY KEY(github_list_id, repo_node_id))` — last snapshot of the remote membership; diff desired (local) vs this table to compute the minimal mutation set, and to detect remote drift.

## 5. Search integration

### 5.1 Flags

| Flag | Effect |
|---|---|
| `--group <slug>` (repeatable) | **strict filter**: repo must be in at least one listed group (OR) |
| `--group-all` | strict filter with AND: repo must be in **every** listed group |
| `--boost-group <slug>` (repeatable) | ranking-only boost; never filters |
| `--ungrouped` | repos in no manual group and matching no smart group |
| output | every result carries `groups: [{slug, name, color, icon, kind}]` chips |

All group flags compose with the docs/01 §4 filters (same AND across facets).

### 5.2 Multiple groups: OR by default

**Decide: repeated `--group` = OR (union); `--group-all` = intersection.** Reasoning:

1. Repeated-flag convention inside one facet is OR (e.g. `--lang rust --lang go`); groups are one facet.
2. The common intent is "search across these collections", especially in the multi-select WebUI (checkbox semantics).
3. Intersection is rare, still expressible (`--group-all`), and cheap to implement as `INTERSECT` over candidate sets.
4. AND-by-default would silently return zero results when a user widens selection — the worst failure mode.

### 5.3 How strict group filters reach the two legs

Both kinds resolve to a **candidate repo-id set in D1 first** (manual: `group_members`; smart: compiled rules; OR = `UNION`, `--group-all` = `INTERSECT`, `--ungrouped` = complement):

1. **Lexical leg (D1/FTS5):** `EXISTS`/`IN` as in §4.3 — exact, cheap.
2. **Semantic leg (Vectorize):** pre-filter with `{ "repo_id": { "$in": [...] } }` **iff** the compact JSON stays under the **2,048-byte filter limit** — roughly ≤150 nine-digit ids. Otherwise post-filter the unfiltered top-50 (metadata) / top-100 (ids-only) by membership and fuse normally. Small groups therefore get exact recall; mid-size groups accept some recall loss (⚠️ the main quality caveat; could be revisited with a `primary_group` metadata field later).
3. **Vectorize prerequisite:** add `repo_id` as a **number metadata index from day 1** (6th of 10 allowed). Metadata indexes only cover vectors upserted *after* creation — adding it later forces a 23k-vector re-upsert. Nearly free at our scale, but avoid the retrofit.

### 5.4 Ranking boost

`--boost-group` leaves result sets unchanged and applies after RRF fusion at repo level: `score_final = score_fused × (1 + 0.25 × min(n, 2))` where `n` = number of boosted groups containing the repo (cap ×1.5). One tunable constant; no filter interaction; boost when `--group` is also present is allowed but redundant.

### 5.5 Chips and MCP (v2)

- Result chips are computed for the returned page in one batched query (manual joins + smart rules evaluated against the page's repo ids) — no per-result scan.
- MCP tools later: `search_stars` gains `group`/`group_mode`/`boost_group` params; new read tools `list_groups`, `get_group`; write tool `add_to_group` is opt-in (a rogue agent organizing stars is worse than a rogue search). All take slugs, never ids, so prompts read naturally ("find it in **weekend projects**").

## 6. Interface contract

### 6.1 Contract surface (RPC for CLI + HttpApi for WebUI, per 02 §2/§6)

| Operation | Contract name | HTTP route | Data model |
|---|---|---|---|
| List groups (+counts) | `groups.list` | `GET /groups` | `groups` + counts/rules eval |
| Create | `groups.create` | `POST /groups` | insert `groups` |
| Get one | `groups.get` | `GET /groups/:slug` | group + members (paged) |
| Edit metadata/rules | `groups.update` | `PATCH /groups/:slug` | update `groups`; kind change resets members for smart |
| Delete | `groups.delete` | `DELETE /groups/:slug` | delete cascade |
| Add members (bulk) | `groups.addMembers` | `POST /groups/:slug/members` | `INSERT OR IGNORE` batch; rejects smart groups |
| Remove members (bulk) | `groups.removeMembers` | `DELETE /groups/:slug/members` | delete batch; rejects smart groups |
| List members | `groups.members` | `GET /groups/:slug/members?limit&cursor` | keyset paging (§4.3) |
| Reorder | `groups.reorder` | `PUT /groups/reorder` | rewrite 100-step positions in one batch |
| Import from GitHub | `groups.importGithub` | `POST /groups/import` | read-only Lists snapshot → local groups |
| Mirror toggle/sync (v2) | `groups.mirror` | `POST /groups/:slug/mirror` | `github_mirror`/state + adapter |

Bulk add accepts `full_name` or numeric id (resolved server-side); payloads deduped and idempotent. Membership writes are D1 batches (no transactions available).

### 6.2 CLI (details → docs/05-cli.md; a parallel draft exists — command group is `groups`)

```
starwatch groups list [--kind manual|smart] [--json]
starwatch groups create <name> [--emoji 🔮] [--color teal] [--description "..."]
starwatch groups show <slug> [--limit 50] [--cursor ...]
starwatch groups rename <old> <new>           # slug unchanged
starwatch groups edit <slug> [--emoji|--color|--description]
starwatch groups delete <slug> [--yes]
starwatch groups add <slug> <repo...> [--stdin]
starwatch groups remove <slug> <repo...> [--stdin]
starwatch groups reorder <slug> --before <slug> | --position <n>
starwatch groups rules <slug> [--set "language:rust stars>=500"] [--show]
starwatch groups import-github [--dry-run]    # one-time GitHub import (≠ `groups import` file merge)
starwatch search "..." --group <slug> [--group <slug>...] [--group-all] [--boost-group <slug>] [--ungrouped]
starwatch show <repo>                         # includes its groups
# v2: starwatch groups mirror <slug> on|off ; starwatch groups sync-github [--force]
```

⚠️ **Deltas for 05-cli.md:** the parallel draft already has `groups list/create/show/add/remove/rename/delete` and `--group` repeat=OR. To absorb: `--group-all`, `--boost-group`, `--ungrouped`, `groups rules`, `groups reorder`, `groups import-github`, and an export-format v2 that carries metadata (`color/icon/description/kind/rules`) — 05's current `{"groups":{"inbox":[...]}}` loses everything but names/members.

### 6.3 WebUI (details → docs/06-webui.md)

- Left sidebar: group list with colored emoji chips + counts; "New group" inline.
- Result cards: chip row; clicking a chip re-filters; hover → "add to group" popover (multi-select).
- Repo drawer: group toggles + "create group from this repo".
- Group page: members (paged), edit metadata, smart-rule builder mirroring the search filters.
- Search bar: filters become chips; "Save search as group".

## 7. Edge cases & workarounds

| Case | Behavior / workaround |
|---|---|
| >32 groups vs GitHub cap | local groups unlimited; mirror flag only on ≤32 selected groups; sync checks `lists.totalCount` and marks overflow `off` — never auto-deletes or merges |
| GitHub list deleted remotely | snapshot diff finds the `UL_…` id missing → `github_sync_state='missing'`, local group intact; user chooses unlink or recreate |
| GitHub list renamed/private toggled remotely | matched by id; local name wins on push; surface a drift notice with both names |
| Name collisions | local: `slugify` (NFKD, casefold, strip emoji/punctuation, collapse `-`, ≤40 chars as in 05-cli.md) + `-2` suffix; remote duplicate names unverified ⚠️ — always match by id |
| Unstar vs membership | GitHub drops membership on unstar; local keeps rows (soft) and hides unstarred repos from results; mirror push **skips** unstarred repos so it cannot fight GitHub |
| Smart rules + changing metadata | intended churn (stars crossing a threshold, language reclassification); chips computed live; `group show` warns on rules matching 0 repos or unknown values |
| Empty groups | allowed; count 0; WebUI empty state; smart empty due to over-restrictive rules gets a hint |
| Duplicate memberships | PK `(group_id, repo_id)` + `INSERT OR IGNORE`; bulk ops idempotent |
| Mirror push conflicts | one-way push only; before each sync re-snapshot remote, diff against `github_list_items`; unpushed remote changes → `drift`, require `--force` to overwrite (no two-way automerge in v1/v2) |
| Large-group pagination | keyset cursor (≤100/page); search never materializes members, it joins/exists |
| Mirror mutation budget | ≤500 content requests/h, ≥1 s spacing; a 300-item group push ≈ 300 mutations (fits one hour); initial mirror is a deliberate, resumable job |
| Stale Vectorize membership index | membership changes only touch D1; the `repo_id` metadata filter is an id-based pre-filter, so no re-embedding on group edits |

## 8. Recommended scope

| | v1 | v2 |
|---|---|---|
| Data model + indexes | ✅ `0002_groups.sql`, `repo_id` Vectorize index from day 1 | — |
| Manual groups | ✅ CRUD, bulk add/remove, reorder, colors/emoji | pinned/blocked overrides for smart groups |
| Smart groups | ✅ metadata rules + optional `q` (saved search) | mixed rules + manual overrides |
| Search | ✅ `--group` (OR/`--group-all`), `--boost-group`, `--ungrouped`, chips | smarter mid-size group semantic recall |
| Interfaces | ✅ HTTP/RPC + CLI + WebUI | MCP read tools + `add_to_group` (write) |
| GitHub | ✅ read-only one-time import | opt-in push mirror + drift reports |
| AI | — | suggested groups (GitHub `suggestedListNames` + Workers AI classification, reviewed before commit) |
| Nested groups | — | not recommended; revisit only at 100+ groups |

## 9. Open questions

1. **Mirror write scope** — do Lists mutations work with the existing fine-grained PAT or a classic `user` token? One staging mutation test answers it (⚠️ can't be verified read-only).
2. **Group cap for smart groups** — none locally; should the WebUI soft-warn at ~20 for UX?
3. **Boost weight** — start at ×1.25/group (cap ×1.5); tune after first real searches.
4. **Import mapping** — one local group per GitHub list, or skip obvious duplicates/empty lists? (e.g. the two "sink" lists).
5. **`--ungrouped` cost** — complement of 32 groups over 3.3k repos is fine, but should it include smart-group membership (more SQL) or only manual?
6. **Retention** — keep membership rows through the 90-day unstar window (proposed) or drop immediately?

## Sources (load-bearing, verified 2026-09-13)

- GraphQL schema + live introspection as `coldter` (22 lists, 279 items; `rateLimit.cost` = 1; `lastAddedAt` DESC ordering; private lists; `suggestedListNames`)
- GraphQL reference — Users & Mutations: <https://docs.github.com/en/graphql/reference/users> · <https://docs.github.com/en/graphql/reference/mutations>
- Lists added to GraphQL schema on 2023-11-30: <https://docs.github.com/en/graphql/overview/changelog/2023>
- Rate limits / point formula / secondary limits: <https://docs.github.com/en/graphql/overview/rate-limits-and-node-limits-for-the-graphql-api>
- Lists docs ("public preview … subject to change"): <https://docs.github.com/en/get-started/exploring-projects-on-github/saving-repositories-with-stars>
- No REST endpoints: official OpenAPI description, <https://github.com/github/rest-api-description>
- Unstar removes list membership (GitHub staff): <https://github.com/orgs/community/discussions/9315>
- 32-list cap (community, not official): <https://github.com/orgs/community/discussions/46887> · <https://github.com/orgs/community/discussions/179038>
- Fine-grained PATs can call GraphQL (2023-04-27): <https://github.blog/changelog/2023-04-27-graphql-improvements-for-fine-grained-pats-and-github-apps>
- Vectorize limits (topK 50/100, 10 metadata indexes): <https://developers.cloudflare.com/vectorize/platform/limits/>
- Vectorize filter size <2,048 bytes; index-before-upsert rule: <https://developers.cloudflare.com/vectorize/reference/metadata-filtering/>
