/**
 * Worker-wide tunables. Everything here is a free-tier budget constant, not a
 * business rule — see the linked docs before changing a value.
 */

/** Surface in `GET /api/health`; bump with releases. */
export const SERVICE_VERSION = "0.0.0";

/** Result page size when `limit` is absent / malformed (docs/07 §4.2). */
export const DEFAULT_SEARCH_LIMIT = 20;

/** Hard server-side cap; also the FTS/vector leg ceiling (docs/07 §4.2). */
export const MAX_SEARCH_LIMIT = 50;

/**
 * Hard ceiling for `offset` on a page request. The browse path can page a whole
 * star list (docs/08 §3.4), but an unbounded offset is a free way to ask for a
 * very expensive row window, so it is clamped at 10k (500 pages of 20).
 */
export const MAX_SEARCH_OFFSET = 10_000;

/** Per-leg top-N fed into RRF (docs/17 §3: each leg keeps its own top-50). */
export const SEARCH_LEG_LIMIT = 50;

/**
 * Per-leg top-N when the user asked for an explicit sort (docs/07 §5.5).
 * Relevance order is decided inside the fused top-50, so re-ordering that same
 * window would only ever show "the newest of the 50 most relevant" — a repo
 * pushed yesterday but ranked #60 would be invisible. Widening the legs makes
 * `sort=pushed|starred|stars` a real ordering of the match set while keeping
 * the relevance path (and its documented per-leg top-50) untouched. Only ids,
 * ranks and scores grow; snippets and README reads stay capped by `limit`.
 */
export const SORT_MATCH_LIMIT = 500;

/**
 * READMEs embedded in full snippets (`makeSnippet`) rather than falling back
 * to the description. Bounds the `getReadmeTexts` D1 read to one statement.
 */
export const SNIPPET_HITS = 10;

/**
 * Max candidate ids handed to one FTS MATCH. The storage layer chunks
 * candidate lists at 90 bound params per statement, so 9 chunks = 9 D1
 * queries per leg. Longer candidate lists skip the SQL pre-filter and rely on
 * post-fusion filtering (the fused repo map already enforces every filter).
 */
export const MAX_FTS_CANDIDATE_IDS = 810;

/** READMEs fetched per workflow step (see listing/refresh workflow math). */
export const README_FETCH_BATCH = 8;

/**
 * Batches between two progress heartbeats in the refresh workflow. The heartbeat
 * is what makes a dead run detectable (see `STALE_RUN_MS`) and what moves the
 * README counter in the UI, so it must stay well under that timeout; every
 * batch would add ~190 statements to the free-tier query budget for no extra
 * signal. 1,500 repos ÷ `README_FETCH_BATCH` = 188 batches → 47 heartbeats.
 */
export const README_PROGRESS_EVERY = 4;

/** Texts per embedding batch; also the Workers AI per-request ceiling. */
export const EMBED_BATCH = 32;

/**
 * Parts merged per workflow step. Each merge step reads `FAN_IN` R2 objects
 * and writes one, so it must stay under the per-invocation subrequest budget;
 * 40 is well inside the 50-external / 1,000-internal envelope.
 */
export const MERGE_FAN_IN = 40;

/** GitHub login validation (docs/14 §3.3): letters, digits, single hyphens. */
export const LOGIN_PATTERN = /^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}$/i;
