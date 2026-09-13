# 18 — Search Quality Eval (Local Lab)

> Status: **measured** · 2026-09-13 · Local, zero-spend reproduction of the free-tier search design in [15](15-free-semantic-search.md): SQLite FTS5 (porter + trigram) + **one 384-d embedding per repo** + RRF k=60 + static query expansion. Corpus: coldter's live stars (**3,448 repos**). Harness: `eval-lab/` (Node 26.8.2, `node:sqlite` FTS5, `@huggingface/transformers` 3.8.1, `Xenova/bge-small-en-v1.5` fp32). No Cloudflare account, no paid API, no Vectorize. ⚠️ marks what this lab **cannot** answer.

**TL;DR**

1. **The acceptance example does not clear the [07 §3.2](07-search-contract.md) mixed-class gate on the default hybrid mode.** `auth --lang typescript`: better-auth lands at **#3**, logto **outside the top 10**, and a 24-star exact-name repo (`nuxflare/auth`) takes #1 in every mode. `hybrid+expand` fixes the ordering (better-auth #2, logto #3, melody-auth #4) and lifts nDCG@10 **0.700 → 0.808** (target 0.75); plain hybrid misses by 0.05.
2. **Static expansion is the strongest single lever in the whole run**: overall nDCG@10 0.692 → **0.742** (+0.050), P@5(g=2) 0.475 → 0.550, Success@3 0.875 → **1.000**. [15 §8](15-free-semantic-search.md)/[07 §8](07-search-contract.md) scope expansion to a v2 LLM stage — this data says a *deterministic* expansion stage earns its place in v1.5 first.
3. **Repo-level retrieval is good enough; ranking is the problem.** Semantic recall is not the bottleneck (hybrid R@10 0.740 vs semantic 0.689); first-rank precision is (P@5(g=2) 0.475). Chunk-level indexing is **not justified** by this eval; rerank is the lever to test next.
4. **Two concrete bugs in the contract's defaults show up immediately**: (a) the ×1.60 exact-name boost promotes generic-word name matches (`auth` → `nuxflare/auth` #1; un-boosted RRF had better-auth #1); (b) the AND→OR fallback only fires on zero results, so `tui for git` never falls back and scores **nDCG 0.0** in keyword mode while some junk repo matches `tui AND for AND git`.
5. `effect` (the ambiguous known-item canary, Q2) is the model behavior to keep: `Effect-TS/effect` is **#1 in all four modes** (nDCG 1.000), and the animated-effects distractor never enters the top 10.

## 1. Methodology

- **Corpus**: `gh api --paginate /user/starred` (star+json) → 3,448 repos, 3,278 with a language (1,235 TypeScript).
- **READMEs**: raw.githubusercontent.com first (`README.md`, `readme.md`, `README.rst`, `.github/README.md`), `gh api .../readme` raw media type as fallback; concurrency 10, 190.7 s for the full crawl (18.1 repos/s), misses logged.
- **Index**: one SQLite DB with `repos` + `repos_fts` (`tokenize='porter unicode61'`, bm25 weights name 8 / description 3 / topics 3 / readme 1) + `repos_tri` (`trigram`) + `embeddings`.
- **Embedding doc**: `full_name — description | topics: … | lang: …` + first **1,500 chars** of markdown-stripped README. Query gets the bge-en-v1.5 retrieval instruction; docs get no prefix; CLS pooling + L2 norm; cosine = dot product.
- **Legs**: keyword = porter top-50 (AND, OR fallback on zero, trigram rescue when porter is empty); semantic = brute-force cosine over the filtered universe, top-50. RRF = `1/(60+rank)` per leg; boosts from [07 §5.3](07-search-contract.md) applied multiplicatively; ties by base score.
- **Expansion** (`hybrid+expand`): seven hand-curated synonym clusters (auth, http-client, durable-jobs, tui-git, vector-db, rate-limit, effect) triggered by query tokens; terms are OR-fused into the keyword leg and appended to the query text for the embedding.
- **Gold sets**: 8 queries derived from the actual corpus. Pass 1 from metadata grep; pass 2 validated against the union of top-20 per mode ([07 §3.3](07-search-contract.md)) and extended with true positives it missed (authgear, hanko, tinyauth, pocket-id, effect-mq, runmq, …). Labels were decided on "is this repo an X?" grounds, not ranker position; 0 orphaned labels. This is only 8 queries and the pass-2 additions were made with ranker output visible — treat deltas as directional, not statistical.
- **Metrics**: P@5 (g≥1), P@5(g=2), R@10 strict over all grade-2 repos, MRR (first g≥1), nDCG@10 (`2^g−1`, `1/log2(rank+1)`), Success@3. Filter precision is asserted (every returned row must satisfy every filter).
- **Not measured** (⚠️): workerd CPU/derating, real latency and network, Workers AI models (`qwen3-embedding-0.6b`, `bge-m3`), MRL truncation, rerank (`bge-reranker-base`), snippet quality, R2/D1 read costs.

## 2. Corpus and index stats

