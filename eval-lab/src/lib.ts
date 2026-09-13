// Shared utilities for the eval lab: paths, corpus IO, markdown stripping, tokenization,
// embedding model access, FTS query building, RRF and boost factors.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const LAB_DIR = path.resolve(import.meta.dirname, '..');
export const DATA_DIR = path.join(LAB_DIR, 'data');
export const README_DIR = path.join(DATA_DIR, 'readmes');
export const DB_PATH = path.join(DATA_DIR, 'starwatch-eval.db');

export const MODEL_ID = 'Xenova/bge-small-en-v1.5';
export const EMBED_DIMS = 384;
// bge-en-v1.5 model card: retrieval queries get this instruction prefix; documents get none.
export const QUERY_PREFIX = 'Represent this sentence for searching relevant passages: ';
export const README_EMBED_CHARS = 1500;

export interface Star {
  full_name: string;
  description: string | null;
  language: string | null;
  topics: string[];
  stargazers_count: number;
  url: string;
  pushed_at: string;
  archived: boolean;
  fork: boolean;
  starred_at: string;
}

export function readStars(): Star[] {
  return JSON.parse(readFileSync(path.join(DATA_DIR, 'stars.json'), 'utf8')) as Star[];
}

export function readmeFile(fullName: string): string {
  return path.join(README_DIR, fullName.replace('/', '__') + '.md');
}

export function readReadme(fullName: string): string | null {
  const f = readmeFile(fullName);
  return existsSync(f) ? readFileSync(f, 'utf8') : null;
}

