// engine — query execution over the local SQLite FTS5 + repo-embedding index.
import { Schema } from "effect";
import type { DatabaseSync } from "node:sqlite";
import {
  computeBoosts,
  embedQuery,
  expansionTerms,
  filterSql,
  ftsAnd,
  ftsOr,
  tokenize,
  openDb,
  EMBED_DIMS,
  RepoRowSchema,
  type Filters,
  type Ranked,
  type RepoRow,
} from "./lib.ts";

export type Mode = "keyword" | "semantic" | "hybrid" | "hybrid+expand";

export interface SearchOptions {
  query: string;
  mode: Mode;
  filters?: Filters;
  limit?: number;
  boost?: boolean;
}

export interface Hit {
  rank: number;
  repo_id: number;
  full_name: string;
  description: string | null;
  language: string | null;
  stars: number;
  url: string;
  archived: boolean;
  topics: string[];
  score: number;
  lex_rank: number | null;
  sem_rank: number | null;
  reasons: string[];
  keyword_snippet?: string;
}

export interface SearchOutput {
  mode: Mode;
  query: string;
  filters: Filters;
  expansion: string[];
  keyword_fallback: string | null; // 'or' | 'trigram' | null
  legs: { keyword: number; semantic: number; filtered_universe: number | null };
  timing_ms: Record<string, number>;
  hits: Hit[];
}

/** Result of the keyword leg: ranked ids plus the fallback path that was used. */
export interface KeywordLeg {
  list: Ranked[];
  fallback: string | null;
  primaryCount: number;
}

/** A fused search candidate before boosts are applied and hits are materialised. */
interface Candidate {
  id: number;
  base: number;
  lex_rank: number | null;
  sem_rank: number | null;
  factors: string[];
  boost: number;
}

const FTS_WEIGHTS = "8.0, 3.0, 3.0, 1.0"; // name, description, topics, readme

const TopicsJson = Schema.fromJsonString(
  Schema.mutable(Schema.Array(Schema.String)),
);

/** Parse a `topics_json` column; malformed data degrades to "no topics". */
export function parseTopics(json: string): string[] {
  try {
    return Schema.decodeUnknownSync(TopicsJson)(json);
  } catch {
    return [];
  }
}

const RepoIdRow = Schema.Struct({ id: Schema.Number });

const EmbeddingRowSchema = Schema.Struct({
  repo_id: Schema.Number,
  vector: Schema.Uint8Array,
});

const KeywordRowSchema = Schema.Struct({
  id: Schema.Number,
  score: Schema.Number,
});

type KeywordRow = typeof KeywordRowSchema.Type;

const KeywordRows = Schema.mutable(Schema.Array(KeywordRowSchema));

const SnippetRow = Schema.Struct({ s: Schema.String });

export class LabIndex {
  readonly db: DatabaseSync;
  private vectors: Map<number, Float32Array> | null = null;
  private rows = new Map<number, RepoRow>();

  constructor(db: DatabaseSync) {
    this.db = db;

    for (const r of db.prepare("SELECT * FROM repos").all()) {
      const row = Schema.decodeUnknownSync(RepoRowSchema)(r);
      this.rows.set(row.id, row);
    }
  }

  static open(): LabIndex {
    return new LabIndex(openDb(true));
  }

  get repoCount(): number {
    return this.rows.size;
  }

  repo(id: number): RepoRow | undefined {
    return this.rows.get(id);
  }

  loadVectors(): Map<number, Float32Array> {
    if (this.vectors) return this.vectors;
    const map = new Map<number, Float32Array>();

    for (const r of this.db
      .prepare("SELECT repo_id, vector FROM embeddings")
      .all()) {
      const row = Schema.decodeUnknownSync(EmbeddingRowSchema)(r);
      const bytes = row.vector.slice();
      map.set(
        row.repo_id,
        new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4),
      );
    }

    this.vectors = map;

