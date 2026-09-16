# 16 — Search Quality Teardown: What the Good Directories Do

> Status: **draft for discussion** · 2026-09-13 · Companion to [07](07-search-contract.md) (ranking/filters contract) and [15](15-free-semantic-search.md) (free semantic design). Free-tier constraints from [13](13-free-tier-feasibility.md)–[15](15-free-semantic-search.md) bound every recommendation below: no paid search engine, no per-query LLM in the default path. ⚠️ = observed live but not source-verifiable, or needs eval before shipping.
> Trigger: the quality bar — `auth` with `language=typescript` must surface something like better-auth, logto, and authz-style projects, with openalternative.co as the feel-good reference.

## 0. Verdict up front

| Reference               | What it gets right                                                                                                                                                                            | What it gets wrong                                                                                                                                                                                               | Pattern starwatch should take                                                                                                                                         |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **OpenAlternative**     | Taxonomy does the work: hand-curated "alternatives to X", categories, stacks, topics; facet counts; vector-based "similar projects"; typo-tolerant live search                                | Listing search has almost no relevance model (default sort = featured + health score); no README content; quality depends on human curation and curated product-name descriptions                                | Fuzzy/typo tolerance expectation; topic/category as a ranking signal; facet counts; a "similar projects" rail; one-word head terms resolve to a cluster of intents    |
| **GitHub repo search**  | Best-in-class qualifier grammar (`language:`, `topic:`, `stars:`, `in:readme`, …); exact filter semantics; sort menu                                                                          | Ranks on name/description/topics + global popularity; `auth language:typescript` puts a 1.4k-star action first and misses Logto entirely; no semantic leg; no typo correction; no `is:starred`; 1,000-result cap | The filter subset in [07 §4.1](07-search-contract.md) is right; `in:readme` is the exact gap starwatch exists to fill; never let global popularity be the tie-breaker |
| **npm registry search** | Exact-name boost (`boost-exact`, default on); keywords are a first-class searchable field; query qualifiers (`keywords:`, `author:`, `not:deprecated`); every result shows why (score detail) | Dominated by download popularity; metadata only (no README content, no semantics); scope noise; not scoped to "what I saved"                                                                                     | Keyword/topic field weighting; inline qualifiers; deprecation/archived as explicit filters; keep `--explain` score reasons                                            |

The short version: **OpenAlternative wins with taxonomy + vector similarity, GitHub wins with filters, npm wins with name/keyword scoring — and none of them can do "search my own stars for a concept."** starwatch's hybrid over READMEs is the differentiator; it needs the three references' good parts (fuzzy tolerance, topic/name boosts, facet counts, similar rail) without their crutches (human curation, global popularity, paid engines).

### 0.1 Evidence and limits

Evidence used, strongest first: **source code** (OpenAlternative fork mirror @ `d8a53e2`, Nov 2025), **official docs**, **live HTML probes** (curl, RSC/JSON-LD parsed, no JS, 2026-09-13), **live API probes** (`gh search repos`, npm `/-/v1/search`). Limits: no connected browser was available, so OpenAlternative's ⌘K palette was not exercised interactively (mechanics are source-verified, not user-verified); its current live listing-search backend is ⚠️ (the app repo was repurposed, and live behavior is fuzzier than the Nov 2025 source explains); GitHub and npm publish no ranking weights, so rank orders below are observed, not explained.

### 0.2 Reference behavior scorecard (observed, 2026-09-13)

