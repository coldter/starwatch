# 05 — CLI Interaction Spec

> ⚠️ **Pivot notice (2026-09-13):** this document predates the public multi-tenant pivot. See [08-public-service-ux.md](08-public-service-ux.md)–[12-hardening.md](12-hardening.md) for the current design and [11-assumptions-delta.md](11-assumptions-delta.md) for exactly what changed.

> Status: **draft for discussion** · 2026-09-13 · Target: `apps/cli` (Effect v4 `effect/unstable/cli`, rc.112). Flag names map 1:1 to WebUI query params and (v2) MCP arguments, mirroring `SearchFilters` in `packages/domain`.

## 1. Design principles

1. **Fast to scan, fast to pipe.** Human output answers "which repo was it?" in one screen; `--plain`/`--json` turn the same command into a data source for `jq`, `fzf`, scripts and agents.
2. **Scriptable by default, pretty by accident of TTY.** Color, prompts, spinners and width key off `isatty`; nothing blocks a pipe. `--no-input` forces this even on a TTY.
3. **One naming system.** `mode`, `lang`, `topic`, `group`, `min-stars` … are identical across CLI flags, WebUI filter state and MCP args, and map to `SearchFilters` (`minStars`, `starredAfter`, …).
4. **Errors are instructions.** Every failure names the fix (`Run: starwatch login`); no stack traces below `--log-level debug`. Exit codes distinguish "no results" from "broken" (§4.6).
5. **stdout is data, stderr is chatter.** Result payloads vs. progress/warnings/hints (§4.2).

## 2. Command tree

```
starwatch [global flags] <command>
login       Authenticate this machine (device flow or token)
logout      Forget the stored token
doctor      Diagnose config, API, auth, D1, Vectorize, R2, GitHub rate limit
status      Index stats, last sync, rate-limit state          (alias: stats)
sync        Start/tail/cancel a sync run
search      Search stars (keyword · semantic · hybrid + filters)
similar     More-like-this from a repo's summary vector
show        Full detail for one starred repo
groups      list · create · show · add · remove · rename · delete · export · import
config      get | set  (apiUrl, token, defaultMode, defaultLimit)
completions Print shell completions for bash | zsh | fish
```

**Global flags** (every command; ★ = built into Effect CLI):

| Flag | Notes |
|---|---|
| ★ `-h, --help` | help for the command path |
| ★ `-v, --version` | Effect's alias is `-v`, not `-V` |
| ★ `--wizard` | prompt for missing arguments (`Command.wizard`) |
| ★ `--completions <bash\|zsh\|fish\|sh>` | `sh` normalized to bash; same output as the `completions` command |
| ★ `--log-level <error\|warn\|info\|debug\|trace>` | `debug` prints one line per HTTP request with timing |
| `--no-color` | disable all ANSI, including bold (§4.3) |
| `--no-input` | never prompt; fail with the flag/action needed instead |

## 3. Commands

### 3.1 `login` / `logout` / `doctor` / `status`

`starwatch login [--device-code] [--token [<value>]] [--api-url <url>]` — default is **device flow on a TTY**, `--token` in scripts (§6.3); `--api-url` stores the deployment URL in the same step.
`starwatch logout [--yes]` — removes `token` (keeps `apiUrl`/defaults); confirms on TTY, requires `--yes` when piped.
`starwatch doctor [--offline] [--json]` — ordered `PASS/WARN/FAIL` checks, exit 1 on any FAIL; `--offline` validates config only. Checks: config file (exists, 0600, parses), API reachability + latency, auth, D1 counts, Vectorize count/dims (1024), R2 probe, GitHub rate limit (via Worker). All checks run, then a summary.
`starwatch status [--json]` — repos (starred + soft-deleted), chunks, vectors, last sync (status, times, duration, +new/~updated/−unstarred/errors), next cron, GitHub budget (remaining/limit/reset). `stats` is a hidden alias for R11 muscle memory.

```bash
starwatch login; starwatch login --token "$STARWATCH_TOKEN"; starwatch logout --yes
starwatch doctor --json | jq '.checks[] | select(.status=="fail")'; starwatch status --json
```

### 3.2 `sync`

`starwatch sync [--full] [--cancel] [--json]`

