# 17 — Query understanding & ranking

> Status: **draft for discussion** · 2026-09-13 · ⚠️ marks low-confidence items to re-check at implementation time.
>
> Scope: how a raw query becomes ranked repos in the free-tier design. This doc owns **(1)** the query taxonomy refresh, **(2)** query expansion (static concept lexicon v1; LLM rewriting deferred), **(3)** the ranking/fusion/boost/diversification details that [07 §5](07-search-contract.md) sketched, **(4)** why-matched UX, and **(5)** the checkpoints handed to the eval lab. It does not restate accuracy targets ([07 §3](07-search-contract.md)), vector storage/query mechanics ([15](15-free-semantic-search.md)), or eval harness mechanics (doc 18, in progress under `eval-lab/`).
>
> Precedence: where this doc and [07 §2/§5](07-search-contract.md) disagree on expansion or scoring detail, this doc wins (later, testable); [07](07-search-contract.md) still wins on filter semantics and accuracy targets; [15](15-free-semantic-search.md) wins on how the semantic leg is computed. Every numeric multiplier here is a tuning knob — doc 18 must justify changes with evidence (§5).
>
> Grounding: read-only sample of the 3,448-repo reference corpus on 2026-09-13 (117 auth-family repos, 68 TypeScript, 20 with a better-auth link) plus local FTS5 experiments on SQLite 3.53.4 (§2.3). Companion to [16 — Search Quality Teardown](16-search-quality-teardown.md), which motivates the name-token boost, field weighting, the single-token routing fix and the static intent map; this doc specifies them. ⚠️ D1's FTS5 build may differ; re-run the stem checks before locking the lexicon.

## 1. Query taxonomy refresh

### 1.1 Two orthogonal axes

[07 §2](07-search-contract.md)'s Q1–Q9 classes conflate the _shape of the text_ with the _presence of filters_ and the _mode_. For ranking we need the two axes separated; routing and expansion key off them independently:

- **Shape** (`kw` | `id` | `desc`) — what the text looks like.
- **Structured intent** (`bare` | `mixed`) — whether the request carries at least one explicit filter (`--lang`, `--topic`, `--min-stars`, …). "Mixed" is a label, not a fourth shape.

| Shape   | Definition                                                                                                                            | Real examples                                                                                  | Primary legs                   | Expansion                            |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------ | ------------------------------------ |
| `kw`    | 1–3 tokens, no punctuation signals, no sentence structure                                                                             | `auth`, `rate limit`, `tui git`                                                                | lex + exp + sem                | **on** (lexicon)                     |
| `id`    | 1 token with identifier signals (punctuation, camelCase, version) or an exact/prefix repo-name hit ([07 §7.4](07-search-contract.md)) | `better-auth`, `gql.tada`, `useEffect`, `Effect-TS/effect`                                     | lex + tri + sem                | **off**                              |
| `desc`  | natural-language phrase/sentence; ≥4 tokens or contains stopwords/verbs typical of prose                                              | `"library to schedule durable background jobs with retries"`                                   | lex + sem                      | **off** (semantic covers paraphrase) |
| `mixed` | any shape + ≥1 hard filter                                                                                                            | `auth --lang ts`, `"http client" --topic http-client`, `rate limit --lang go --min-stars 1000` | same as shape + SQL pre-filter | same as shape                        |

Mapping back: Q1/Q3 → `id`; Q2 + short queries → `kw`; Q4/Q8 → `desc`; Q5 → `mixed`; Q6 browse → empty text; Q9 incidental strings → `id`-like lexical-only routing. `auto` mode keeps [07 §7.4](07-search-contract.md)'s routing and adds `expand: auto|on|off` (default `auto`: on for `kw`, off for `id`/`desc`).