    return map;
  }

  /** Set of repo ids matching the filters, or null when no filters are active. */
  filteredIds(filters: Filters | undefined): Set<number> | null {
    const f = filters ?? {};

    const active =
      f.language !== undefined ||
      f.minStars !== undefined ||
      f.maxStars !== undefined ||
      f.includeArchived === false ||
      (f.topics && f.topics.length > 0);

    if (!active) return null;
    const { where, params } = filterSql(f);
    const set = new Set<number>();

    for (const r of this.db
      .prepare(`SELECT id FROM repos WHERE 1=1${where}`)
      .all(...params)) {
      set.add(Schema.decodeUnknownSync(RepoIdRow)(r).id);
    }

    return set;
  }

  private inClause(ids: Set<number>): string {
    return ids.size === 0 ? " AND 0" : ` AND r.id IN (${[...ids].join(",")})`;
  }

  /** Porter bm25 keyword leg with AND→OR fallback and a trigram rescue for identifiers. */
  keyword(
    terms: string[],
    filterIds: Set<number> | null,
    useExpansion: boolean,
  ): KeywordLeg {
    if (terms.length === 0)
      return { list: [], fallback: null, primaryCount: 0 };

    if (filterIds && filterIds.size === 0)
      return { list: [], fallback: null, primaryCount: 0 };
    const filterWhere = filterIds ? this.inClause(filterIds) : "";

    const run = (
      table: "repos_fts" | "repos_tri",
      match: string,
    ): KeywordRow[] => {
      const sql = `SELECT f.rowid AS id, bm25(${table}, ${FTS_WEIGHTS}) AS score
                   FROM ${table} f JOIN repos r ON r.id = f.rowid
                   WHERE ${table} MATCH ?${filterWhere}
                   ORDER BY score LIMIT 50`;

      return Schema.decodeUnknownSync(KeywordRows)(
        this.db.prepare(sql).all(match),
      );
    };

    const rank = (rows: KeywordRow[]): Ranked[] =>
      rows.map((row, i) => ({ id: row.id, rank: i + 1, score: row.score }));

    let fallback: string | null = null;
    let primary = run("repos_fts", ftsAnd(terms));
    const primaryCount = primary.length;

    if (primary.length === 0 && terms.length > 1) {
      primary = run("repos_fts", ftsOr(terms));
      fallback = "or";
    }

    let list = rank(primary);

    if (useExpansion) {
      const exp = expansionTerms(terms.join(" "));

      if (exp.length > 0) {
        const expanded = rank(run("repos_fts", ftsOr(exp)));
        const merged = new Map<number, number>();

        for (const l of [list, expanded]) {
          for (const item of l)
            merged.set(
              item.id,
              (merged.get(item.id) ?? 0) + 1 / (60 + item.rank),
            );
        }

        list = [...merged.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 50)
          .map(([id, v], i) => ({ id, rank: i + 1, score: v }));
      }
    }

    // Trigram rescue when porter matched nothing (identifiers, typos, incidental strings).
    if (list.length === 0) {
      const triTerms = terms.filter((t) => t.length >= 3);

      if (triTerms.length > 0) {
        try {
          const rows = run(
            "repos_tri",
            triTerms.map((t) => `"${t.replaceAll('"', '""')}"`).join(" OR "),
          );

          if (rows.length > 0) {
            list = rank(rows);
            fallback = fallback ?? "trigram";
          }
        } catch {
          /* trigram needs >= 3 chars per phrase; ignore */
        }
      }
    }

    return { list, fallback, primaryCount };
  }

  /** Brute-force cosine over repo vectors (already L2-normalized → dot product). */
  semantic(qvec: Float32Array, filterIds: Set<number> | null): Ranked[] {
    const vectors = this.loadVectors();
    const scored: { id: number; score: number }[] = [];

    for (const [id, vec] of vectors) {
      if (filterIds && !filterIds.has(id)) continue;
      let s = 0;

      for (let i = 0; i < EMBED_DIMS; i++) s += qvec[i] * vec[i];
      scored.push({ id, score: s });
    }

    scored.sort((a, b) => b.score - a.score);

    return scored
      .slice(0, 50)
      .map((item, i) => ({ id: item.id, rank: i + 1, score: item.score }));
  }
}