- Default: start an **incremental** run (ETag-diffed) and tail it; if a run is active, attach instead of starting a second.
- `--full`: refetch/re-embed ignoring ETags; rejected (exit 1) while another run is active.
- `--cancel`: cancel the active run and print final counters; idempotent (nothing active → exit 0).
- Progress on stderr, final summary on stdout; `--json` emits the run object. Ctrl-C **detaches** (the Workflow keeps running), prints the run id, exit 130.

```bash
starwatch sync && starwatch sync --full && starwatch sync --cancel
```

### 3.3 `search <query…>`

`starwatch search <query…> [flags]` — positional words are joined with single spaces, so quotes are optional (`starwatch search git tui`); a single `-` reads the query from stdin (first line).

| Flag | Default | Meaning |
|---|---|---|
| `--mode <auto\|keyword\|semantic\|hybrid>` | `auto` | `auto` = hybrid except identifier-looking queries → keyword (§5.1) |
| `-l, --lang <lang>` | – | GitHub language, case-insensitive (`rust`, `TypeScript`) |
| `--topic <t>[,<t>…]` | – | repeat = AND; comma within one occurrence = OR (topic slugs cannot contain commas) |
| `--group <name>` | – | repeat = OR (union); unknown name errors with closest matches |
| `--min-stars <n>` / `--max-stars <n>` | – | inclusive bounds |
| `--starred-after <d>` / `--starred-before <d>` | – | `YYYY-MM-DD` or ISO-8601 (UTC); relative via `$(date -d '-30 days' +%F)` |
| `--archived` / `--no-archived` | both | only archived / exclude archived; mutually exclusive |
| `--license <spdx>` | – | SPDX id, case-insensitive (`mit`, `apache-2.0`) |
| `--sort <relevance\|stars\|recent\|pushed>` | `relevance` | `recent` = starredAt desc, `pushed` = pushedAt desc |
| `-n, --limit <n>` | `10` | `1–50` (50 = Vectorize topK ceiling) |
| `-p, --page <n>` | `1` | keyword paginates freely; hybrid/semantic capped at 50 total (§5.4) |
| `--json` | off | one JSON envelope on stdout (§4.4) |
| `--explain` | off | per-leg ranks, RRF math, timings; not combinable with `--plain` |
| `-o, --open` | off | open the **top** hit (`$BROWSER`, else `xdg-open`/`open`); not combinable with `--json` |
| `--plain` | off | one `owner/repo` per line, no ANSI (§4.5) |

```bash
starwatch search "tui for git" --lang rust --min-stars 500 --topic tui
starwatch search "http client" --topic api,http --topic rust --sort stars --json
starwatch search "sqlite" --group inbox --explain
```

### 3.4 `similar` / `show`

`starwatch similar <owner/repo> [--limit <n>] [--json] [--explain|--plain] [-o]` — semantic neighbors from the repo's summary vector, source excluded; same output contract as search.
`starwatch show <owner/repo> [--json] [--readme] [-o]` — description, topics, language, stars, license, archived, starred/pushed dates, groups, URL. `--readme` prints the stored README to stdout; `--json` = `Repo` + `groups` + `readmeBytes`.

```bash
starwatch similar BurntSushi/ripgrep --limit 5
starwatch show BurntSushi/ripgrep --readme | less -R
```

### 3.5 `groups`

Local curated lists (e.g. "inbox", "rust-tools"), distinct from GitHub Star Lists; repos referenced by canonical `owner/repo`. Groups surface in `search`: cards show `[group1, group2]`, `--json` adds `groups` per hit (proposed `SearchHit` addition, §10), `--group` filters by union.

| Command | Behavior |
|---|---|
| `groups list [--json]` | names + repo counts |
| `groups create <name>` | slug `[a-z0-9][a-z0-9-]*`, ≤ 40 chars; exists → exit 1 |
| `groups show <name> [--plain\|--json]` | repos in the group |
| `groups add <name> <owner/repo…> [--json]` | repos must be indexed (else exit 1 + `sync` hint); duplicates are no-ops |
| `groups remove <name> <owner/repo…>` | non-member warns on stderr, exit 0 (idempotent) |
| `groups rename <old> <new>` | target exists → exit 1 |
| `groups delete <name> [--yes]` | group only, never the star; TTY confirm, `--yes` when piped |
| `groups export [<name>…]` | versioned JSON to stdout (all groups if none named) |
| `groups import <file\|-> [--replace] [--allow-unknown]` | default union merge; `--replace` overwrites named groups; unknown repos fail unless `--allow-unknown` |