| Stat | Value |
|---|---|
| Repos / with language / TypeScript | 3,448 / 3,278 / 1,235 |
| READMEs found / missing | **3,432 (99.5%) / 16** (incl. `better-auth/skills`, 0 bytes; `oslo-project/.github`) |
| README bytes median / p90 / max | 6,788 / 25,403 / 497,688 |
| Embedding doc chars mean | 1,562 (1,500-char cap + metadata line) |
| DB size / of which trigram / porter / embeddings | 173.3 MB / 113.7 MB / 45.3 MB / 13.5 MB |
| Build: FTS insert / embeddings | 8.5 s / **652 s** (5.3 docs/s, fp32 CPU) |
| Warm query latency (Node floor): keyword p50 / semantic p50 / hybrid p50 / expand p50 | 3.2 / 14.3 / 16.9 / 25.0 ms (first semantic run 355 ms = model load) |
| Filter precision (auth-ts, all modes) | **1.000** (asserted) |

The local embedding throughput (5.3 docs/s) is an ONNX-CPU artifact, not a statement about the deployed design: [15 §2.5](15-free-semantic-search.md) budgets 108 Workers AI calls per user. What *does* transfer is query-side cost: a 384-d scan over 3,448 vectors is ~5–7 ms of plain JS in Node, i.e. the repo-level vector leg is not the CPU risk at this corpus size.

## 3. Overall results

```
metric             keyword      semantic        hybrid hybrid+expand
P@5 (g≥1)            0.700         0.700         0.775         0.775
P@5 (g=2)            0.400         0.375         0.475         0.550
R@10 (g=2)           0.604         0.689         0.740         0.732
MRR                  0.905         0.792         0.900         0.938
nDCG@10              0.626         0.626         0.692         0.742
Success@3            0.875         0.875         0.875         1.000

class                keyword      semantic        hybrid hybrid+expand
mixed                  0.643         0.795         0.700         0.808
descriptive            0.561         0.536         0.640         0.688
known-item             1.000         1.000         1.000         1.000
```

Readings:

- **Hybrid+expand wins on every ranking metric except strict R@10**, where it trades 0.008 for much better ordering. Success@3 goes 0.875 → 1.000.
- **Hybrid does not yet earn its complexity by the [07 §3.2](07-search-contract.md) launch gate** ("hybrid must beat keyword-only on Q4 by ≥0.08 nDCG"): descriptive-class mean delta is **+0.079** (0.561 → 0.640) — a hair short — and on the doc-07 Q4 example `durable background jobs` it is **+0.044** (0.747 → 0.791). `hybrid+expand` passes cleanly: **+0.127** class mean, **+0.202** on durable-jobs.
- **Semantic alone is a recall leg with poor top-rank precision** (P@5 g2 0.375, MRR 0.792): the fusion and boosts are doing real work. R@10 is highest for semantic (0.689) — the vectors find targets, they just don't sort them.

## 4. Per-query results (real outputs from `pnpm run eval`)

### 4.1 `auth` — `--lang typescript` (the acceptance example)

```
metric             keyword      semantic        hybrid hybrid+expand
P@5 (g≥1)            0.800         1.000         1.000         1.000
P@5 (g=2)            0.400         0.800         0.600         0.800
R@10 (g=2)           0.455         0.636         0.545         0.636
MRR                  1.000         1.000         1.000         1.000
nDCG@10              0.643         0.795         0.700         0.808
Success@3            1.000         1.000         1.000         1.000

rank keyword                          semantic                         hybrid                           hybrid+expand
1    nuxflare/auth [2]                nuxflare/auth [2]                nuxflare/auth [2]                nuxflare/auth [2]
2    himself65/auth-spec [1]          himself65/auth-spec [1]          himself65/auth-spec [1]          better-auth/better-auth [2]
3    better-auth/better-auth [2]      better-auth/better-auth [2]      better-auth/better-auth [2]      logto-io/logto [2]
4    better-auth-ui/better-auth-ui [1] voidauth/voidauth [2]           better-auth-ui/better-auth-ui [1] ValueMelody/melody-auth [2]
5    GeKorm/better-auth-harmony [0]   anomalyco/openauth [2]           ValueMelody/melody-auth [2]      himself65/auth-spec [1]
6    zpg6/better-auth-cloudflare [1]  ValueMelody/melody-auth [2]      GeKorm/better-auth-harmony [0]   anomalyco/openauth [2]
7    ValueMelody/melody-auth [2]      better-auth-ui/better-auth-ui [1] leopoldsw/cloudflare-auth [2]   voidauth/voidauth [2]
8    leopoldsw/cloudflare-auth [2]    leopoldsw/cloudflare-auth [2]    lucia-auth/lucia [2]             charlieJ107/better-auth.zhuoling.space [0]
9    lucia-auth/lucia [2]             lucia-auth/lucia [2]             better-auth/better-hub [0]       metorial/metorial [0]
10   better-auth/better-fetch [0]     GeKorm/better-auth-harmony [0]   anomalyco/openauth [2]           leopoldsw/cloudflare-auth [2]
```

Where the acceptance targets actually land:

| Target | keyword | semantic | hybrid | hybrid+expand |
|---|---|---|---|---|
| better-auth/better-auth | #3 | #3 | #3 | **#2** |
| logto-io/logto | >10 | 11 | 15 | **#3** |
| lucia-auth/lucia | #9 | #9 | #8 | 15 |
| anomalyco/openauth | >10 | #5 | #10 | #6 |
| voidauth/voidauth | >10 | #4 | 18 | #7 |

The filter itself is exact: every returned repo is TypeScript for all four modes (filter precision 1.000, 1,235-repo universe).

**Diagnosis.** The ×1.60 exact-name boost (query `auth` == repo name `auth`) beats everything else and never lets go in fusion; `auth-spec` also gets the ×1.20 prefix boost because `auth` prefixes its name. The un-boosted hybrid run is the control:

```
# starwatch search "auth" --mode hybrid --lang ts --no-boost   (top 5)
#1 better-auth/better-auth        (lex:3 sem:2)
#2 better-auth-ui/better-auth-ui  (lex:1 sem:7)
#3 ValueMelody/melody-auth        (lex:5 sem:3)
#4 himself65/auth-spec            (lex:4 sem:4)
#5 GeKorm/better-auth-harmony     (lex:2 sem:10)
```

Without boosts the fusion already returns the contract's intent; with boosts it drops better-auth to #3 (+0.083 nDCG per our labels because nuxflare/auth *is* graded 2 — it is a real self-hosted auth server, just 24 stars — but the ordering is not what the acceptance example asks for). Expansion is what recovers the ask: appending `authentication, oauth, oidc, sso, identity provider, …` moves logto to #3 and lands four grade-2 auth servers in the top 5.

**Gap quantification:** plain hybrid nDCG@10 0.700 vs the 0.75 mixed gate ≠ **−0.050**; R@10 0.545 vs the 0.85 gate ≠ **−0.305** (the strict R@10 denominator is 11 grade-2 repos, so 10/11 is the theoretical max; the gate as written is unreachable for broad multi-target queries — see §6.9). `hybrid+expand` clears the nDCG gate at 0.808.

### 4.2 `auth` — no language filter

```
metric             keyword      semantic        hybrid hybrid+expand
P@5 (g≥1)            0.800         0.800         0.800         1.000
P@5 (g=2)            0.400         0.400         0.400         0.800
R@10 (g=2)           0.208         0.292         0.208         0.333
MRR                  1.000         1.000         1.000         1.000
nDCG@10              0.589         0.775         0.613         0.780
Success@3            1.000         1.000         1.000         1.000

rank keyword                          semantic                         hybrid                           hybrid+expand
1    nuxflare/auth [2]                nuxflare/auth [2]                nuxflare/auth [2]                logto-io/auth-wiki [1]
2    himself65/auth-spec [0]          authgear/authgear-server [2]     himself65/auth-spec [0]          authgear/authgear-server [2]
3    better-auth/better-auth [2]      logto-io/auth-wiki [1]           logto-io/auth-wiki [1]           nuxflare/auth [2]
4    better-auth-ui/better-auth-ui [1] himself65/auth-spec [0]         better-auth/better-auth [2]      logto-io/logto [2]
5    logto-io/auth-wiki [1]           better-auth/skills [1]           better-auth-ui/better-auth-ui [1] supertokens/supertokens-core [2]
6    GeKorm/better-auth-harmony [0]   better-auth/better-auth [2]      ValueMelody/melody-auth [2]      better-auth/better-auth [2]
7    zpg6/better-auth-cloudflare [0]  voidauth/voidauth [2]            better-auth/skills [1]           himself65/auth-spec [0]
8    ValueMelody/melody-auth [2]      anomalyco/openauth [2]           GeKorm/better-auth-harmony [0]   ValueMelody/melody-auth [2]
9    leopoldsw/cloudflare-auth [2]    ValueMelody/melody-auth [2]      leopoldsw/cloudflare-auth [2]    vigiloauth/vigilo [2]
10   lucia-auth/lucia [2]             supertokens/supertokens-core [2] lucia-auth/lucia [2]             apache/casbin [2]
```

Observations: keyword and hybrid never surface keycloak, zitadel, casbin, ory/kratos, casdoor, hanko, tinyauth, pocket-id inside the top 10; `hybrid+expand` gets casbin to #10 and supertokens to #5 but still misses the Go/Java IdP cluster. This is a **popularity-prior + name-repetition** effect: these repos' READMEs are docs-heavy and their descriptions don't repeat "auth" enough, so both legs rank smaller TS repos above them; stars-based tie-breaks are too weak (cap ×1.25, better-auth 30k★ → ×1.179 vs a 24★ repo ×1.056). The best fix is the same as §4.1: expansion + boost recalibration, not chunking. (R@10 is capped at 10/24 = 0.417 by the 24 grade-2 labels; 0.333 means 8/24 found.)

### 4.3 `http client with retries`