**Routing refinement (closes the hole [16 §5](16-search-quality-teardown.md) #1 flags).** [07 §7.4](07-search-contract.md) routes _any single token_ to keyword mode, so `auth` would never run the semantic leg (lexical never returns 0). Single-token lexicon heads (`auth`, `db`) are therefore `kw` and run **hybrid** by default; other single tokens keep 07's behavior (keyword-first, escalate to hybrid when lexical returns 0). `--mode keyword` and `similar` stay explicit; eval must show no known-item regression before this ships ([07 §3.5](07-search-contract.md)). [16 §5.1](16-search-quality-teardown.md) would extend hybrid to _all_ non-name single tokens — adopt that too if doc 18 shows short non-lexicon tokens (e.g. `durable`) losing recall.

### 1.2 The acceptance case, defined: `auth` + `language=typescript`

`auth` is a **`mixed` request** (`kw` text + one hard filter) whose four-letter trigger is stem-isolated in the index (verified §2.3): the exact term `auth` matches only the stem `auth` and misses `authentication` (`authent`), `authorization` (`author`), `oauth2` (`oauth2`), and `webauthn`. The request therefore exercises the whole pipeline — hard filter, lexicon expansion, name boosts, semantic leg, diversification — and is the launch canary for short keywords.

**Concept families the query must cover** (all six are "auth"; none should dominate):

| #   | Family                     | Representative terms in this corpus                                                 |
| --- | -------------------------- | ----------------------------------------------------------------------------------- |
| F1  | authentication             | login, signup, password, passkey, webauthn, 2FA/MFA/OTP, passwordless               |
| F2  | authorization              | access control, permissions, RBAC/ABAC/ACL, IAM, policy engines, fine-grained authz |
| F3  | OAuth / OIDC / SSO         | oauth2, openid connect, identity provider, SAML, social login, SSO proxies          |
| F4  | tokens & sessions          | JWT, refresh/bearer tokens, sessions, API keys                                      |
| F5  | identity & user management | user directory, multi-tenancy, SCIM                                                 |
| F6  | auth UI / SDK / adapters   | auth components, framework integrations, boilerplates                               |

**Acceptance assertion (for doc 18's golden set).** With `--lang typescript`, the top-10 should contain ≥ 5 repos drawn from `{better-auth/better-auth, logto-io/logto, anomalyco/openauth, pilcrowonpaper/oslo, oslo-project/jwt, zenstackhq/zenstack, letstri/permix, voidauth/voidauth, ValueMelody/melody-auth, lucia-auth/lucia, nuxflare/auth, hexclave/hexclave, better-auth-ui/better-auth-ui}`, with **zero** non-TypeScript rows, and at most **2** rows from the same owner/name-root (the better-auth family has 20 linked repos in the corpus; without diversification it can flood the list).

**Two documented exclusions the grader must not count as misses:**

- `openfga/openfga` is **not in the corpus at all** (read-only check, 2026-09-13).
- `casbin`, `spicedb`, `cerbos`, `hanko`, `kratos`, `zitadel` are Go and `keycloak`, `supertokens` are Java — all excluded by the hard filter, correctly. The TypeScript equivalents of those authz engines are `zenstack` and `permix`. If the product wants cross-language "also starred in Go" suggestions, that is a separate "excluded by filter" UI affordance ([06](06-webui.md)/[08](08-public-service-ux.md)), never a filter relaxation.

## 2. Query expansion strategy

### 2.1 Options compared

| Option                                                                                          | Recall gain                                                                         | Precision risk                                                                                                | Cost                                                                           | Availability                          | Verdict                                                     |
| ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------- | ----------------------------------------------------------- |
| **(a) Static concept lexicon** — curated cluster→alias JSON, expansion becomes a second FTS leg | High for short keywords; deterministic                                              | Low (explicit terms, no prefix blast)                                                                         | 0 neurons, +1 FTS query (~0.2–1 ms CPU, ~50–500 D1 rows)                       | Always, incl. keyword-only P0         | ✅ **v1 default**                                           |
| (b) FTS5 tricks — prefix `auth*`, token OR, trigram                                             | Prefix = broad but wrong-family; OR = same as (a) mechanized; trigram = identifiers | Prefix/trigram hit `author`/`authority` (verified)                                                            | 0 neurons                                                                      | Always                                | ✅ **as mechanics of (a)**, with the prefix trap documented |
| (c) Embedding-only semantic                                                                     | Best for `desc`; decent for `kw`                                                    | None for ranking (leg), but no provenance, unavailable before a segment is embedded, useless in degraded mode | ~0.05 neurons/query, 60–100 ms                                                 | Only after per-user embed (doc 15 P1) | ✅ as **one leg**, never a replacement                      |
| (d) LLM query rewriting (Workers AI)                                                            | Highest on `desc`/noisy and filter extraction                                       | Prompt injection into filters, nondeterminism, latency                                                        | 1.7–5.4 neurons/query (cheap models) → 8–27% of the free daily pool at 500/day | Paid-quality models excluded on free  | ⏸️ **deferred**, behind `--rewrite` experiment + hard cap   |

The legs compose: (a) is the deterministic, always-available expansion; (c) is the semantic safety net; (d) would be a third expansion source whose output still flows through the same RRF and boosts. **v1 ships (a)+(b) inside the lexical leg, keeps (c) per [15 §4](15-free-semantic-search.md), and does not call an LLM on the query path.**

### 2.2 Static concept lexicon (v1)

One versioned file in the repo (`packages/core/src/concepts/clusters.json`), loaded at isolate start; no DB, no network. Schema + the `auth` cluster:

```jsonc
{
  "$id": "concepts/v1",
  "version": "2026-09-13.1",
  "clusters": {
    "auth": {
      "label": "authentication & authorization",
      "triggers": ["auth", "authentication", "authorization", "authn", "authz"],
      "trigger_rule": "exact token match after casefold; NEVER prefix 'auth*' (matches author/authority)",
      "groups": {
        "authentication": [
          "login",
          "sign in",
          "sign up",
          "password",
          "passkey",
          "webauthn",
          "2fa",
          "mfa",
          "otp",
          "passwordless",
          "magic link",
        ],
        "authorization": [
          "access control",
          "permission",
          "rbac",
          "abac",
          "acl",
          "iam",
          "policy engine",
          "fine-grained authorization",
        ],
        "oauth-oidc": [
          "oauth",
          "oauth2",
          "oidc",
          "openid connect",
          "sso",
          "saml",
          "identity provider",
          "idp",
          "social login",
        ],
        "tokens-sessions": ["jwt", "session", "refresh token", "bearer token", "api key", "cookie"],
        "identity": ["user management", "multi-tenancy", "tenant", "scim"],
        "ui-sdk": ["auth ui", "auth middleware", "auth guard", "next-auth", "authjs"],
      },
      "must_not_expand_to": ["author", "authoring", "authority"],
      "leg_cap": 24,
    },
    "rate-limiting": {/* same shape */},
  },
}
```

Rules:

1. **Trigger** = an unquoted query token exactly equals a trigger (casefolded, NFC). No prefix triggering: `authorization` triggers the cluster directly, `author` triggers nothing.
2. **Expansion leg** = OR over the cluster's terms, capped at `leg_cap` (24) per cluster, selected by group order then lexicographic (deterministic for reproducible eval). Multi-word terms are emitted as quoted phrases.
3. **Multi-cluster queries** require one group-set per query token: implicit AND across clusters, OR within (`tui git` → expand(tui) AND expand(git)). If the cluster-AND leg returns 0, it falls back to OR and records `fallback: "cluster-or"`.
4. **Quoted phrases and negated tokens are never expanded** (07 §7.1/§7.3); a phrase like `"access control"` is already a lexicon term.
5. **Expansion is additive.** The original MATCH query remains leg #1; the expansion is a separate ranked leg with its own RRF weight (§3.2). A result can cite both.
6. **`must_not_expand_to` is enforced at emission and audit time, not by stemming**: those surfaces are never emitted by the cluster, and CI asserts each cluster's term list contains none of them. The index-side stem collision (`authorization` → `author`) is unavoidable under porter and harmless as long as the query never emits `author*` (rule 1) and trigram evidence is name/desc-only (§2.3).
7. **Cluster provenance is exposed** in `--explain` and why-matched badges (§4): `expanded: auth → authorization (cluster auth)`.

Starter clusters (15). The six named in the brief plus nine that cover common corpus queries:

| id                 | label                          | triggers (examples)                                             | core expansion terms (examples)                                                                      |
| ------------------ | ------------------------------ | --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `auth`             | authentication & authorization | auth, authentication, authorization, authn, authz               | login, passkey, oauth, oidc, sso, jwt, session, rbac, permissions, iam, access control               |
| `http-client`      | HTTP/API clients               | http client, http request, api client, rest client              | fetch, axios, got, ky, undici, superagent, interceptor, retry, middleware, http request              |
| `scheduling`       | jobs, cron & durable execution | scheduler, scheduling, cron, background jobs, durable execution | cron, job, queue, worker, retry, backoff, workflow, timer, exactly-once, durable                     |
| `tui`              | terminal UIs                   | tui, terminal ui, text user interface, cli                      | terminal, console, curses, ncurses, ratatui, bubbletea, ink, interactive, prompt                     |
| `database`         | databases & persistence        | database, sql, orm                                              | postgres, sqlite, mysql, query builder, migrations, orm, embedded database, vector database          |
| `rate-limiting`    | rate limiting & quotas         | rate limit, rate limiting, ratelimit, throttle                  | ratelimit, throttling, quota, token bucket, leaky bucket, backoff, retry-after, 429, circuit breaker |
| `llm-ai`           | LLMs, RAG & agents             | llm, ai, rag, embeddings, agents                                | inference, embedding, vector search, prompt, agent, local model, fine-tuning                         |
| `observability`    | logs, metrics & traces         | logging, logs, tracing, metrics, observability                  | log, trace, span, opentelemetry, otel, prometheus, grafana, telemetry                                |
| `testing`          | testing & QA                   | testing, test runner, e2e                                       | jest, vitest, pytest, mocking, fixtures, coverage, snapshot, browser automation                      |
| `state-management` | app state                      | state management, store, signals                                | redux, zustand, jotai, reactive, state machine, xstate, signal                                       |
| `parser`           | parsers & compilers            | parser, parsing, grammar, lexer                                 | ast, grammar, tree-sitter, compiler, template, parser combinator, tokenizer                          |
| `build-tooling`    | bundlers & monorepos           | bundler, build tool, monorepo, transpiler                       | vite, webpack, esbuild, rollup, turbo, nx, compilation, transpile, task runner                       |
| `payments`         | payments & billing             | payments, billing, checkout, subscription                       | stripe, invoice, pricing, credits, payment, subscription, checkout                                   |
| `deployment-infra` | deploy & infra                 | deployment, infra, kubernetes, serverless, docker               | docker, kubernetes, terraform, serverless, container, ci/cd, helm, infrastructure                    |
| `search`           | search engines & FTS           | search, full text search, vector search                         | full-text, fts, bm25, lucene, elasticsearch, meilisearch, tantivy, similarity search                 |

Cluster governance: additions require (i) ≥ 3 real queries in the golden set that trigger them, (ii) a `must_not_expand_to` audit, (iii) an eval A/B. The file is small enough to review by hand (~100 lines) and versioned like code.

### 2.3 FTS5 mechanics — what actually works (verified 2026-09-13, SQLite 3.53.4)

Porter+unicode61 stemming of the relevant vocabulary (index side):

| Surface word                           | Porter stem                    | Consequence                                                                              |
| -------------------------------------- | ------------------------------ | ---------------------------------------------------------------------------------------- |
| `auth`                                 | `auth`                         | exact term only matches literal `auth` (name tokens like `better-auth`, `nuxflare/auth`) |
| `authentication`, `authenticate`       | `authent`                      | exact `auth` **misses** it                                                               |
| `authorization`, `authorize`, `author` | `author`                       | exact `auth` misses it; `auth*` **includes author/authority**                            |
| `oauth`, `oauth2`                      | `oauth`, `oauth2`              | exact `auth` misses both                                                                 |
| `authn`, `authz`                       | `authn`, `authz`               | separate stems                                                                           |
| `webauthn`                             | `webauthn`                     | not `auth`-prefixed as a token                                                           |
| `permissions`                          | `permiss`                      | expansion must use a `permiss`-covering term (`permission`/`permissions`)                |
| `rate limit`, `ratelimit`              | `rate`,`limit` and `ratelimit` | both surfaces exist; expand both                                                         |

Verified query behaviors:

- `MATCH 'auth'` → `nuxflare/auth`, `better-auth`, `openauth` (the last via the description word "auth"), not `zenstack` (authorization → `author`).
- `MATCH '"auth"*'` → everything above **plus** `change-git-author`, `authorize-net`, and `zenstack` — the `auth*` trap in one line.
- `MATCH '{full_name} : "auth"'` (column filter) and `bm25(repos_fts, 10.0, 5.0, 4.0, 1.0)` (column weights, args = name, description, topics, readme) both work.
- Trigram `MATCH '"auth"'` matches substrings, including `author`; trigram `'"oauth"'` does **not** match `openauth` (3-gram overlap differs). Trigram is for identifiers, not concept expansion.

Mechanics chosen:

| Trick                     | Use                                                                                                                                                                                                |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Token OR expansion        | **Primary.** `("authentication" OR "authorization" OR "oauth" OR …)`; explicit terms only                                                                                                          |
| Column-filtered expansion | Expansion leg matches `{full_name description topics}` first (high precision); readme-wide expansion only if the filtered leg yields < 3 repos                                                     |
| Prefix `auth*`            | **Not used** for clusters. Allowed only as an explicit emergency fallback when original + expansion legs return 0, with `must_not_expand_to` stems excluded and `mode_fallback: "prefix"` recorded |
| Trigram                   | `id` class, and name-only for lexical-similar tokens; weight low (§3.2). Generic 4-char terms never scan the README trigram index                                                                  |
| Phrase emission           | multi-word cluster terms as quoted phrases (`"access control"`, `"refresh token"`)                                                                                                                 |
| BM25 column weights       | `bm25(repos_fts, 10, 5, 4, 1)` on every leg; keeps name evidence ahead of README text without a separate boost                                                                                     |

### 2.4 Embedding-only semantic (why it does not replace expansion)

The semantic leg ([15 §2](15-free-semantic-search.md)) is the only mechanism that handles `desc` vocabulary mismatch, but for `auth` it has three gaps: (i) it is unavailable until a segment's blob exists (P0 keyword MVP must stand alone, [15 §7](15-free-semantic-search.md)); (ii) `--explain` cannot say _why_ a repo matched beyond a cosine, so why-matched UX degrades to "similar meaning" for every hit; (iii) embeddings of a one-word query are themselves ambiguous — `auth` sits between "authorization" and "authentication" in most models and the ranking among the six families is arbitrary. Expansion is therefore not made redundant by embeddings; the two are complementary and both feed RRF.

### 2.5 LLM rewriting: free-tier budget math (for the record)

Workers AI free pool: **10,000 neurons/day**, account-wide ([13 §2.0](13-free-tier-feasibility.md)); rates below from the pricing page updated 2026-08-28. Assume one rewrite call ≈ **300 input tokens** (system + lexicon + query) and **~120 output tokens** (JSON: expanded terms + filters), a realistic budget for a small model. Embedding the query costs a further ~0.05 neurons.

| Model                                      | neurons/M in | neurons/M out | neurons / rewrite | 500 rewrites/day | % of free pool |
| ------------------------------------------ | ------------ | ------------- | ----------------- | ---------------- | -------------- |
| `@cf/ibm-granite/granite-4.0-h-micro`      | 1,542        | 10,158        | 1.68              | 840              | 8.4%           |
| `@cf/meta/llama-3.2-1b-instruct`           | 2,457        | 18,252        | 2.93              | 1,465            | 14.7%          |
| `@cf/qwen/qwen3-30b-a3b-fp8`               | 4,625        | 30,475        | 5.04              | 2,520            | 25%            |
| `@cf/meta/llama-3.1-8b-instruct-fp8-fast`  | 4,119        | 34,868        | 5.42              | 2,710            | 27%            |
| `@cf/zai-org/glm-4.7-flash`                | 5,500        | 36,400        | 6.02              | 3,010            | 30%            |
| `@cf/meta/llama-3.3-70b-instruct-fp8-fast` | 26,668       | 204,805       | 32.6              | 16,290           | **163% ❌**    |

Reading: the cheap models make 500 rewrites/day **arithmetically affordable** (8–27% of the pool) but not free of opportunity cost. The canonical free window embeds the newest **1,500** repos: ~0.53M tokens ≈ **565 neurons/user** ([15 §2.1/§5](15-free-semantic-search.md)); the full 3,448-repo profile is ~1.3k neurons; rerank is ~8.5 neurons/search ([15 §5](15-free-semantic-search.md)). The embed/index budget is < **6,000 neurons/day** ([15 §5](15-free-semantic-search.md), [14 §4](14-abuse-protection.md)), and the pool's soft alarm is global (60% of 10k for neurons, [13 §4.3](13-free-tier-feasibility.md)), so rewrite headroom is shared with indexing, churn and rerank. Latency is the harder blocker: generating ~120 output tokens adds roughly **0.4–1.5 s p95** (plus queueing), which breaks [07 §3.2](07-search-contract.md)'s < 500 ms budget over the wire and the 10 ms CPU envelope does not help (network wait, but the user waits anyway). Caching by normalized-query hash (24 h, Cache API/KV) cuts repeat cost but not head latency.

**Decision.** Lexicon v1 (0 neurons, deterministic, explainable) is the default. LLM rewriting stays deferred behind `--rewrite` with: cheap model (`granite-4.0-h-micro` or `llama-3.2-1b`), ≤ 1,500 neurons/day global cap, 24 h cache, off for `id`/browse/quoted queries, off when the day's neuron ledger is already above the 6,000-neuron indexing line ([15 §5](15-free-semantic-search.md)), and only shippable if doc 18 shows ≥ 0.05 nDCG@10 on `desc`/`kw` over expansion+semantic. If it ever ships by default, [13 §2.0](13-free-tier-feasibility.md) gains a rewrite row and [15 §5](15-free-semantic-search.md) reduces the daily indexing admission cap.

### 2.6 Exact expansion examples

```
query    auth           | shape kw | filters language=typescript | expand on
lex MATCH   "auth"
exp MATCH   ("authentication" OR "authorization" OR "oauth" OR "oauth2" OR "oidc" OR
             "openid" OR "sso" OR "saml" OR "jwt" OR "session" OR "passkey" OR "webauthn" OR
             "2fa" OR "mfa" OR "rbac" OR "abac" OR "acl" OR "permission" OR "iam" OR
             "access control" OR "identity provider" OR "social login")
tri MATCH   {full_name description} : "auth"          -- name/desc only; author-family dropped
sem         embed("auth")                             -- per-user repo vectors or candidate rerank
filters     language = 'TypeScript' on every leg (hard)

query    http client    | shape kw | expand on
lex MATCH   "http" AND "client"
exp MATCH   ("fetch" OR "axios" OR "got" OR "ky" OR "undici" OR "superagent" OR
             "http request" OR "rest client" OR "api client" OR "interceptor" OR "middleware")
tri MATCH   {full_name} : "http-client"
sem         embed("http client")

query    rate limit     | shape kw | expand on
lex MATCH   "rate" AND "limit"
exp MATCH   ("ratelimit" OR "throttle" OR "throttling" OR "quota" OR "token bucket" OR
             "leaky bucket" OR "backoff" OR "retry-after" OR "429" OR "circuit breaker")
tri MATCH   {full_name} : "rate-limit"
sem         embed("rate limit")

query    tui git        | shape kw (two clusters) | expand on
lex MATCH   "tui" AND "git"
exp MATCH   (terminal OR console OR curses OR ncurses OR ratatui OR bubbletea OR ink)
              AND (git OR vcs OR diff OR commit OR branch OR staging OR repository)
tri MATCH   {full_name} : "tui"   -- plus {full_name} : "git" only if the first two legs < 5
sem         embed("tui git")
fallback    cluster-AND → cluster-OR when the expansion leg returns 0
```

## 3. Ranking design (extends [07 §5](07-search-contract.md))

### 3.1 Pipeline

1. Parse and classify ([07 §6/§7](07-search-contract.md) plus §1.1 here) → `{text, phrases, negations, shape, filters, sort, limit}`.
2. Resolve filters **first**: SQL returns the eligible `repo_id` set (or a filter predicate pushed into every leg and the vector gather — [15 §2.1](15-free-semantic-search.md)). Filters are constraints, never boosts.
3. Expand (if `expand=auto`, the text shape is `kw`, and no quoted phrase/negation covers the token) §2.2; `mixed` inherits the shape's behavior.
4. Run legs in parallel, each with its own top-50: `lex` (original MATCH; implicit AND → OR fallback per [07 §7.2](07-search-contract.md)), `exp` (OR expansion), `tri` (trigram), `sem` (in-Worker kNN; `semantic_source: full|filtered|candidates` per [15 §4](15-free-semantic-search.md)).
5. Fuse at repo level with weighted RRF (§3.2); apply boosts/penalties (§3.3).
6. Diversify near-duplicates (§3.5); optional rerank window per [07 §5.4](07-search-contract.md).
7. Attach snippets + why-matched provenance (§4); sort, limit, explain.

### 3.2 Weighted RRF and normalization

For each repo `r`, over the **configured leg set** `L` for the query class (not the legs that happened to return hits):

```
base(r) = Σ_{l∈L} w_l / (60 + rank_l(r))  ÷  Σ_{l∈L} w_l / 61
w_lex = 1.00   w_exp = 0.60   w_tri = 0.30   w_sem = 1.00
```

| Shape                  | Configured legs                            | Rationale                                                                  |
| ---------------------- | ------------------------------------------ | -------------------------------------------------------------------------- |
| `id`                   | lex, tri, sem                              | expansion off; trigram carries `better-auth`/`useEffect` splits            |
| `kw`                   | lex, exp, tri, sem                         | the acceptance case                                                        |
| `desc`                 | lex, sem                                   | expansion adds little beyond paraphrase and dilutes precision              |
| degraded (no semantic) | configured minus `sem` (P0: lex, exp, tri) | [15 §6.1](15-free-semantic-search.md) fallback ladder keeps the same shape |

`base ∈ (0,1]`, `1.0` = rank 1 in every configured leg. Because the denominator uses the configured set, a repo that only matches the semantic leg maxes out at `1.00/(1.00+0.60+0.30+1.00) = 0.34` for `kw` — absence of lexical evidence is visible and intentional. No calibrated score mixing (07 §5.2); RRF weights stay small constants so eval can move them one at a time. `score = base × Π(boosts) × div`; every factor is logged in `--explain`.

### 3.3 Boost / penalty table (extends [07 §5.3](07-search-contract.md))

Multiplicative, on `base`. Name-family factors dominate (explicit user intent); evidence factors are small; priors never reverse meaning.

| Factor                                                          | Multiplier                                                       | Notes                                                                                                                          |
| --------------------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Exact `full_name` match (`owner/name` query)                    | ×1.60                                                            | unchanged from 07                                                                                                              |
| Query term is an **exact name token** — distinctive             | ×1.35                                                            | `effect` → `Effect-TS/effect`, `lazygit`                                                                                       |
| Query term is an exact name token — **generic cluster trigger** | ×1.20                                                            | `auth` in `better-auth`/`nuxflare/auth`; damps the "generic word = whole answer" effect                                        |
| Name token prefix match (query token ≥ 3 chars)                 | ×1.20                                                            | unchanged; `drizzle` → `drizzle-orm`                                                                                           |
| All original query tokens present in name                       | ×1.10                                                            | unchanged                                                                                                                      |
| Expanded term in `full_name` (substring/trigram)                | ×1.08, cap ×1.16                                                 | `auth` → `openauth`, `voidauth`                                                                                                |
| Expanded term in `topics`                                       | ×1.06 per term, cap ×1.12                                        | topics are precise labels; 25% of repos have none, so this never gates recall                                                  |
| Expanded term in `description`                                  | ×1.05, cap ×1.10                                                 | weaker than a topic; supports "why matched"                                                                                    |
| Semantic-only match (no lex/exp/tri evidence)                   | ×1.00                                                            | no boost; labelled `semantic`                                                                                                  |
| Star prior                                                      | `1 + 0.04·log10(stars+1)`, cap ×1.25                             | unchanged from 07; 30k → ×1.18                                                                                                 |
| Starred recently                                                | ≤ 90 d ×1.10; ≤ 365 d ×1.05                                      | unchanged                                                                                                                      |
| Archived                                                        | ×0.40                                                            | penalty, not exclusion (07 §5.3); `lucia`, `oslo`, `auther` exercise this                                                      |
| **Thin-evidence clamp**                                         | ×0.85 on the name-token boost                                    | name-only evidence for a generic trigger with `sem` absent or rank > 25 (a 24-star repo named `auth` should not outrank logto) |
| Near-duplicate diversification                                  | ×0.90 per already-selected neighbor (cosine ≥ 0.85), floor ×0.60 | §3.5                                                                                                                           |

[16 §5.2](16-search-quality-teardown.md) proposed a flat ×1.10–1.15 name-token boost; the tiered ×1.35/×1.20 above is this doc's refinement (distinctive vs generic), and all three values are inside the same eval-gated range.

### 3.4 Hard filters

Language, and every other explicit facet, is a **hard constraint on every leg**; on the semantic leg it is a pre-condition, applied before ranking rather than after: [15 §2.1](15-free-semantic-search.md)'s D1 `repo_id` pre-filter/flag bits make this exact. Facet precision must be 1.000 ([07 §3.1](07-search-contract.md)): a `--lang typescript` response never contains a Go/Java row, and `unknown`-language repos (4.7% of the corpus) are excluded unless requested. The acceptance case is a facet test first and a relevance test second.

### 3.5 Near-duplicate diversification

Motivation: 20 repos in the reference corpus name/topic-link better-auth; without suppression a good `auth` answer can become eight variations of one project. Three stacked rules, applied greedily after boosts, in score order:

1. **Owner cap** — max 2 results per `owner_login` in the visible page (`limit` ≤ 25); suppressed items are deferred, not deleted.
2. **Name-root cap** — max 2 per normalized root (first name token after stripping `-`/`_` and `js|ts|ui|sdk|cli|server|client` suffixes); `better-auth`, `better-auth-ui`, `better-fetch` share root `better`.
3. **Vector near-duplicate penalty** — for each already-selected repo with cosine ≥ 0.92, treat as duplicate (cap 1 per duplicate cluster); cosine 0.85–0.92 applies ×0.90 per neighbor, floor ×0.60. Vectors already exist per repo ([15 §2.3](15-free-semantic-search.md)) so this costs one dot product per selected pair in the top window (≤ 30 × 10 comparisons ≈ free).

If fewer than `limit` rows remain after caps, deferred rows are re-admitted with the penalty applied and `suppressed_by: "diversification"` recorded in explain. Diversification never suppresses the only lexical/expanded evidence for the query.

### 3.6 Tie-breakers

1. `score` desc; 2. name-match tier (exact > prefix > contains > expansion-name); 3. stars desc; 4. `starred_at` desc; 5. `repo_id` asc (deterministic). Rerank, when enabled, replaces 1 within its window per [07 §5.4](07-search-contract.md); browse mode uses its explicit sort key then 4–5.

### 3.7 Worked example: `auth --lang typescript` (reference corpus, illustrative ranks ⚠️)

Leg ranks below are hand-built from real metadata (name/description/topics/archived/stars in the corpus) and the formula above; doc 18 replaces them with measured ranks. `–` = absent from that leg's top-50. Legs configured: lex(1.0) exp(0.6) tri(0.3) sem(1.0); denominator `2.9/61 = 0.04754`.

| Repo                    | lex | exp | tri | sem | base | Boosts applied                                                             | score    | rank |
| ----------------------- | --- | --- | --- | --- | ---- | -------------------------------------------------------------------------- | -------- | ---- |
| better-auth/better-auth | 1   | 1   | 1   | 2   | 0.99 | name-token generic 1.20 × topics 1.12 × star 1.18                          | **1.58** | 1    |
| ValueMelody/melody-auth | 5   | 7   | 4   | 7   | 0.92 | name-token generic 1.20 × topics 1.12 × desc 1.08 × star 1.11              | **1.49** | 2    |
| anomalyco/openauth      | 3   | 2   | 2   | 3   | 0.97 | name-substring 1.08 × desc 1.05 × star 1.16                                | **1.27** | 3    |
| nuxflare/auth           | 2   | 8   | 1   | 40  | 0.84 | name-token generic 1.20 × thin-evidence clamp 0.85 × desc 1.05 × star 1.06 | **0.95** | 4    |
| voidauth/voidauth       | –   | 5   | 3   | 6   | 0.61 | name-substring 1.08 × topics 1.12 × star 1.14                              | **0.84** | 5    |
| logto-io/logto          | –   | 3   | –   | 1   | 0.55 | topics 1.12 × desc 1.05 × star 1.17                                        | **0.75** | 6    |
| zenstackhq/zenstack     | –   | 6   | –   | 4   | 0.52 | topics 1.12 × desc 1.10 × star 1.14                                        | **0.73** | 7    |
| hexclave/hexclave       | –   | 4   | –   | 5   | 0.52 | topics 1.12 × desc 1.08 × star 1.15                                        | **0.73** | 8    |
| letstri/permix          | –   | 11  | –   | 8   | 0.49 | topics 1.12 × desc 1.10 × star 1.11                                        | **0.67** | 9    |
| NangoHQ/nango           | –   | 10  | –   | 15  | 0.46 | topics 1.12 × star 1.16                                                    | **0.60** | 10   |
| lucia-auth/lucia        | 4   | 9   | 5   | 12  | 0.90 | name-token generic 1.20 × topics 1.12 × star 1.16 × **archived 0.40**      | 0.56     | 11   |
| pilcrowonpaper/oslo     | –   | 12  | –   | 9   | 0.48 | desc 1.05 × archived 0.40                                                  | 0.20     | 22   |

What the walkthrough demonstrates:

- **Hard filter first**: zero Go/Java rows; `casbin`, `spicedb`, `cerbos`, `hanko`, `kratos`, `zitadel`, `keycloak`, `supertokens` never appear. All seven authz/auth servers in the corpus are filter-excluded by design.
- **Leg coverage beats boosts**: `better-auth` wins because it is rank 1–2 in _every_ configured leg; `melody-auth` reaches #2 on four-leg coverage (name token + topics + description) despite 637 stars; `logto`, `zenstack`, `hexclave`, `permix`, `nango` are expansion+semantic-only and cluster at base 0.46–0.55 — the honest cost of "no `auth` token anywhere".
- **Canaries for doc 18**: (i) `melody-auth` at #2 over the 14.5k-star `logto` — generic name-token + evidence boosts may be too strong for thin repos; if graders split these the other way, lower the generic name boost to ×1.15 or extend the thin-evidence clamp to `sem rank > 15`. (ii) `nuxflare/auth` at #4 via name evidence with `sem` rank 40 — the clamp works but is doing heavy lifting; consider requiring any non-name leg in the top 25 for the full name boost. (iii) five results carry **no original-token match** (logto, zenstack, hexclave, permix, nango) — why-matched must say "related concept + similar meaning" for these (§4). (iv) `lucia` (archived, 10.4k stars) at #11: archived penalty works without hiding a genuinely relevant repo.
- **Family suppression works**: `better-auth-ui`, `better-auth-cloudflare`, `better-fetch`, `better-hub`, `better-auth/awesome` are deferred by the owner/name-root caps; one family member (`better-auth/better-auth`) remains, exactly the intent.
- **Semantic-window caveat**: the free tier embeds only the newest **1,500** repos ([15 §2.1](15-free-semantic-search.md), [14 §3.6](14-abuse-protection.md)). The `sem` ranks above assume the repo is inside that window; a target outside it must be recovered by `lex`/`exp`/`tri` alone. Doc 18 must record each graded auth target's window position — if a canonical answer is out-of-window and only findable semantically, fix the window policy before the ranker.

## 4. Why-matched UX

Every result carries `matched_via[]` with leg, term, field and tier; snippets and badges are generated from it. The invariant: **never display a match reason the engine did not use.**

### 4.1 Badge taxonomy

| Badge               | Meaning                                                      | Wording (WebUI / CLI)                                                                                  |
| ------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| `name`              | original query token is a name token (exact/prefix/contains) | `name: auth` · `lex name`                                                                              |
| `topic`             | original or expanded term in topics                          | `topic: authentication`                                                                                |
| `desc`              | expanded term in description                                 | `related: authorization`                                                                               |
| `readme`            | FTS hit in README text                                       | `README: "session"`                                                                                    |
| `expanded`          | matched only via a lexicon alias                             | `auth → access control` (dashed style; tooltip "related concept, not the exact word")                  |
| `semantic`          | semantic-only, no lexical evidence                           | `similar meaning` + a strength bucket (`strong`/`ok`/`weak` from cosine tertiles), never the raw float |
| `filter`            | contextual chip, not a match                                 | `TypeScript` (hard filter already applied)                                                             |
| `archived` / `fork` | state chips with the explain-only penalty                    | `archived`                                                                                             |

Original-token badges outrank expansion badges in display order. Semantic hits with _some_ lexical evidence show both (`semantic + readme`) — that combination is the strongest signal we have.

### 4.2 Snippet selection

1. **Original lexical hit** → FTS `snippet()` with query-term highlighting ([07 §6](07-search-contract.md)); the badge says `name/topic/desc/readme`.
2. **Expansion-driven hit** → snippet around the matched alias (`authorization`, `access control`), alias highlighted, plus the line `matched related term: authorization (auth)`. If the alias appears only in topics/description, show that field — a README snippet that lacks the term would look wrong.
3. **Semantic-only hit** → best sentence window from the matched chunk ([07 §6](07-search-contract.md)); highlight original query terms _if present_, else no marks. Badge is `similar meaning`; no fabricated highlights.
4. **Multiple** → priority original > expanded > semantic for snippet, but all matched_via entries remain visible.
5. **Nothing found after filters** → print active hard filters and the excluded-by-filter hint with one-click removal ([07 §4.2](07-search-contract.md)); never silently relax a filter.

### 4.3 `--explain` additions (extends [07 §5.6](07-search-contract.md))

```jsonc
{
  "query": {
    "shape": "kw",
    "mixed": true,
    "expand": "on",
    "filters": { "language": ["TypeScript"] },
    "expansions": {
      "clusters": ["auth"],
      "terms": 22,
      "leg_cap_hit": false,
      "fallback": null,
    },
  },
  "results": [
    {
      "repo": "logto-io/logto",
      "score": 0.75,
      "rrf": {
        "lex": null,
        "exp": 3,
        "tri": null,
        "sem": 1,
        "semantic_source": "filtered",
        "base": 0.545,
      },
      "matched_via": [
        {
          "leg": "exp",
          "cluster": "auth",
          "term": "authorization",
          "field": "topics",
          "tier": "topic",
        },
        { "leg": "sem", "cosine": 0.71 },
      ],
      "boosts": [
        { "name": "topic_expansion", "factor": 1.12 },
        { "name": "star_prior", "factor": 1.17 },
      ],
      "diversification": { "family": "logto", "suppressed": 0 },
    },
  ],
  "timings_ms": {
    "parse": 0.3,
    "expand": 0.2,
    "lexical": 21.0,
    "semantic": 58.4,
    "fusion": 2.1,
    "total": 89.6,
  },
}
```

CLI reason line: `#6 exp:authorization sem:1 ★14.5k topic:auth +12%` — the user sees _why_ in one line; `--explain` carries the full arithmetic.

## 5. Checkpoints for the eval lab (doc 18)

Each row is an assumption this doc makes that the parallel eval lab can falsify, and the change it forces. Doc 18 owns the golden set, metrics and evidence; this table is the handoff.

| #   | Assumption                                                                                                                               | Falsifier doc 18 can measure                                                                   | If falsified → change                                                                                                                                                                                     |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Expansion leg (w=0.60) beats no-expansion on `kw` without hurting `id`/`desc`                                                            | A/B nDCG@10 per shape on the golden set; precision@5 on `auth`                                 | Lower to 0.40; or alias-only per cluster; [07 §5.2](07-search-contract.md) leg list                                                                                                                       |
| 2   | Generic name-token damping (×1.20) + thin clamp (×0.85) keeps thin `name`-matches out of the top-5                                       | `auth`+ts top-10 composition; graded rank of `nuxflare/auth` vs `logto`/`zenstack`             | Lower to ×1.10 or make name-exact a tie-break; widen clamp to `sem > 15`; [07 §5.3](07-search-contract.md)                                                                                                |
| 3   | Hard language filter yields zero leakage and graders accept Go/Java authz as filter-excluded (not misses)                                | Filter-precision assertion; grader notes mark `casbin`/`spicedb` grade 2 and absent            | Add grading note in [07 §2](07-search-contract.md) + "excluded by filter" affordance in 06/08; **never** relax the filter                                                                                 |
| 4   | Semantic leg is required for expansion+semantic targets (`logto`, `zenstack`) to reach top-10                                            | keyword-only (P0) vs hybrid comparison on the same query                                       | If semantic alone covers them, shrink expansion to degraded/keyword mode; if neither does, escalate to LLM or index-time tags ([01 §3.4](01-search-and-index.md), [13 §2.0](13-free-tier-feasibility.md)) |
| 5   | Owner/name-root caps + 0.90 penalty suppress the better-auth family without evicting independent targets                                 | Family share in top-10; graded value of suppressed vs admitted rows                            | Soft MMR only (drop hard caps); or clamp to 1 per family if flood persists; §3.5 here                                                                                                                     |
| 6   | Expansion adds ≤ 2× D1 rows read and stays inside the free search budget (~300–1,500 rows/search, [13 §2c](13-free-tier-feasibility.md)) | Rows-read instrumentation per route; FTS scan factor ⚠️                                        | Fold expansion into one MATCH via OR; or drop readme-wide expansion; [12](12-hardening.md) budget semantics                                                                                               |
| 7   | LLM rewriting is not needed for v1 and is not affordable as a default                                                                    | doc 18 `desc`/`kw` nDCG with and without rewrite; neurons/day; p95 with a 120-token output     | If it wins: ship `--rewrite` with the §2.5 cap and add a rewrite row to [13 §2.0](13-free-tier-feasibility.md); reduce [15 §5](15-free-semantic-search.md) admission                                      |
| 8   | Trigram at w=0.30 helps identifiers without `author` noise                                                                               | Precision of `tri`-only hits on `auth`; known-item regression suite                            | Name-only trigram or w=0.15; §3.2                                                                                                                                                                         |
| 9   | Topic/description boosts (1.12/1.10 caps) help without letting topic-rich-but-irrelevant repos dominate                                  | Ablation of evidence boosts on `kw` queries                                                    | Make topics evidence-only (badge, no score); §3.3                                                                                                                                                         |
| 10  | Star prior cap ×1.25 does not let apps (supabase, cal.com, appwrite) outrank dedicated libraries for `auth`                              | Top-10 composition vs a stars-as-tie-break-only run; [07 §9 q3](07-search-contract.md) canary  | Lower cap or move stars to tie-break only; [07 §5.3](07-search-contract.md)                                                                                                                               |
| 11  | P0 keyword-only mode can hit the `kw`/`mixed` acceptance **without** semantic                                                            | Run the `auth`+ts golden query with `sem` unavailable ([15 §7](15-free-semantic-search.md) P0) | Then P0 ships expansion+name boosts and the UX promises "semantic improves later"; if it fails, P0 gate must accept a known recall gap                                                                    |
| 12  | Shape routing (expand `kw`, not `id`/`desc`; single-token lexicon heads run hybrid per §1.1) is correct                                  | Per-class A/B with expansion and semantic forced on/off; known-item regression suite           | Adjust `expand=auto` / `id` detection in [07 §7.4](07-search-contract.md); add `desc` expansion only if evidence says so                                                                                  |
| 13  | Boost/threshold values are tunable units, not load-bearing constants                                                                     | Doc 18's per-query worst-regression report                                                     | Any change lands with eval diff in the commit body ([07 §3.5](07-search-contract.md) policy)                                                                                                              |
| 14  | Every graded `auth`+ts target is inside the newest-1,500 semantic window — or reachable without `sem`                                    | Window position of each graded target; run with semantic disabled for out-of-window repos      | If out-of-window targets are semantic-only, widen the window policy ([14 §3.6](14-abuse-protection.md)/[15 §2.1](15-free-semantic-search.md)) or accept and document the recall gap                       |

Requests to doc 18: grade the `auth --lang typescript` golden query with the full candidate pool (not just the union of our legs) and record per-repo `matched_via` provenance; report **filter precision**, **family-flood share**, and each target's **semantic-window position** as separate metrics; run the query once with semantic forced off to prove the P0 path; time an expanded keyword search end-to-end; pin the FTS5 version used for the stem/`bm25` checks. ⚠️ The local verification here used SQLite 3.53.4; D1's FTS5 build must pass the same §2.3 table before the lexicon is frozen.

## Sources

- Local FTS5 experiments (stem table, prefix trap, column filters, `bm25` weights, trigram): SQLite 3.53.4 via Python 3, run on the reference vocabulary 2026-09-13 (§2.3); scripts not committed.
- Corpus grounding: `gh api --paginate /users/coldter/starred` read-only, 3,448 repos, 2026-09-13; 117 auth-family matches (68 TypeScript, 25 Go), 20 better-auth-linked repos, `openfga` absent, `lucia-auth/lucia`, `pilcrowonpaper/oslo`, `quanghuy1242/auther` archived. README samples fetched raw for `better-auth`, `logto`, `openauth`, `zenstack`, `permix`, `hexclave`.
- Workers AI neuron rates (updated 2026-08-28, fetched 2026-09-13): <https://developers.cloudflare.com/workers-ai/platform/pricing/> · free 10k neurons/day and backfill math: [13 §2.0/§2d](13-free-tier-feasibility.md).
- FTS5 (`bm25` column weights, prefix queries, column filters, porter/unicode61/trigram tokenizers): <https://www.sqlite.org/fts5.html>
- D1 FTS5 availability: <https://developers.cloudflare.com/d1/sql-api/sql-statements/>
- Semantic leg mechanics and free-tier vector storage: [15](15-free-semantic-search.md); RRF (Cormack et al. 2009): <https://plg.uwaterloo.ca/~gvcormac/cormacksigir09-rrf.pdf>; ranking/fusion baseline: [07 §5](07-search-contract.md).