```json
{ "version": 1, "exportedAt": "2026-09-13T10:00:00Z",
  "groups": { "inbox": ["effect-ts/effect", "tauri-apps/tauri"] } }
```
Stable and versioned; the same shape is accepted by `import`.

```bash
starwatch groups create inbox && starwatch groups add inbox effect-ts/effect
starwatch groups export inbox > inbox.json && starwatch groups import inbox.json
```

### 3.6 `config` / `completions`

`starwatch config get [key]` / `set <key> <value>` — keys `apiUrl`, `token`, `defaultMode`, `defaultLimit`. `get` without a key prints everything with `token` redacted (`sw_…f3a2`); `set` writes 0600 and confirms on stderr.
`starwatch completions <bash|zsh|fish>` — wrapper over Effect CLI's `--completions` (kept for discoverability and `gh` parity).

```bash
starwatch config set apiUrl https://starwatch.coldter.workers.dev; starwatch config get
starwatch completions zsh > ~/.zfunc/_starwatch
```

## 4. Output contract

### 4.1 Human result card

```
1. temporalio/temporal          ★ 12.1k · Go · [workflow, durability]    keyword+semantic
   Temporal is a durable execution platform for background jobs.
   "…retries, timers and durable background jobs with deterministic replay…"
   https://github.com/temporalio/temporal
```

- Layout: index, `fullName`, stars, language, groups, matched-by badge / description / snippet (≤ 200 chars, query terms bold) / URL (replaced by score lines under `--explain`).
- Width = `Terminal.columns` (fallback `$COLUMNS`, else 80), capped at 120; only description/snippet truncate with `…`. Styling: bold matched terms, dim metadata, no backgrounds.

### 4.2 stdout vs stderr

| Stream | Content |
|---|---|
| stdout | result cards, `--plain` names, `--json` document, `show`/`status`/`doctor` payload, sync final summary |
| stderr | progress/spinners, warnings, empty-result guidance, pagination hints, errors |

So `starwatch search … > results.txt` keeps hints visible without polluting the file, and `--plain | fzf` stays clean.

### 4.3 Color

`--no-color` defeats `FORCE_COLOR`/`CLICOLOR_FORCE`; otherwise color iff `NO_COLOR` is unset and stdout is a TTY (any value, even empty, disables). `--json`/`--plain` are never styled. Implemented once via `CliOutput.defaultFormatter({ colors })` plus a custom card formatter.

### 4.4 `--json`

One document (pretty on a TTY, compact when piped). Exit codes still apply: an empty search emits `"hits": []` **and** exits 2.

```jsonc
{
  "query": "durable jobs", "mode": "hybrid",
  "filters": { "language": "go", "minStars": 500, "topics": ["workflow"] },
  "page": 1, "limit": 10,
  "total": 2, "totalIsExact": false,   // exact for keyword; best-effort (≤50) otherwise
  "hasMore": false, "tookMs": 128,
  "hits": [{
    "repo": { /* packages/domain Repo: id, fullName, description, language, topics, stars,
                archived, license, pushedAt, starredAt, htmlUrl */ },
    "groups": ["inbox"],               // proposed SearchHit addition (§10)
    "score": 0.0325,                   // RRF; not comparable across queries
    "snippet": "…retries, timers and durable background jobs…",
    "matchedBy": ["keyword", "semantic"]
  }]
}
```
With `--explain`, each hit also carries `explain` (legs, ranks, RRF terms, timings).

With `--json`, errors also go to stderr as `{"error":{"code":"UNAUTHENTICATED","message":"…","hint":"Run: starwatch login"}}`. Codes: `BAD_FILTER`, `UNAUTHENTICATED`, `NOT_FOUND`, `RATE_LIMITED`, `NETWORK`, `SERVER`, `CONFLICT`, `INTERNAL`.

### 4.5 `--plain`

