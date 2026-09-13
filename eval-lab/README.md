# @starwatch/eval-lab

Local search-quality lab for the free-tier design: **SQLite FTS5 (porter + trigram) + one 384-d embedding per repo + RRF (k=60) + static query expansion**. No Cloudflare account, no paid APIs. Results and the full write-up live in [`docs/18-search-quality-eval.md`](../docs/18-search-quality-eval.md).

## Run it

```bash
cd eval-lab

# 0) prerequisites: ghl authenticated as the corpus owner (read-only), Node >= 26, pnpm install
pnpm run fetch-stars        # gh api --paginate -> data/stars.json
pnpm run fetch-readmes      # raw.githubusercontent.com -> data/readmes/{owner}__{repo}.md (cap 15 min)
pnpm run index              # node:sqlite FTS5 + Xenova/bge-small-en-v1.5 (fp32, 384d) -> data/starwatch-eval.db
pnpm run search -- "auth" --mode hybrid --lang ts --limit 10
pnpm run eval               # gold set -> data/eval-results.json + console tables
```

`search` flags: `--mode keyword|semantic|hybrid|hybrid+expand --lang ts --topic x --min-stars N --limit N --json --no-boost`.

## Layout

| Path | What |
|---|---|
| `src/fetch-stars.ts` | star list -> `data/stars.json` (3,448 repos) |
| `src/fetch-readmes.ts` | README cache, raw-first + `gh api` fallback, misses -> `data/readmes-misses.json` |
| `src/lib.ts` | corpus IO, markdown strip, embedding model, tokenization, filters, boosts, RRF |
| `src/index.ts` | builds `data/starwatch-eval.db` (repos + `repos_fts` porter + `repos_tri` trigram + `embeddings`) |
| `src/engine.ts` | keyword/semantic legs, RRF fusion, boosts, expansions |
| `src/search.ts` | CLI |
| `src/eval.ts` | gold-set runner: P@5 / R@10 / MRR / nDCG@10 / Success@3 |
| `src/diag.ts` | boost on/off comparison + filter-precision assertion |
| `src/candidates.ts` | union of top-20 per mode, used to validate gold labels |
| `gold/queries.json` | hand-graded gold set over the actual corpus |
| `data/` | generated: stars, READMEs, models, DB, eval outputs (git-ignored) |

## Notes

- `node:sqlite` on Node 26 ships FTS5 with `porter unicode61` and `trigram` — no native `better-sqlite3` required.
- Embeddings use `Xenova/bge-small-en-v1.5` fp32 (384 d) with the model card's retrieval instruction on queries only; each repo doc is `full_name — description | topics | lang` + first 1,500 chars of stripped README.
- Local fp32 CPU embedding is ~5 docs/s for full README docs (ONNX pads batches; short metadata-only docs run ~180/s).
- Boost factors follow `docs/07-search-contract.md` §5.3; `--no-boost` disables them for ablation.
- This lab is a **ranking-quality harness, not a Cloudflare reproduction**: workerd CPU/derating, Workers AI models (qwen3-embedding / bge-m3), rerank, D1/R2 layout and network latency are out of scope.