export async function runSearch(
  index: LabIndex,
  opts: SearchOptions,
): Promise<SearchOutput> {
  const tStart = performance.now();
  const mode = opts.mode;
  const limit = opts.limit ?? 10;
  const boost = opts.boost !== false;
  const timings: Record<string, number> = {};

  const filterIds = index.filteredIds(opts.filters);
  timings.filter = performance.now() - tStart;

  const qTerms = tokenize(opts.query);
  const useExpansion = mode === "hybrid+expand";
  const expansion = useExpansion ? expansionTerms(opts.query) : [];

  let lex: Ranked[] = [];
  let fallback: string | null = null;
  let tLeg = performance.now();

  if (mode === "keyword" || mode === "hybrid" || mode === "hybrid+expand") {
    const r = index.keyword(qTerms, filterIds, useExpansion);
    lex = r.list;
    fallback = r.fallback;
  }

  timings.keyword = performance.now() - tLeg;

  let sem: Ranked[] = [];

  if (mode === "semantic" || mode === "hybrid" || mode === "hybrid+expand") {
    const extra = useExpansion ? expansion.join(" ") : "";
    tLeg = performance.now();
    const qvec = await embedQuery(opts.query, extra);
    timings.embed = performance.now() - tLeg;
    tLeg = performance.now();
    sem = index.semantic(qvec, filterIds);
    timings.semantic = performance.now() - tLeg;
  }

  // RRF over [lexical, semantic]; empty legs simply contribute nothing.
  const legs: (Ranked[] | null)[] = [lex, sem];
  const fused = new Map<number, { rrf: number; legs: (number | null)[] }>();
  legs.forEach((leg, li) => {
    for (const item of leg ?? []) {
      const cur = fused.get(item.id) ?? { rrf: 0, legs: [null, null] };
      cur.rrf += 1 / (60 + item.rank);
      cur.legs[li] = item.rank;
      fused.set(item.id, cur);
    }
  });

  const candidates: Candidate[] = [...fused.entries()].map(([id, v]) => ({
    id,
    base: v.rrf,
    lex_rank: v.legs[0],
    sem_rank: v.legs[1],
    factors: [],
    boost: 1,
  }));

  if (boost) {
    for (const c of candidates) {
      const row = index.repo(c.id);

      if (!row) continue;

      const { factor, reasons } = computeBoosts(
        {
          full_name: row.full_name,
          description: row.description,
          language: row.language,
          topics: parseTopics(row.topics_json),
          stargazers_count: row.stars,
          url: row.url,
          pushed_at: row.pushed_at,
          archived: !!row.archived,
          fork: !!row.fork,
          starred_at: row.starred_at,
        },
        opts.query,
      );

      c.boost = factor;
      c.factors = reasons;
    }
  }

  candidates.sort(
    (a, b) => b.base * b.boost - a.base * a.boost || b.base - a.base,
  );

  const hits: Hit[] = candidates.slice(0, limit).map((c, i) => {
    const row = index.repo(c.id)!;
    let snippet: string | undefined;

    if (c.lex_rank) {
      try {
        const row = index.db
          .prepare(
            `SELECT snippet(repos_fts, 3, '<mark>', '</mark>', ' … ', 20) AS s FROM repos_fts WHERE rowid = ?`,
          )
          .get(c.id);

        if (row !== undefined)
          snippet = Schema.decodeUnknownSync(SnippetRow)(row).s;
      } catch {
        /* no snippet */
      }
    }

    return {
      rank: i + 1,
      repo_id: c.id,
      full_name: row.full_name,
      description: row.description,
      language: row.language,
      stars: row.stars,
      url: row.url,
      archived: !!row.archived,
      topics: parseTopics(row.topics_json),
      score: c.base * c.boost,
      lex_rank: c.lex_rank,
      sem_rank: c.sem_rank,
      reasons: c.factors,
      keyword_snippet: snippet,
    };
  });

  timings.total = performance.now() - tStart;

  return {
    mode,
    query: opts.query,
    filters: opts.filters ?? {},
    expansion,
    keyword_fallback: fallback,
    legs: {
      keyword: lex.length,
      semantic: sem.length,
      filtered_universe: filterIds ? filterIds.size : null,
    },
    timing_ms: timings,
    hits,
  };
}