One canonical `owner/repo` per line, `\n`-terminated, no ANSI, no blank lines. Stable for `xargs`, `fzf`, `while read`.

### 4.6 Exit codes

| Code | Meaning |
|---|---|
| `0` | success; for `search`/`similar`: ≥ 1 hit |
| `1` | error: usage, validation, network, server, cancelled prompt |
| `2` | `search`/`similar` succeeded, 0 hits |
| `3` | not authenticated / token rejected (401/403) |
| `130` | interrupted (SIGINT) |

**Justification:** grep/rg proved the three-way split (results / no results / error) but put *error* at 2, which surprises `if` idioms. Here 0/1 keep POSIX meaning ("only 1 means broken"), 2 gives agents a distinct "reformulate" signal, and 3 isolates the failure with a mechanical fix ("login"). Cost: `set -e` scripts must guard empty searches (`|| [ $? -eq 2 ]`) or parse `--json` — acceptable, because the empty case is exactly where agents need to branch.

## 5. Search UX

### 5.1 `auto` mode

Server-side routing (doc 01 §7): single token, or a token containing `-`/`.`/`_`/`/`, or an exact repo-name match → `keyword`; everything else → `hybrid`. `--explain` always prints the route and why.

### 5.2 `--explain`

```
Explain: mode=hybrid (route: default) · filters: lang=go
  1. temporalio/temporal   rrf 0.0325
       keyword  #2  1/(60+2) = 0.01613   "durable background jobs" (bm25 4.21)
       semantic #1  1/(60+1) = 0.01639   chunk 3/7 (cosine 0.81)
Legs: keyword 41 ms · semantic 88 ms · rerank 61 ms · total 152 ms · reranked: yes (top 30)
```

### 5.3 Empty results

Guidance on stderr, stdout empty, exit 2:

```
No results for "quantum toaster" in hybrid mode.
Filters: min-stars ≥ 10000. 3,277 repos match those filters; 0 match the text.
Try: drop --min-stars · --mode keyword for exact names · starwatch sync if this was starred recently.
```

### 5.4 Pagination

`--limit` ≤ 50 per page; keyword paginates to any depth, while hybrid/semantic fuse a per-leg top 50 (effectively ≤ 50 hits per query; deeper pages error with that explanation). When more exist:

```
5 results · page 2 · more available — next: starwatch search "cli" -n 5 --page 3
```

### 5.5 Pickers and `--open`

```bash
starwatch search "git diff tui" --plain | fzf --preview 'starwatch show {}' --preview-window right,60%
starwatch search "effect" --open       # open the top hit and still print the list
starwatch show "$(starwatch search "git diff" --plain | fzf)" --open
```

An interactive `--pick` (Effect `Prompt.select`) is a v2 candidate (§10); `--plain | fzf` is the recommended pattern today.

## 6. Auth & config

### 6.1 File and precedence

Config: `${XDG_CONFIG_HOME:-$HOME/.config}/starwatch/config.json`, file 0600, dir 0700. Example: `{ "apiUrl": "https://starwatch.coldter.workers.dev", "token": "sw_…", "defaultMode": "auto", "defaultLimit": 10 }`.

Precedence **flag > env > config > default**. Env: `STARWATCH_API_URL`, `STARWATCH_TOKEN`, `NO_COLOR`, `FORCE_COLOR`, `BROWSER`. A malformed config is exit 1 with path + parse message; env vars still work, and `doctor` pinpoints it.

### 6.2 Token model

The GitHub PAT for sync lives only in Worker secrets (R14). The CLI holds a **starwatch token** (`sw_…`, 32 random bytes); non-public endpoints require `Authorization: Bearer`. It is never logged and is redacted by `config get` and `--json`.

### 6.3 Device-flow UX (default login)

```
$ starwatch login
! First copy your one-time code: WXYZ-1234
  Then open https://github.com/login/device in your browser.
  Waiting for authorization…
✓ Authenticated as coldter · token saved to ~/.config/starwatch/config.json (0600)
```

GitHub device flow (embedded OAuth client id) polling on the server-provided interval (honoring `slow_down`/expiry); on success the CLI POSTs the GitHub token once to the Worker's `/auth/exchange`, which verifies `GET /user` returns the allowed login and issues the `sw_` token. The GitHub token is not persisted. `--token` stores a deployment token directly (CI/agents); `--device-code` forces the flow.