| Behavior                                   | OpenAlternative                                 | GitHub repo search                    | npm registry search                                 | starwatch target                         |
| ------------------------------------------ | ----------------------------------------------- | ------------------------------------- | --------------------------------------------------- | ---------------------------------------- |
| Exact name (`better-auth`)                 | #1 (live)                                       | strong but not dominant (`auth` → #3) | #1 on exact package name                            | top-1 ([07 §3.2](07-search-contract.md)) |
| Concept (`open source auth0 alternative`)  | auth cluster via curated descriptions + vectors | 2 results, near-zero relevance        | no semantic leg                                     | ≥1 grade-2 in top-3 for Q4               |
| Typo (`aith0`, `postgress`)                | recovers the intent (live)                      | `bettar-auth` → 0 results             | not verified ⚠️ (exact boost will not fix the name) | recovered via trigram + query embedding  |
| Filter correctness (`language=typescript`) | filter rail works; query+filter cached together | exact and reliable                    | qualifiers exact                                    | 1.000 precision, hard assert             |
| Result reasons (snippet/highlight)         | tagline only; no matched text                   | description only; no matched text     | CLI highlights matched terms                        | `<mark>` snippet + `--explain`           |
| "Similar to X"                             | live vector rail (limit 3, threshold 0.7)       | none                                  | "dependents" count only                             | summary-vector rail                      |
| Empty state                                | "No tools found", filters stay visible          | "no repositories" + syntax hints      | clean 0                                             | [08 §3.4](08-public-service-ux.md) copy  |
| Cost to reproduce                          | Meili + OpenAI + editors                        | closed, global index                  | registry scoring + download counts                  | $0, Cloudflare-only                      |

## 1. OpenAlternative teardown

### 1.1 Where the code lives (provenance)

The primary repo **github.com/piotrkulpinski/openalternative was repurposed in 2026 as an awesome-list** (verified 2026-09-13; its README points to Dirstarter as the successor boilerplate). The Next.js app code survives in forks; this teardown reads **`OpenSourceAppStore/openalternative` @ `d8a53e2` (Nov 2025)**, the most complete mirror, cross-checked against live behavior on 2026-09-13.

Stack: Next.js (App Router, RSC) · Prisma/Postgres · **Meilisearch** (self-hosted) · OpenAI `text-embedding-3-small` for embeddings · PostHog analytics.

### 1.2 Three distinct search surfaces

There is **no search page and no `/api/search` route**: search lives in a listing query, a ⌘K palette, and a related-items rail. There is also **no Typesense/Algolia/Postgres FTS** anywhere in the stack — listing search is plain SQL `contains`, and the palette is the only proper search engine (Meilisearch).

| Surface                                                                        | Code                                                                                | Mechanics                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Listing / category search** (search box on `/`, `/alternatives`, categories) | `server/web/tools/queries.ts` `searchTools()`                                       | Prisma `contains` case-insensitive OR over `name`, `tagline`, `description`; filters `alternative[]`, `category[]`, `stack[]`, `license[]`; sort `default` (= `isFeatured desc, score desc`) or `publishedAt/pageviews/name/stars/forks/lastCommit/firstCommit`; server-side pagination (35/page); results cached (`unstable_cache`, tag `tools`)                                                                                                                                                                                                                                   |
| **⌘K global palette**                                                          | `actions/search.ts`, `scripts/setup-meilisearch.ts`, `components/common/search.tsx` | **Meilisearch hybrid**: 3 indexes (`tools`, `alternatives`, `categories`), `semanticRatio: 0.5`, `rankingScoreThreshold` 0.5 (tools/alternatives) / 0.6 (categories), `filter: status='Published'`, sort `isFeatured:desc, score:desc`; ranking rules `words → typo → proximity → attribute → sort → exactness → isFeatured:desc → score:desc → pageviews:desc`; searchable attrs include `categories`, `alternatives`, `topics`; embedder document template = `name / tagline / description / categories / alternatives`; 500 ms debounce; footer shows total hits + processing ms |
| **"Similar open source projects" rail**                                        | `server/web/tools/queries.ts` `findRelatedTools()` → Meili `searchSimilarDocuments` | Embedding similarity over the same tools index: `limit: 3`, `rankingScoreThreshold: 0.7`, `embedder: openAi`; rendered on every tool page (live-confirmed)                                                                                                                                                                                                                                                                                                                                                                                                                          |

### 1.3 Taxonomy, filters, curation, ranking signals