```
metric             keyword      semantic        hybrid hybrid+expand
P@5 (g≥1)            0.400         0.400         0.400         0.400
P@5 (g=2)            0.400         0.200         0.400         0.400
R@10 (g=2)           0.500         0.250         0.500         0.500
MRR                  0.333         0.333         1.000         1.000
nDCG@10              0.298         0.206         0.512         0.522
Success@3            1.000         1.000         1.000         1.000

rank keyword                          semantic                         hybrid                           hybrid+expand
1    kap-sh/capo [0]                  remotion-dev/github-unwrapped-2022 [0] productdevbook/misina [2]   productdevbook/misina [2]
2    juspay/hyperswitch [0]           forwardemail/supertest [0]       juspay/hyperswitch [0]           sindresorhus/ky [2]
3    sindresorhus/ky [2]              productdevbook/misina [2]        sindresorhus/ky [2]              juspay/hyperswitch [0]
4    productdevbook/misina [2]        ts-rest/ts-rest [1]              netlify/gotrue [0]               nock/nock [0]
5    Portkey-AI/gateway [0]           requarks/wiki [0]                lsongdev/node-dns [0]            mw10013/tanstack-cloudflare-effect-saas [0]
6    cloudflare/cloudflare-go [0]     httptoolkit/httptoolkit-server [0] kap-sh/capo [0]                inngest/utah [0]
7    achtungsoftware/alarik [0]       httptoolkit/httptoolkit [0]      remotion-dev/github-unwrapped-2022 [0] inngest/inngest [0]
8    inngest/utah [0]                 flawiddsouza/Restfox [0]         forwardemail/supertest [0]       bradenaw/backpressure [0]
9    microsoft/markitdown [0]         Remocn/remocn [0]                ts-rest/ts-rest [1]              shieldfy/API-Security-Checklist [0]
10   aome510/spotify-player [0]       unjs/httpxy [0]                  Portkey-AI/gateway [0]           unjs/httpxy [0]
```

This is the **worst descriptive query** (hybrid nDCG 0.512 vs 0.72 target). Keyword's `AND(http, client, with, retries)` matched junk (`kap-sh/capo` is an AWS SDK); the semantic top-3 is word-salad (`github-unwrapped-2022`, `supertest`, `misina`); the intended targets `better-auth/better-fetch` and `ecyrbe/zodios` never enter any top 10. Only 2 of 4 grade-2 hits are found. Notable: `with` is a poisonous common token for both legs, and no embedding signal exists for "has a retry implementation" unless the README says it — which better-fetch's tiny README (323 bytes) does not. Fix candidates: stopword-aware keyword AND, expansion ("retry, backoff, interceptors"), and a rerank stage.

### 4.4 `durable background jobs`

```
metric             keyword      semantic        hybrid hybrid+expand
P@5 (g≥1)            0.800         0.600         1.000         1.000
P@5 (g=2)            0.800         0.200         1.000         1.000
R@10 (g=2)           0.667         0.333         0.667         0.889
MRR                  1.000         1.000         1.000         1.000
nDCG@10              0.747         0.382         0.791         0.949
Success@3            1.000         0.000         1.000         1.000

rank keyword                          semantic                         hybrid                           hybrid+expand
1    openworkflowdev/openworkflow [2] durable-streams/durable-streams [1] openworkflowdev/openworkflow [2] dbos-inc/dbos-transact-ts [2]
2    hatchet-dev/hatchet [2]          lambrospetrou/durable-utils [1]  dbos-inc/dbos-transact-ts [2]    inngest/inngest [2]
3    triggerdotdev/trigger.dev [2]    danieljvdm/effect-cf [0]         TeamWarp/effect-mq [2]           hatchet-dev/hatchet [2]
4    TeamWarp/effect-mq [2]           dbos-inc/dbos-transact-ts [2]    inngest/inngest [2]              openworkflowdev/openworkflow [2]
5    HazelChat/hazel [0]              outerbase/browsable-durable-object [0] hatchet-dev/hatchet [2]    TeamWarp/effect-mq [2]
6    dbos-inc/dbos-transact-ts [2]    inngest/inngest [2]              cloudflare/cloudflare-prometheus-exporter [0] triggerdotdev/trigger.dev [2]
7    inngest/inngest [2]              openworkflowdev/openworkflow [2] coldter/worker-template-2026 [0]  runmq/queue [1]
8    shareAI-lab/learn-claude-code [0] gingerhendrix/cf-git-durable-object [0] durable-streams/durable-streams [1] falcondev-oss/workflow [2]
9    bytedance/deer-flow [0]          cloudflare/actors [0]            lambrospetrou/durable-utils [1]  restatedev/restate [2]
10   cloudflare/cloudflare-prometheus-exporter [0] deathbyknowledge/ripgit [0] triggerdotdev/trigger.dev [2] Openpanel-dev/groupmq [1]
```

The showcase for the intended design: keyword is strong (its top-4 are four grade-2 targets), semantic alone is unusable at the top (P@5 g2 0.2, Success@3 0), and the combination plus expansion reaches 8/9 targets in the top 10 (R@10 0.889, nDCG 0.949). Note the semantic leg still ranks better than keyword for `ingest`-style concepts — expansion is what extracts that recall.