### 6.4 Timeouts, retries, cold start

| Operation | Timeout | Retry policy |
|---|---|---|
| doctor/health probes | 5 s each | 2 GETs, 250 ms/1 s backoff |
| search/similar | 15 s | 2 GETs; retry network/5xx, honor `Retry-After` on 429 |
| sync start/cancel | 10 s | none (idempotent attach; re-running is safe) |
| device poll | until expiry | interval per GitHub, `slow_down` respected |

First request after a deploy can take ~1 s (isolate init); past 500 ms the CLI shows a `connecting…` spinner on stderr. Timeouts are per attempt, not cumulative. Offline/DNS errors print one line, exit 1; `doctor --offline` separates "bad config" from "bad network".

## 7. Edge cases

- **No network / unreachable Worker:** one-line error naming the URL and `starwatch doctor`; exit 1. No stack trace at default log level.
- **Unauthenticated:** fail fast with `Run: starwatch login`; exit 3. Env/`--token` are checked before config, so a corrupt config never blocks recovery.
- **`owner/repo` args:** accept `owner/repo`, `github.com/owner/repo`, full `https://` URLs, trailing `/`, `.git`; compare case-insensitively, output canonical index casing. Not indexed → exit 1 with `search`/`sync` hints.
- **Quoting/unicode:** UTF-8 pass-through, words joined with single spaces, only outer whitespace trimmed; quote queries containing `!`/`$`/`?`; `-` reads stdin.
- **Long output / piped:** no pager in v1 (pipe to `less -R`/`fzf`), `--limit` ≤ 50; no TTY → no color/prompts/spinners, width falls back to `$COLUMNS` (else 80, capped 120), `groups delete` needs `--yes`. Any `NO_COLOR` value disables ANSI; `--no-color` beats `FORCE_COLOR`; JSON/plain never styled.
- **Ctrl-C during sync:** detach only, print run id + re-attach hint, exit 130. `sync --full` during an active run is an error, not a silent mode change.
- **UTC everywhere:** filters and displayed timestamps are ISO-8601 UTC in v1; local rendering is an open question.

## 8. Prior art & what Effect CLI gives us

| Tool | Pattern borrowed |
|---|---|
| `gh` | per-command `--json`, jq-friendly documents, `--web`-style `--open`, `completion <shell>`, distinct exit codes; field-list `--json` is a candidate (§10) |
| `ripgrep` | 0/1/2 discipline (we remap error to 1), `--json` output |
| `fzf` | line-oriented stdin (our `--plain`), preview via `show`, SIGINT/130 etiquette |
| `llm` | `--plain` for readability, XDG config, `LLM_*`-style env overrides |
| `sqlite-utils` | explicit machine formats (`--nl` NDJSON), never mixing progress into stdout |

Effect CLI (rc.112, lowercase constructors) provides `--help`/`--version`/`--wizard`, `--completions` (bash/zsh/fish/sh), `Flag.choice/atLeast` (repeatable `--topic`/`--group`), `Flag.withFallbackConfig` (env/config defaults), `Flag.withFallbackPrompt` (interactive for missing values), `Prompt` (select/multiSelect/confirm/password/autoComplete), and a pluggable `CliOutput.Formatter`. We add `--no-color`, `--no-input`, the JSON envelope, and the exit-code table.

## 9. Example session

All outputs mocked.