- **Taxonomy is the product.** `alternatives` = hand-curated proprietary products a tool replaces (Auth0, Supabase, Firebase…); `categories` = hand-curated hierarchy with `fullPath`; `stacks` = auto-derived from an external repo analyzer; `topics` = **auto-imported from GitHub repo topics** (`lib/repositories.ts`); `license`; `isSelfHosted` is derived from the topics `selfhosted`/`self-hosted`.
- **Filters have counts.** `actions/filters.ts` returns every filter option with `{slug, name, count: _count.tools}`; the UI shows removable chips + "Clear all".
- **No synonym dictionary.** `setup-meilisearch.ts` configures no Meilisearch `synonyms`; intent bridging comes from the curated `alternatives` field being searchable (a tool page is indexed with the proprietary products it replaces) plus vector similarity. Compare: GitHub has no synonym layer at all; npm approximates one with `keywords:`.
- **Ranking signal is a health score** (`lib/github/utils.ts` `calculateHealthScore`): `0.25·stars + 0.25·forks + 0.5·contributors + 0.25·watchers`, all scaled by an age factor (0.5–1.0), minus up to 45 points for last-commit staleness. It is a popularity/freshness prior, not relevance; `isFeatured` (paid/editorial placement) sorts above it.
- **Human curation at every quality touchpoint**: submissions reviewed, alternatives/categories manually assigned, "alternatives to X" pages hand-built. There is no editors-free path to this taxonomy.
- Machine-readable results: category/listing pages embed a schema.org `ItemList` with `numberOfItems`.

### 1.4 Live probes (2026-09-13, curl, no JS)