### 4.5 `tui for git`

```
metric             keyword      semantic        hybrid hybrid+expand
P@5 (g≥1)            0.000         0.400         0.200         0.200
P@5 (g=2)            0.000         0.200         0.200         0.200
R@10 (g=2)           0.000         1.000         1.000         0.500
MRR                   n/a          0.500         0.200         0.500
nDCG@10              0.000         0.535         0.390         0.305
Success@3            0.000         1.000         0.000         1.000

rank keyword                          semantic                         hybrid                           hybrid+expand
1    rothgar/awesome-tuis [0]         git/git [0]                      rothgar/awesome-tuis [0]         rothgar/awesome-tuis [0]
2    xai-org/grok-build [0]           gitbutlerapp/gitbutler [2]       git-bug/git-bug [0]              jesseduffield/lazygit [2]
3    jordond/jolt [0]                 tiimgreen/github-cheat-sheet [0] MoonshotAI/kimi-code [0]         dlvhdr/gh-dash [0]
4    pythops/impala [0]               pomber/git-history [1]           pythops/impala [0]               samtay/tetris [0]
5    MoonshotAI/kimi-code [0]         git-bug/git-bug [0]              jesseduffield/lazygit [2]        1j01/textual-paint [0]
6    ayn2op/discordo [0]              go-gitea/gitea [0]               GitoxideLabs/gitoxide [1]        pythops/impala [0]
7    sirmalloc/ccstatusline [0]       jesseduffield/lazygit [2]        charmbracelet/soft-serve [0]     webtui/webtui [0]
8    samtay/tetris [0]                rothgar/awesome-tuis [0]         git/git [0]                      MoonshotAI/kimi-code [0]
9    Adembc/lazyssh [0]               k88hudson/git-flight-rules [0]   gitbutlerapp/gitbutler [2]       ayn2op/discordo [0]
10   ChrisTitusTech/linutil [0]       go-git/go-git [0]                tiimgreen/github-cheat-sheet [0] go-git/go-git [0]
```