```console
$ starwatch status
Index       3,277 repos · 19,842 chunks · 23,105 vectors (1024d)
Last sync   2026-09-13 03:00 UTC ✓ incremental · 2m 41s · +6 starred · ~14 readmes · −1 unstarred
Next sync   2026-09-14 03:00 UTC (nightly cron)
GitHub      4,912/5,000 requests remaining · resets in 41m

$ starwatch search "durable background jobs with retries" -n 3
1. temporalio/temporal        ★ 12.1k · Go · [workflow, durability]   keyword+semantic
   Temporal is a durable execution platform for background jobs.
   "…retries, timers and durable background jobs with deterministic replay…"
   https://github.com/temporalio/temporal
2. effect-ts/effect           ★ 8.2k · TypeScript · [effect]          semantic
   A toolkit to build production-grade TypeScript applications.
   "…retry policies and scheduling of effectful background work…"
   https://github.com/effect-ts/effect
2 results · 128 ms · mode hybrid

$ starwatch search "http client" --topic api,http --topic rust --sort stars --json \
    | jq -r '.hits[] | [.repo.fullName, .score, (.matchedBy|join("+"))] | @tsv'
seanmonstar/reqwest     0.0325  keyword+semantic
hyperium/hyper          0.0164  keyword

$ starwatch search effect --explain -n 1
Explain: mode=keyword (route: single token) · filters: none
  1. effect-ts/effect      rrf 0.0328
       keyword  #1  1/(60+1) = 0.01639   "effect" (bm25 9.87, name match)
       semantic #1  1/(60+1) = 0.01639   chunk 2/9 (cosine 0.91)
Legs: keyword 18 ms · semantic 88 ms · rerank 61 ms · total 152 ms · reranked: yes

$ starwatch search "quantum toaster" --min-stars 10000
No results for "quantum toaster" in hybrid mode.          # exit 2
Filters: min-stars ≥ 10000. 3,277 repos match those filters; 0 match the text.
Try: drop --min-stars · --mode keyword for exact names · starwatch sync.

$ starwatch search "git diff tui" --plain | fzf --preview 'starwatch show {}'
delta
difftastic
gitui-org/gitui

$ starwatch similar BurntSushi/ripgrep -n 3
1. ast-grep/ast-grep          ★ 9.1k · Rust · [ast, grep]            semantic
   A CLI tool for code structural search, lint, and rewriting.
   "…pattern-based structural search across source files…"
   https://github.com/ast-grep/ast-grep
3 results · 95 ms · mode semantic (similar)

$ starwatch show tauri-apps/tauri
tauri-apps/tauri   ★ 92.4k · Rust · Apache-2.0 · not archived
Build smaller, faster, and more secure desktop applications with a web frontend.
Starred 2024-03-18 · Pushed 2026-09-12 · Groups: desktop, rust-tools
Topics: rust, desktop, webview, tauri · https://github.com/tauri-apps/tauri
README 41,832 bytes — view with: starwatch show tauri-apps/tauri --readme

$ starwatch groups create inbox && starwatch groups add inbox effect-ts/effect tauri-apps/tauri
✓ Created group "inbox" · ✓ Added 2 repos to "inbox"
$ starwatch groups list
inbox        2
rust-tools   12

$ starwatch sync --full
Sync run 8f3c91 started (full backfill)
  list pages   ██████████ 33/33 · readmes 3,277 fetched · embed 19,842 chunks → 23,105 vectors
✓ done in 34m 02s · +0 starred · ~3,277 updated · 0 unstarred · 2 errors (retried)

$ starwatch doctor
PASS config     ~/.config/starwatch/config.json (0600)
PASS api        https://starwatch.coldter.workers.dev · 143 ms
PASS auth       token accepted
PASS indexes    3,277 repos · 19,842 chunks · 23,105 vectors (1024d)
WARN github     4,912/5,000 requests remaining · resets in 41m
5 passed · 1 warning · 0 failed
```

## 10. Open questions

1. **`status` vs `stats`:** this spec renames R11's `stats` to `status` (alias kept). Update 00-requirements R11, or keep `stats` canonical?
2. **Auth model:** is device flow worth its moving parts for a single user, or is `login --token` (static deployment token) enough? If kept, the `/auth/exchange` endpoint needs an API decision.
3. **`--topic a,b` = OR:** confirm the comma convention; alternative is a separate `--any-topic`.
4. **`--jq <expr>` built-in** (gh-style, no external jq) vs. relying on `jq` — a built-in needs a JS jq engine.
5. **NDJSON / pager:** add `--nl` streaming for `jq -c` pipelines, and/or honor `$PAGER` on a TTY?
6. **`--pick` interactive selector** (Effect `Prompt.autoComplete`) in addition to `--plain | fzf`?
7. **Hybrid pagination:** accept the 50-hit ceiling, or run multiple Vectorize queries to page deeper?
8. **Groups in the domain:** add `groups: string[]` to `SearchHit`, or keep groups CLI-envelope-only?