| Probe                                  | Observable result                                                                                          | Reading                                                                                                                      |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `/search?q=auth`                       | **404** — no `/search` route exists; global search is the ⌘K palette                                       | Don't copy URL patterns blindly; their search lives in overlay + filters                                                     |
| `/?q=auth`                             | 39 tools, first: Hanko, Supabase, LiteLLM, PocketBase, Cal.com, Keycloak, **Better Auth (#7)**, JumpServer | Hybrid-looking clustering of auth tools; not pure substring                                                                  |
| `/?q=aith0`                            | 12 tools: Hanko, Keycloak, Better Auth, Authentik, Zitadel, **Logto**, SuperTokens, Ory                    | ⚠️ **Typo tolerance + intent recovery** — "aith0" returns the auth cluster                                                   |
| `/?q=better-auth`                      | Better Auth #1, then 6 semantically adjacent tools                                                         | Exact match first, semantic neighbors after                                                                                  |
| `/categories/.../databases?q=postgres` | 17 results (Neon Postgres, TimescaleDB…)                                                                   | Substring/fuzzy field search                                                                                                 |
| `…?q=postgress` (typo)                 | **Same 17 results**                                                                                        | ⚠️ Live listing search is fuzzy (the Nov 2025 source `contains` cannot explain this; likely upgraded — backend unverifiable) |
| `…?q=zzzz`                             | 0 results                                                                                                  | Honest empty state                                                                                                           |
| `/?q=auth&sort=stars.desc`             | Reordered correctly (Supabase first)                                                                       | Sort independent of query                                                                                                    |
| Result cards                           | Tagline only; **no matched-text snippet, no `<mark>` highlight**; facet counts shown                       | Highlighting/snippets are a starwatch advantage                                                                              |
| Tool page                              | Rendered "Similar open source projects" section                                                            | Vector related-items rail works in production                                                                                |

### 1.5 What transfers / what doesn't

**Transfers:** typo/fuzzy tolerance as a baseline expectation; topic/category as _searchable and rankable_ fields, not just filters; facet counts + removable chips; a capped, thresholded "similar projects" rail; scores/freshness as small priors (never the primary order); a one-word head term should open a _cluster of intents_, which they achieve with curated alternatives — starwatch must achieve it with topics + semantics.
**Doesn't transfer:** the curated taxonomy (no editors, per-user corpora), metadata-only embedding (their descriptions are written to say "open-source X alternative"; ours are not), `isFeatured` paid ordering, Meilisearch + OpenAI (cost + ops outside the zero-spend design).

## 2. GitHub repository search

### 2.1 Mechanics (docs + live)

- **Default match fields: name, description, topics.** README is searched **only** with `in:readme` — never scoped to your stars; that is the founding gap in [00 §1](00-requirements.md).
- **Qualifiers** ([docs](https://docs.github.com/en/search-github/searching-on-github/searching-for-repositories)): `in:name,description,topics,readme`, `language:`, `topic:`, `stars:`, `forks:`, `followers:`, `size:`, `created:`, `pushed:`, `license:`, `archived:`, `is:public`, `fork:`, plus sort (`sort:stars` etc.). No `is:starred`; global search caps at 1,000 results.
- **Default order is "best match"** (relevance + popularity prior); sort menu offers stars/forks/updated. GitHub does not publish its ranking weights; observed behavior is exact-name strength plus repository popularity.
- **Filters are exact constraints** — `language:typescript` reliably restricts; the ranking inside that filter is what fails.

### 2.2 Live probe: the quality-bar query

`gh search repos "auth language:typescript"` (default best match, 2026-09-13), top 8:

| Rank | Repo                                  | Stars  |
| ---- | ------------------------------------- | ------ |
| 1    | google-github-actions/auth            | 1,385  |
| 2    | nextauthjs/next-auth                  | 28,367 |
| 3    | **better-auth/better-auth**           | 29,919 |
| 4    | lucia-auth/lucia                      | 10,449 |
| 5    | anomalyco/openauth                    | 7,396  |
| 6    | Authenticator-Extension/Authenticator | 4,667  |
| 7    | auth0/nextjs-auth0                    | 2,307  |
| 8    | adonisjs/auth                         | 222    |

- **logto-io/logto (14,532 stars) is absent from the top 30.** It is a canonical "auth, TypeScript" answer and GitHub's own search cannot find it for `auth` because its name contains neither "auth" nor an exact description token that beats the prior.
- `bettar-auth` (typo of better-auth) → **0 results**; `supabse` does not surface Supabase. No typo correction.
- `open source auth0 alternative language:typescript` → 2 results (2 stars, 0 stars). No semantic leg.
- `"durable jobs"` → irrelevant micro-repos; no hatchet/bullmq-class projects. Conceptual queries fail outright.

### 2.3 Reading for "find a library for X"

**Good:** exact, composable filters; predictable qualifier grammar; no editorial ranking. **Bad:** ranking is name-match + global popularity; README invisible by default; semantic intent invisible always; typos fatal; results global, so a 30k-star project crowds out the niche repo you actually starred. starwatch is the same query over a _personal_ corpus — the popularity prior collapses to a small, tasteful boost ([07 §5.3](07-search-contract.md) caps it at ×1.25).

## 3. npm registry search

### 3.1 Mechanics (registry docs + live)

- `GET /-/v1/search?text=…` returns `{package, score, searchScore, flags}`; the docs define a **quality / popularity / maintenance** score and query weights, plus **`boost-exact:true` by default** — an exact package-name match is deliberately boosted ([registry API docs](https://github.com/npm/registry/blob/main/docs/REGISTRY-API.md#get-v1search)).
- **Query qualifiers**: `author:`, `maintainer:`, `scope:`, `keywords:` (`,`=OR, `+`=AND, `,-`=exclude), `not:unstable`, `is:insecure`, `boost-exact:false`.
- `npm search` CLI is a legacy linear lexical search over registry metadata with **matched-term highlighting** and `--searchopts/--searchexclude`; results are limited (default 20).
- No README/content retrieval, no semantic leg; the 2026 live API returns a single `searchScore` with all `score.detail` values at 1 for top hits ⚠️ (scoring internals have changed; don't design against the old decomposition).

### 3.2 Live probe (2026-09-13)

| Query                          | Observed                                                                                                                |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| `text=auth`                    | #1 package literally named `auth` (exact boost); then `basic-auth`, `@supabase/auth-js` — keywords + downloads dominate |
| `text=keywords:authentication` | 12,949 results; scoped keyword filter works                                                                             |
| `text=author:sindresorhus`     | 940 packages; author filter works                                                                                       |
| `text=auth not:deprecated`     | Deprecation exclusion works                                                                                             |

### 3.3 Reading for "find a library for X"

**Good:** name is the strongest signal (exact boost), keywords are a first-class searchable field, and filters are spelled into the query. **Bad:** download popularity is the implicit prior; metadata-only means a well-named but poorly described library is invisible; "auth" returns a noise floor of scoped packages. Transferable: **field weighting** (name ≫ keywords ≫ description), **exact-name boost** (already in [07 §5.3](07-search-contract.md)), a small **qualifier grammar**, and explicit `archived`/deprecated filters.

## 4. Mechanics → starwatch transfer matrix

| Mechanic                                                                                         | Reference                                                                 | starwatch equivalent                                                                                                                       | Cost (free tier)  | Verdict                         |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ----------------- | ------------------------------- |
| Exact-name boost (default on)                                                                    | npm, OA exactness, GitHub                                                 | [07 §5.3](07-search-contract.md) ×1.60/×1.45/×1.20                                                                                         | 0                 | ✅ already specified            |
| **Name-token boost** (query token is one of the repo name's tokens, e.g. `auth` → `better-auth`) | GitHub/npm behavior                                                       | New boost family ×1.10–1.15; eval-gated                                                                                                    | 0                 | **adopt (v1)**                  |
| Topic/keyword as weighted searchable field                                                       | npm `keywords:`, OA Meili searchable attrs                                | FTS5 column weights `bm25(fts, name, desc, topics, readme)` + topic-match boost                                                            | 0                 | **adopt (v1, tune by eval)**    |
| Query qualifiers (`lang:`, `topic:`, `stars:>=`)                                                 | GitHub, npm                                                               | Extend the [07 §7](07-search-contract.md) parser; same filter struct as CLI/MCP                                                            | parse only        | **adopt (v1.5)**                |
| Facet counts + removable chips                                                                   | OA (`{slug,name,count}`), GitHub sidebar                                  | D1 `GROUP BY` counts, precomputed per `index_version` ([13 §4.2](13-free-tier-feasibility.md))                                             | 1 cached query    | **adopt (v1)**                  |
| "Similar projects" rail (threshold + cap)                                                        | OA `searchSimilarDocuments` (0.7, limit 3)                                | `similar` from summary vectors, score threshold, 3–6 items on repo detail                                                                  | one kNN scan      | **adopt (v1)**                  |
| Typo tolerance                                                                                   | OA live (`postgress`=`postgres`, `aith0`→auth cluster), Meili `typo` rule | FTS5 trigram + the query embedding (semantic is naturally typo-tolerant); optional "did you mean" over names/topics via trigram similarity | one trigram query | **adopt (v1); no fuzzy engine** |
| Intent expansion for short head terms (`auth`, `db`, `ui`)                                       | OA's curated alternatives act as one; npm keywords approximate it         | Small static map (~20–30 heads) → OR-expanded lexical terms + appended semantic text; off for known-item                                   | 0                 | **adopt (v1.5, eval-gated)**    |
| Score decomposition in output                                                                    | npm `score.detail`; starwatch `--explain`                                 | Keep `rrf`/boosts/rerank in `--explain` and `--json`                                                                                       | 0                 | ✅ already specified            |
| Snippets + highlighting                                                                          | npm CLI highlighting; OA/GitHub have none                                 | [07 §6](07-search-contract.md) `<mark>` snippets                                                                                           | ~0                | ✅ differentiator, keep         |
| Honest counts + empty states                                                                     | All three                                                                 | [08 §3.4](08-public-service-ux.md)                                                                                                         | 0                 | ✅ already specified            |
| Global popularity prior as primary rank                                                          | GitHub stars, npm downloads                                               | Banned; star prior is capped ×1.25 and is only a prior                                                                                     | 0                 | **never copy**                  |
| Human-curated taxonomy                                                                           | OA alternatives/categories                                                | Generated collections + user groups ([08 §4](08-public-service-ux.md))                                                                     | D1 aggregates     | **cannot copy**                 |

## 5. Patterns to adopt — checklist

Mapped to the stack the docs already fix (D1 FTS5 + repo-level R2/int8 vectors + RRF + filters).

1. **Fix the routing hole for head terms.** `auth` is a single token → [07 §7.4](07-search-contract.md) sends it to **keyword-first**, and lexical never returns 0, so the semantic leg never runs. Recommend: single-token queries that are not an exact/prefix `full_name` match run **hybrid by default** (`similar` and explicit `--mode keyword` stay explicit). Cost is one query embed + a filtered gather-dot scan (~0.4 ms/1k candidates in [15 §4](15-free-semantic-search.md)); eval must show no known-item regression. Doc [17 §1](17-query-understanding-ranking.md) now owns the taxonomy/routing refresh — this item is the reference-derived rationale, not a competing spec.
2. **Add a name-token boost.** Query token ∈ repo-name tokens (≥3 chars, not a stopword) → ×1.10–1.15. This is what makes `auth` order `better-auth`/`next-auth`/`authz` above generic README mentions, and it is distinct from the exact/prefix boosts already specified.
3. **Weight fields like npm weights keywords.** `bm25(repos_fts, w_name, w_desc, w_topics, w_readme)` with `name ≫ topics > description > readme`; query-token match against `repos.topics_json` adds a small boost (OA ranks categories/alternatives as attributes, npm ranks keywords).
4. **Static intent map for ambiguous heads** (v1.5, eval-gated): `auth → authentication, authorization, oauth, oidc, 2fa, sessions`; `db → database, postgres, sqlite`; `orm`, `queue`, `ui`, `cli`… Expand the lexical leg with OR terms and append to the semantic query text. This substitutes for OA's curated "alternatives" taxonomy at zero cost; it must be off for known-item queries and proven on Q5/Q8 before shipping. Specified in doc [17 §2](17-query-understanding-ranking.md); the pattern is borrowed from OA's alternatives taxonomy and npm's keyword field.
5. **Qualifier subset in the query box**: `lang:`, `topic:`, `stars:>=`, `archived:false`, `license:` parsed into the existing filter struct (GitHub's grammar, six or seven qualifiers, not thirty).
6. **Facet counts, precomputed.** Language/topic/group counts per `index_version`; render as the [08 §3.4](08-public-service-ux.md) filter rail with removable chips; never recompute on the request path ([13 §4.2](13-free-tier-feasibility.md)).
7. **`similar` rail on repo detail** with a cosine threshold and cap 3–6, fed by summary vectors; label it plainly ("Similar repos"), mirroring OA's live section.
8. **Typo path**: trigram for identifiers, query embeddings for word-level typos; optionally a `did_you_mean` from trigram similarity over repo names/topics. No typo-tolerant engine, no vocabulary index.
9. **Golden-set additions** ([07 §3.3](07-search-contract.md)): `auth --lang typescript` (graded: better-auth/logto/authz-class repos present in the user's stars), `authz`, a typo case (`postgress`, `aith0`), a paraphrase case (`open source auth0 alternative`), and a negative (`zzzz`). Assert filter precision 1.000 on the mixed case.
10. **Keep and advertise the differentiators**: matched-text snippets with `<mark>` (none of the three references do it), `--explain` score reasons, and honest coverage states.

## 6. Cannot / should not copy

| Not copyable                                                                                          | Why                                                                                                                                                                                                                    |
| ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Human curation** (OpenAlternative's alternatives/categories, editorial `isFeatured`)                | No editors; corpora are per-user and machine-generated. Replace with generated collections, user groups, `similar`, and topic-derived signals                                                                          |
| **Paid search engines/models** (Meilisearch Cloud, Algolia, Typesense, OpenAI embeddings)             | Zero-spend mandate ([13](13-free-tier-feasibility.md), [15](15-free-semantic-search.md)); self-hosting Meili adds ops and violates the CF-only latency story. D1 FTS5 + Workers AI + in-Worker kNN is the whole budget |
| **Global popularity as primary rank** (GitHub stars, npm downloads)                                   | The personal corpus is the point; a global prior drowns the niche repo you saved. Star prior stays capped (×1.25)                                                                                                      |
| **Curated product-name taxonomy** ("alternatives to Auth0")                                           | Requires a product graph and editors; per-user scale makes it impossible. Topics + semantic similarity are the cheap approximation                                                                                     |
| **Metadata-only semantic space**                                                                      | OA's curated descriptions name the alternatives they replace; starwatch READMEs are written by maintainers for users. Distilled README + metadata embeddings are required                                              |
| **GitHub's full qualifier vocabulary** (`in:`, `size:`, `followers:`, `good-first-issues:`, `props.`) | Parse ambiguity, FTS-safety surface, and near-zero user value at 3.4k repos. Adopt 6–8 qualifiers                                                                                                                      |
| **1000-result caps / deep pagination**                                                                | A 3.4k-repo corpus means the failure is relevance, not recall; never truncate silently anyway                                                                                                                          |
| **Sourcegraph/Libraries.io models**                                                                   | Code/regex search is out of scope ([07 §8](07-search-contract.md)); Libraries.io ranks by dependency counts across ecosystems and adds no per-user signal. Considered, not chosen                                      |

## 7. Acceptance scenario: `auth --lang typescript`

If the account's stars include auth libraries, the search must return, in the top ~10:

- `better-auth` and similar "authentication framework" repos (name-token boost + semantic README),
- `logto`-class "open-source Auth0 alternative" repos (semantic leg; GitHub global search misses these entirely),
- `authz`/authorization repos (topic boost + semantic),
- every result actually `TypeScript` (filter precision 1.000).

Mechanics that produce it: hybrid routing (step 1) + name-token boost (step 2) + topic weighting (step 3) + RRF over FTS5 and the repo vector, with the language filter resolved to a `repo_id` set before the in-Worker scan ([15 §4](15-free-semantic-search.md)). Doc [17 §3.7](17-query-understanding-ranking.md) carries an illustrative ranking run for this exact query. Failure modes to watch in eval: a low-star repo literally named `auth` winning on exact-name boost (canary), and the intent map flooding results with OAuth-only repos (track precision, not just recall).

## Sources

**OpenAlternative** (app code read from a fork; the primary repo was repurposed into an awesome-list in 2026):

- Mirror: <https://github.com/OpenSourceAppStore/openalternative> @ `d8a53e2` (Nov 2025) — `services/meilisearch.ts`, `scripts/setup-meilisearch.ts`, `actions/search.ts`, `server/web/tools/queries.ts`, `config/search.ts`, `components/common/search.tsx`, `lib/github/utils.ts`, `lib/repositories.ts`, `actions/filters.ts`.
- Primary (now awesome-list): <https://github.com/piotrkulpinski/openalternative> · successor boilerplate: <https://dirstarter.com> · Meilisearch: <https://www.meilisearch.com>.
- Live probes 2026-09-13: `openalternative.co/search?q=auth` (404), `/?q=auth` (39), `/?q=aith0` (12), `/?q=better-auth` (7), `/categories/infrastructure-operations/databases?q=postgres|postgress|postgresql|zzzz` (17/17/17/0), `/supabase` ("Similar open source projects").

**GitHub repo search** (docs + live probes via `gh search repos`, 2026-09-13):

- Qualifiers: <https://docs.github.com/en/search-github/searching-on-github/searching-for-repositories>
- Sorting: <https://docs.github.com/en/search-github/getting-started-with-searching-on-github/sorting-search-results>
- Constraints (`in:readme` global-only, no `is:starred`, 1,000-result cap): [00 §1](00-requirements.md); REST search docs <https://docs.github.com/en/rest/search/search>
- Probes: `auth language:typescript` (better-auth #3, logto absent top 30), `bettar-auth` (0), `supabse`, `authz language:typescript`, `open source auth0 alternative language:typescript` (2 results).

**npm registry search** (docs + live API, 2026-09-13):

- Registry search API: <https://github.com/npm/registry/blob/main/docs/REGISTRY-API.md#get-v1search> (score fields, quality/popularity/maintenance weights, qualifiers incl. `boost-exact`).
- CLI: <https://docs.npmjs.com/cli/v11/commands/npm-search> (legacy linear search, match highlighting, `--searchopts`).
- Probes: `text=auth`, `keywords:authentication` (12,949), `author:sindresorhus` (940), `not:deprecated`.

**Considered, not chosen:** Libraries.io API (<https://libraries.io/api>) — ecosystem metadata + dependency-count ranking, no per-user signal; Sourcegraph code search (<https://sourcegraph.com/docs/code-search/queries>) — code/regex retrieval, out of scope ([07 §8](07-search-contract.md)).

**Internal:** [00](00-requirements.md) · [01 §3](01-search-and-index.md) · [07](07-search-contract.md) · [08](08-public-service-ux.md) · [13](13-free-tier-feasibility.md) · [15](15-free-semantic-search.md) · [17](17-query-understanding-ranking.md).