**Keyword is broken here** (nDCG 0.0, MRR n/a): `tui AND for AND git` matches `awesome-tuis` (a list README that contains all three strings) so the zero-result OR fallback never fires, and lazygit — whose description is "simple terminal UI for git commands", note *not* the token "tui" — never enters the top 10. Semantic rescues recall (gitbutler #2, lazygit #7, R@10 1.0) and expansion puts lazygit #2, but both fail to hold both targets in the top 3 simultaneously. This is the [07 §7.2](07-search-contract.md) OR-fallback rule failing exactly as doc 07 predicted for long queries, only worse: it needs to fire on *low-quality* AND matches, not only zero results.

### 4.6 `vector database`

```
metric             keyword      semantic        hybrid hybrid+expand
P@5 (g≥1)            1.000         0.800         1.000         0.800
P@5 (g=2)            0.400         0.400         0.400         0.400
R@10 (g=2)           1.000         1.000         1.000         1.000
MRR                  1.000         0.500         1.000         1.000
nDCG@10              0.789         0.523         0.668         0.704
Success@3            1.000         1.000         1.000         1.000

rank keyword                          semantic                         hybrid                           hybrid+expand
1    paradedb/paradedb [1]            vectordotdev/vector [0]          paradedb/paradedb [1]            paradedb/paradedb [1]
2    weaviate/weaviate [2]            paradedb/paradedb [1]            milvus-io/milvus [2]             milvus-io/milvus [2]
3    milvus-io/milvus [2]             milvus-io/milvus [2]             weaviate/weaviate [2]            weaviate/weaviate [2]
4    ayoubnabil/aiondb [1]            devflowinc/trieve [1]            devflowinc/trieve [1]            devflowinc/trieve [1]
5    meilisearch/meilisearch [1]      weaviate/weaviate [2]            supabase/vecs [1]                Tencent/WeKnora [0]
6    supabase/supabase [1]            supabase/vecs [1]                memgraph/memgraph [0]            meilisearch/meilisearch [1]
7    redis/RedisInsight [0]           GreptimeTeam/greptimedb [0]      dead8309/ai-rag-crawler [0]      dabit3/semantic-search-nextjs-pinecone-langchain-chatgpt [0]
8    shubham0204/OnDevice-Face-Recognition-Android [0] RamiAwar/dataline [0]  pingcap/tidb [0]          supabase/vecs [1]
9    devflowinc/trieve [1]            OtterMind/Chat2DB [0]            dragonflydb/dragonfly [0]        memgraph/memgraph [0]
10   supabase/vecs [1]                veloxbase/veloxdb [0]           prisma/orm [0]                   dead8309/ai-rag-crawler [0]
```

Textbook case for hybrid + boosts: **semantic's #1 is `vectordotdev/vector` (an observability pipeline whose name matches the word "vector")**, and hybrid demotes it out of the top 10 while keeping semantic recall (R@10 1.0). Expansion hurts here (nDCG 0.704 vs 0.668 hybrid, 0.834 un-boosted expand) by injecting RAG-app noise (`WeKnora`, `semantic-search-nextjs-pinecone…`); expansion clusters need negative/precision guards.

### 4.7 `rate limit`

```
metric             keyword      semantic        hybrid hybrid+expand
P@5 (g≥1)            0.800         0.600         0.800         0.800
P@5 (g=2)            0.600         0.600         0.600         0.600
R@10 (g=2)           1.000         1.000         1.000         1.000
MRR                  1.000         1.000         1.000         1.000
nDCG@10              0.941         0.793         0.866         0.866
Success@3            1.000         1.000         1.000         1.000

rank keyword                          semantic                         hybrid                           hybrid+expand
1    upstash/ratelimit-js [2]         upstash/ratelimit-js [2]         upstash/ratelimit-js [2]         animir/node-rate-limiter-flexible [2]
2    animir/node-rate-limiter-flexible [2] animir/node-rate-limiter-flexible [2] animir/node-rate-limiter-flexible [2] upstash/ratelimit-js [2]
3    rhinobase/hono-rate-limiter [2]  baidu/Unlimited-OCR [0]          rhinobase/hono-rate-limiter [2]  rhinobase/hono-rate-limiter [2]
4    sindresorhus/p-queue [1]         rhinobase/hono-rate-limiter [2]  NoobyGains/claude-pulse [0]      bradenaw/backpressure [1]
5    NoobyGains/claude-pulse [0]      NoobyGains/claude-pulse [0]      bradenaw/backpressure [1]        OultimoCoder/cloudflare-planetscale-hono-boilerplate [0]
6    OultimoCoder/cloudflare-planetscale-hono-boilerplate [0] garrytan/gstack [0] nilbuild/claude-statusline [0]  mw10013/tanstack-cloudflare-effect-saas [0]
7    DevLeoko/license-gate [0]        bradenaw/backpressure [1]        fabriziosalmi/caddy-waf [1]      higress-group/higress [0]
8    fabriziosalmi/caddy-waf [1]     nilbuild/claude-statusline [0]    mw10013/tanstack-cloudflare-effect-saas [0] apeacock1991/email-routing-support [0]
9    unkeyed/unkey [1]                kajisho5/ffmpeg-skill [0]        baidu/Unlimited-OCR [0]          teivah/sre-roadmap [0]
10   bradenaw/backpressure [1]        shawwn/llama-dl [0]              garrytan/gstack [0]              sindresorhus/p-queue [1]
```

All modes find all three grade-2 libraries; keyword is already the best-ordered (nDCG 0.941) and expansion slightly dilutes it (0.866). `rate limit` is the query class where exact terms exist in names/descriptions and no expansion is needed. Expansion should be **opt-in per query** or precision-gated (e.g. only when the keyword leg has <50 hits or weak top scores).

### 4.8 `effect` (ambiguous known-item canary)

```
metric             keyword      semantic        hybrid hybrid+expand
P@5 (g≥1)            1.000         1.000         1.000         1.000
P@5 (g=2)            0.200         0.200         0.200         0.200
R@10 (g=2)           1.000         1.000         1.000         1.000
MRR                  1.000         1.000         1.000         1.000
nDCG@10              1.000         1.000         1.000         1.000
Success@3            1.000         1.000         1.000         1.000

rank keyword                          semantic                         hybrid                           hybrid+expand
1    Effect-TS/effect [2]             Effect-TS/effect [2]             Effect-TS/effect [2]             Effect-TS/effect [2]
2    danieljvdm/effect-agent [1]      danieljvdm/effect-agent [1]      danieljvdm/effect-agent [1]      danieljvdm/effect-agent [1]
3    TeamWarp/effect-mq [1]           TeamWarp/effect-mq [1]           TeamWarp/effect-mq [1]           TeamWarp/effect-mq [1]
4    danieljvdm/effect-cf [1]         danieljvdm/effect-cf [1]         danieljvdm/effect-cf [1]         kitlangton/visual-effect [1]
5    kitlangton/visual-effect [1]     kitlangton/visual-effect [1]     kitlangton/visual-effect [1]     danieljvdm/effect-cf [1]
6    alchemy-run/alchemy [1]          alchemy-run/alchemy [1]          alchemy-run/alchemy [1]          alchemy-run/alchemy [1]
7    Dhravya/landing-effects [0]      kitlangton/skills [0]            Dhravya/landing-effects [0]      typestack/typedi [0]
8    dmmulroy/anti-slop [0]           alex/what-happens-when [0]       kitlangton/skills [0]            kitlangton/skills [0]
9    wwmm/easyeffects [0]             Dhravya/landing-effects [0]      wwmm/easyeffects [0]             marcj/deepkit [0]
10   Schneegans/Burn-My-Windows [0]   wwmm/easyeffects [0]             mw10013/tanstack-cloudflare-effect-shopify-app [0] needle-di/needle-di [0]
```

Exact-name behavior works precisely as [07 §5.3](07-search-contract.md) intends: the name == query match wins in every leg, and the distractor `magicuidesign/magicui` never appears. Known-item class nDCG = 1.000 across modes.

## 5. Boost ablation (nDCG@10 means, 8 queries)

| Mode | boosts ON | boosts OFF | Δ |
|---|---|---|---|
| keyword | 0.626 | 0.587 | **+0.039** |
| semantic | 0.626 | 0.569 | **+0.058** |
| hybrid | 0.692 | 0.665 | **+0.028** |
| hybrid+expand | 0.742 | 0.738 | +0.004 |

Per-query, boosts are uneven: they help the two `auth` queries and `durable-jobs` strongly, are neutral elsewhere, and **hurt** `http-client-retries` hybrid (0.512 vs 0.554), `tui-for-git` semantic (0.535 vs 0.561), `vector-db` expand (0.704 vs 0.834) and `rate-limit` hybrid (0.866 vs 0.901). The pattern: name-family boosts help when the query contains a distinctive token that actually appears in intended repo names, and hurt when the query's head token is a generic vocabulary word (`auth`, `vector`, `tui`).

## 6. Failures and causes

1. **Exact-name boost is not specificity-aware** — `auth` ×1.60 on a 24★ repo (whose name is literally `auth`) pins it to #1 through fusion; `auth-spec` gets ×1.20 prefix. Contract intent ("known-item guarantee") is right for `lazygit`-class queries and wrong for single generic words. Fix: gate name boosts on token rarity (e.g. token appears in ≤ N repo names, or query has ≥ 2 tokens / contains punctuation), or compute the factor from name-match IDF; alternatively reserve ×1.60 for `full_name`/owner-qualified queries only.
2. **AND poisoning + zero-only OR fallback** — `tui for git` keeps AND semantics because list repos match all three strings; lazygit ("terminal UI") is not "tui". Fix: IDF/stopword split (`for` optional), min-should-match, or run both AND and OR and fuse.
3. **Embedding name dominance** — repo docs lead with `owner/name` twice; cosine #1 for `auth-ts` is a 1★ service `quanghuy1242/auther`, for `vector database` an observability pipeline `vectordotdev/vector`. Fix: down-weight/omit the name in the embedded doc (keep it in a separate exact-match field), or length-normalize when a name token is also the query; hybrid fusion already mitigates this at the top-10 level (it demotes `vector` out).
4. **Thin-README targets are invisible to semantic search** — `better-fetch` (323 B) and `zodios` have no retry vocabulary in their docs, so "http client with retries" cannot retrieve them at all. Expansion is the only cheap fix; a reranker can't rerank what wasn't retrieved.
5. **Expansion is not precision-safe** — it injects RAG/blog noise when the query already has good lexical anchors (`rate limit`, `vector database`). Fix: trigger only on weak keywords / use cluster terms as *boosts to the existing legs* rather than additional retrievers, or add negative terms.
6. **Strict R@10 is unreachable for broad queries** — `auth` has 24 grade-2 repos; top-10 recall maxes at 10/24 = 0.417. The [07](07-search-contract.md) gate (≥0.85) is undefined for that shape; add a "core targets in top-k" metric or grade a narrower target set.
7. **Local embedding throughput** (5.3 docs/s fp32, 1.5-kB docs) makes full-corpus re-indexing an 11-minute affair locally; not a deployment issue, but any doc-text change in eval costs ~10 min (or a model dtype change to q8).

## 7. What this implies for docs 07 / 15

1. **Ship `hybrid+expand` as the default intent for descriptive queries; keep plain hybrid for known-item/identifier.** Concretely: route by presence of an expansion cluster and/or by keyword quality. The measured gain (overall nDCG 0.692 → 0.742, auth-ts 0.700 → 0.808, durable-jobs 0.791 → 0.949) is larger than the [07](07-search-contract.md) launch-gate margin for hybrid over keyword.
2. **Do not wait for an LLM for expansion** ([07 §8](07-search-contract.md), [15 §8](15-free-semantic-search.md) both push it to v2). A static cluster table is deterministic, free, auditable and already pays. Design the stage as `expand(query) → {terms, cluster_id}` so the LLM can replace the implementation later without moving the pipeline slot.
3. **Model/dims**: `bge-small-en-v1.5` at **384 d** is a viable free-tier repo-level default and is *cheaper* than doc 15's 512-d plan (5.3 MB of f32 vectors for 3.4k repos; ~5–7 ms scalar scan in Node). It is not MRL, so the 512 → 256 fallback ladder in [15 §6.1](15-free-semantic-search.md) would not apply; if the Workers AI path stays on qwen3-embedding, run this gold set at 512/384/256 before freezing dims. ⚠️ We could not test the actual deployed models here.
4. **Keep one vector per repo; chunking is not the bottleneck.** The failures are top-rank precision and vocabulary, not recall. Semantic R@10 (0.689) already exceeds keyword (0.604) and hybrid (0.740) is best; chunk-level indexing would multiply embedding cost ([15 §5](15-free-semantic-search.md): ~6.3×) without addressing the observed errors. Revisit only if rerank needs passages (rerank passages can still come from `repo_chunks` text without chunk *vectors*).
5. **Boost table needs an IDF/specificity modifier and a weaker star-prior asymmetry** — the current ×1.60/×1.45/×1.20 family makes generic tokens sticky; [07 §5.3](07-search-contract.md) should add "boosts only when the matched token is discriminative" and revisit the ×1.25 star cap (a 30k★ auth leader only gets ×1.18, which cannot compete with a 24★ exact-name match once one leg ranks it #1).
6. **Replace zero-only OR fallback with quality-aware matching** ([07 §7.2](07-search-contract.md)) **and add an IDF stopword list**; `with`, `for` must not be mandatory. This is a cheap, high-leverage change: `tui for git` keyword goes from nDCG 0.0 / MRR n/a to (with fallback fired) at least lazygit reachable.
7. **Filters are validated**: SQL pre-filtering by language produced 1,235 candidates for the TS query with precision 1.000 and sub-2 ms filter time; topic AND semantics and star ranges are the right shape for the free design ([15 §2.1](15-free-semantic-search.md)). No need for Vectorize metadata indexes.
8. **Rerank remains the unproven lever.** Ranking failures concentrate in top-5 precision, which is exactly what `bge-reranker-base` over top-30 ([07 §5.4](07-search-contract.md)) is for; this lab cannot measure it (no Workers AI). The eval plan should test rerank before committing to chunk-level or larger models.
9. **Metric fix**: R@10 needs a query-shape guard (broad multi-target queries) or a companion "core-target hit rate"; otherwise [07 §3.2](07-search-contract.md) gates will be both unreachable and meaningless for `auth`-style queries.

## 8. Open questions

1. **Gold-set bias**: pass-2 labels were added after seeing ranker output; the *absolute* numbers are inflated relative to a pre-registered gold set. Directional deltas (expand > hybrid > keyword, boost wins/losses) are the durable result.
2. **Only 8 queries, 1 known-item, 0 deliberate misses/browse queries.** No latency targets or empty-result behavior measured. The full golden set in [07 §3.3](07-search-contract.md) (60–100 queries) is still required before launch gates.
3. **Model transfer**: do qwen3-embedding-0.6b (512/256 MRL) and bge-m3 rank this same gold set better or worse than bge-small-en-v1.5? Which model fixes the `http client with retries` class on Workers AI? ⚠️ Needs a deployed run.
4. **Boost/IDF thresholds** (what counts as a generic token) are untuned; are name boosts still needed at all for hybrid, given un-boosted fusion fixed the auth example?
5. **Expansion precision**: can clusters be made safe for already-good queries (precision gate; negative terms; cluster scores)? What is the held-out-query generalization cost of hand-curated clusters?
6. **Rerank**: does top-30 rerank fix `http-client-retries` and `tui-for-git` without harming `effect`? Is repo-level rerank enough or are chunk passages required?
7. **Workerd**: the 384-d/l5k-repo scan needs a real derating measurement ([15 §5](15-free-semantic-search.md) open question 2); Node's 5–7 ms has no isolate CPU meter attached.
8. **README misses**: 16/3,448 (including one 0-byte) — do metadata-only docs need a dedicated fallback vector, or is lexical reachability enough ([07 §8](07-search-contract.md) says the latter)?
9. **Name-in-doc ablation**: this run deliberately included `full_name` at the head of every embedded doc per the task spec. Would embedding description+README only (name kept as a lexical field) remove the `vector`/`auther` artifacts? One re-embedding pass (~11 min locally) answers it.

## Sources and artifacts

- Harness: `eval-lab/` — `src/{fetch-stars,fetch-readmes,index,engine,search,eval,diag,candidates}.ts`, gold in `eval-lab/gold/queries.json`; reproduce with `pnpm run fetch-stars && pnpm run fetch-readmes && pnpm run index && pnpm run eval`.
- Outputs: `eval-lab/data/eval-run-2.txt` (raw console run), `eval-lab/data/eval-results.json` (machine-readable), `eval-lab/data/diag.txt` (boost ablation), `eval-lab/data/index-stats.json`, `eval-lab/data/candidates.txt` (gold-validation pool). `data/` is git-ignored.
- Design inputs: [07 — Search Contract](07-search-contract.md) (query classes, metrics, boosts, RRF), [15 — Free Semantic Search](15-free-semantic-search.md) (repo-level vector design, model options, CPU budget), [13 — Free-Tier Feasibility](13-free-tier-feasibility.md) (why Vectorize is out).
- Models/libraries: `Xenova/bge-small-en-v1.5` (384 d, fp32, CLS pooling, retrieval query instruction: <https://huggingface.co/BAAI/bge-small-en-v1.5>), `@huggingface/transformers` 3.8.1, Node 26.8.2 `node:sqlite` FTS5 (<https://nodejs.org/api/sqlite.html>), SQLite FTS5 bm25/trigram (<https://www.sqlite.org/fts5.html>), RRF k=60 (Cormack et al. 2009).
- Run date: 2026-09-13. Corpus snapshot: `data/stars.json` (3,448 repos) fetched the same day; READMEs 3,432/3,448.
