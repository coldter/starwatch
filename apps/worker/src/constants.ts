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

/** Per-leg top-N fed into RRF (docs/17 §3: each leg keeps its own top-50). */
export const SEARCH_LEG_LIMIT = 50;

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