/** Remove markdown noise (badges/images, HTML, link URLs) and collapse whitespace. */
export function stripMarkdown(md: string): string {
  let t = md;
  t = t.replace(/<!--[\s\S]*?-->/g, ' ');                 // comments
  t = t.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ');            // images (badges)
  t = t.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');          // links -> text
  t = t.replace(/<[^>]+>/g, ' ');                         // html tags
  t = t.replace(/```[^\n]*/g, ' ');                       // fence markers (keep code lines)
  t = t.replace(/^\s{0,3}#{1,6}\s+/gm, '');               // headings
  t = t.replace(/^\s{0,3}>\s?/gm, '');                    // blockquotes
  t = t.replace(/\r/g, '');
  t = t.replace(/[ \t]+/g, ' ');
  t = t.replace(/\n{3,}/g, '\n\n');
  return t.trim();
}

export function buildDoc(star: Star, readme: string | null): string {
  const meta = [
    star.full_name,
    star.description ?? '',
    star.topics.length ? `topics: ${star.topics.join(', ')}` : '',
    `lang: ${star.language ?? 'unknown'}`,
  ].filter(Boolean).join(' — ');
  const body = readme ? stripMarkdown(readme).slice(0, README_EMBED_CHARS) : '';
  return body ? `${meta}\n${body}` : meta;
}

// ---------------------------------------------------------------- embedding

type Extractor = (texts: string[], opts: Record<string, unknown>) => Promise<{ dims: number[]; data: Float32Array }>;
let extractor: Extractor | null = null;

async function getExtractor(): Promise<Extractor> {
  if (!extractor) {
    const { pipeline, env } = await import('@huggingface/transformers');
    env.cacheDir = path.join(DATA_DIR, 'models');
    env.allowRemoteModels = true;
    const pipe = await pipeline('feature-extraction', MODEL_ID, { dtype: 'fp32' });
    extractor = pipe as unknown as Extractor;
  }
  return extractor;
}

/** Embed texts (already prefixed if queries). Returns one Float32Array per input; L2-normalized. */
export async function embedTexts(texts: string[]): Promise<Float32Array[]> {
  const pipe = await getExtractor();
  const out: Float32Array[] = [];
  for (let i = 0; i < texts.length; i += 32) {
    const batch = texts.slice(i, i + 32);
    const res = await pipe(batch, { pooling: 'cls', normalize: true });
    const [n, d] = res.dims;
    for (let j = 0; j < n; j++) {
      const vec = new Float32Array(d);
      vec.set(res.data.subarray(j * d, (j + 1) * d));
      out.push(vec);
    }
  }
  return out;
}

export async function embedQuery(query: string, extra = ''): Promise<Float32Array> {
  const [v] = await embedTexts([QUERY_PREFIX + query + (extra ? ' ' + extra : '')]);
  return v;
}

// ---------------------------------------------------------------- query text

const TOKEN_RE = /[\p{L}\p{N}][\p{L}\p{N}._/+#@:-]*/gu;

export function tokenize(text: string): string[] {
  return (text.toLowerCase().match(TOKEN_RE) ?? []).filter((t) => t.length > 0);
}

function quoteFts(term: string): string {
  return `"${term.replaceAll('"', '""')}"`;
}

export function ftsAnd(terms: string[]): string {
  return terms.map(quoteFts).join(' AND ');
}

export function ftsOr(terms: string[]): string {
  return terms.map(quoteFts).join(' OR ');
}

// ---------------------------------------------------------------- expansions

/** Static synonym clusters, one per acceptance/representative query. Extend as eval requires. */
export const EXPANSIONS: { id: string; triggers: string[]; terms: string[] }[] = [
  {
    id: 'auth',
    triggers: ['auth', 'authentication', 'authorization', 'identity', 'login', 'sso'],
    terms: ['authentication', 'authorization', 'oauth', 'oauth2', 'oidc', 'openid', 'sso', 'identity provider', 'access control', 'jwt', 'session', 'rbac', 'permissions', 'casbin', 'zitadel', 'keycloak', 'authelia', 'logto'],
  },
  {
    id: 'http-client',
    triggers: ['http', 'client', 'fetch', 'request', 'retry', 'retries'],
    terms: ['http client', 'fetch', 'request', 'retry', 'backoff', 'resilience', 'circuit breaker', 'interceptors', 'axios', 'ky', 'got', 'undici', 'rate limiting'],
  },
  {
    id: 'durable-jobs',
    triggers: ['durable', 'background', 'jobs', 'job', 'queue', 'workflow', 'scheduler'],
    terms: ['background jobs', 'job queue', 'workflow engine', 'durable execution', 'scheduler', 'cron', 'task queue', 'retries', 'workers', 'event-driven', 'step functions'],
  },
  {
    id: 'tui-git',
    triggers: ['tui', 'terminal', 'git'],
    terms: ['terminal user interface', 'terminal ui', 'git client', 'git ui', 'interactive git', 'console interface', 'curses', 'text user interface'],
  },
  {
    id: 'vector-db',
    triggers: ['vector', 'embedding', 'embeddings', 'semantic', 'similarity'],
    terms: ['vector database', 'embeddings', 'similarity search', 'nearest neighbor', 'ann search', 'vector store', 'semantic search', 'faiss', 'hnsw', 'pgvector', 'qdrant', 'lance', 'chroma'],
  },
  {
    id: 'rate-limit',
    triggers: ['rate', 'limit', 'throttle', 'throttling', 'quota'],
    terms: ['rate limiting', 'throttling', 'rate limiter', 'quota', 'token bucket', 'leaky bucket', 'backpressure', 'middleware', 'api gateway'],
  },
  {
    id: 'effect',
    triggers: ['effect', 'effect-ts', 'effectts'],
    terms: ['effect-ts', 'effect typescript', 'functional programming', 'effect system', 'typed effects', 'dependency injection', 'schema validation', 'algebraic effects'],
  },
];

/** Terms from every cluster whose trigger token appears in the query. */
export function expansionTerms(query: string): string[] {
  const toks = new Set(tokenize(query));
  const out = new Set<string>();
  for (const cluster of EXPANSIONS) {
    if (cluster.triggers.some((t) => toks.has(t))) {
      for (const term of cluster.terms) out.add(term);
    }
  }
  return [...out];
}

// ---------------------------------------------------------------- filters

export interface Filters {
  language?: string;
  topics?: string[];
  minStars?: number;
  maxStars?: number;
  includeArchived?: boolean; // default true (archived gets a rank penalty, not exclusion)
}

export const LANG_ALIASES: Record<string, string> = {
  ts: 'TypeScript', typescript: 'TypeScript',
  js: 'JavaScript', javascript: 'JavaScript',
  py: 'Python', python: 'Python',
  rs: 'Rust', rust: 'Rust',
  go: 'Go', golang: 'Go',
  java: 'Java', kt: 'Kotlin', kotlin: 'Kotlin',
  cpp: 'C++', c: 'C', sh: 'Shell', shell: 'Shell',
  rb: 'Ruby', ruby: 'Ruby', php: 'PHP', cs: 'C#', csharp: 'C#',
};

export function canonicalLanguage(lang: string): string {
  return LANG_ALIASES[lang.toLowerCase()] ?? lang;
}

/** SQL WHERE fragment + params that select repo ids matching the filters. */
export function filterSql(f: Filters): { where: string; params: (string | number)[] } {
  const clauses: string[] = [];
  const params: (string | number)[] = [];
  if (f.language) {
    if (f.language.toLowerCase() === 'unknown') clauses.push('language IS NULL');
    else { clauses.push('LOWER(language) = LOWER(?)'); params.push(canonicalLanguage(f.language)); }
  }
  if (f.minStars !== undefined) { clauses.push('stars >= ?'); params.push(f.minStars); }
  if (f.maxStars !== undefined) { clauses.push('stars <= ?'); params.push(f.maxStars); }
  if (f.includeArchived === false) clauses.push('archived = 0');
  for (const topic of f.topics ?? []) {
    clauses.push('EXISTS (SELECT 1 FROM json_each(repos.topics_json) WHERE value = ?)');
    params.push(topic);
  }
  return { where: clauses.length ? ' AND ' + clauses.join(' AND ') : '', params };
}

// ---------------------------------------------------------------- boosts

export interface BoostResult { factor: number; reasons: string[] }

export function computeBoosts(star: Star, query: string, nowMs = Date.now()): BoostResult {
  let factor = 1;
  const reasons: string[] = [];
  const name = star.full_name.split('/')[1].toLowerCase();
  const q = query.trim().toLowerCase();
  const qTokens = tokenize(query);

  if (q === star.full_name.toLowerCase() || q === name) {
    factor *= 1.6; reasons.push('exact-name ×1.60');
  } else if (qTokens.length === 1 && qTokens[0] === name) {
    factor *= 1.45; reasons.push('name-exact ×1.45');
  } else if (qTokens.some((t) => t.length >= 3 && name.startsWith(t))) {
    factor *= 1.2; reasons.push('name-prefix ×1.20');
  } else if (qTokens.length > 1 && qTokens.every((t) => name.includes(t))) {
    factor *= 1.1; reasons.push('all-tokens-in-name ×1.10');
  }

  const starPrior = Math.min(1.25, 1 + 0.04 * Math.log10(star.stargazers_count + 1));
  factor *= starPrior;
  reasons.push(`stars ×${starPrior.toFixed(3)}`);

  if (star.archived) { factor *= 0.4; reasons.push('archived ×0.40'); }

  const starredMs = Date.parse(star.starred_at);
  if (!Number.isNaN(starredMs)) {
    const days = (nowMs - starredMs) / 86_400_000;
    if (days <= 90) { factor *= 1.1; reasons.push('starred<90d ×1.10'); }
    else if (days <= 365) { factor *= 1.05; reasons.push('starred<1y ×1.05'); }
  }
  return { factor, reasons };
}

// ---------------------------------------------------------------- ranking

export interface Ranked { id: number; rank: number; score: number }

/** Reciprocal rank fusion, k=60. Missing legs simply do not add a term. */
export function rrf(legs: (Ranked[] | null)[], k = 60): Map<number, { rrf: number; legs: (number | null)[] }> {
  const out = new Map<number, { rrf: number; legs: (number | null)[] }>();
  legs.forEach((leg, li) => {
    for (const item of leg ?? []) {
      const cur = out.get(item.id) ?? { rrf: 0, legs: legs.map(() => null) };
      cur.rrf += 1 / (k + item.rank);
      cur.legs[li] = item.rank;
      out.set(item.id, cur);
    }
  });
  return out;
}

// ---------------------------------------------------------------- db access

export interface RepoRow {
  id: number;
  full_name: string;
  description: string | null;
  language: string | null;
  topics_json: string;
  stars: number;
  url: string;
  pushed_at: string;
  archived: number;
  fork: number;
  starred_at: string;
  readme_len: number;
}

export function openDb(readonly = true): DatabaseSync {
  return new DatabaseSync(DB_PATH, { readOnly: readonly });
}

export function repoById(db: DatabaseSync, id: number): RepoRow | undefined {
  return db.prepare('SELECT * FROM repos WHERE id = ?').get(id) as RepoRow | undefined;
}

export function languageName(row: RepoRow): string {
  return row.language ?? 'unknown';
}
