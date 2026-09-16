// eval — run the gold set through every mode, compute P@5 / R@10 / MRR / nDCG@10 / Success@3.
// usage: node src/eval.ts [--gold gold/queries.json] [--modes keyword,semantic,hybrid,hybrid+expand]
import { Schema } from "effect";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  LabIndex,
  runSearch,
  type Hit,
  type Mode,
  type SearchOutput,
} from "./engine.ts";
import { DATA_DIR, GoldQueriesFile, LAB_DIR, type Filters } from "./lib.ts";

interface Metrics {
  p5: number | null; // precision@5, grades >= 1
  p5g2: number | null; // precision@5, grade == 2 only
  r10: number | null; // recall@10 over grade-2 targets
  mrr: number | null; // reciprocal rank of first grade >= 1
  ndcg10: number | null;
  success3: number | null; // a grade-2 in top 3
}

interface QueryResult {
  id: string;
  class: string;
  query: string;
  filters: Filters;
  notes?: string;
  relevance: Record<string, number>;
  modes: Record<
    string,
    {
      metrics: Metrics;
      hits: Hit[];
      timing_ms: Record<string, number>;
      expansion: string[];
      fallback: string | null;
      legs: SearchOutput["legs"];
    }
  >;
  orphanedGold: string[];
}

const MODES: Mode[] = ["keyword", "semantic", "hybrid", "hybrid+expand"];

function computeMetrics(hits: Hit[], rel: Record<string, number>): Metrics {
  const grade = (name: string): number => rel[name] ?? 0;
  const g2 = Object.entries(rel)
    .filter(([, g]) => g === 2)
    .map(([n]) => n);
  const top = hits.slice(0, 10);
  const p5 = top.slice(0, 5).filter((h) => grade(h.full_name) >= 1).length / 5;
  const p5g2 =
    top.slice(0, 5).filter((h) => grade(h.full_name) === 2).length / 5;
  const r10 =
    g2.length === 0
      ? null
      : g2.filter((n) => top.some((h) => h.full_name === n)).length / g2.length;
  let mrr: number | null = null;

  for (let i = 0; i < top.length; i++) {
    if (grade(top[i].full_name) >= 1) {
      mrr = 1 / (i + 1);
      break;
    }
  }

  const dcg = top.reduce(
    (a, h, i) => a + (2 ** grade(h.full_name) - 1) / Math.log2(i + 2),
    0,
  );

  const idcg = Object.values(rel)
    .sort((a, b) => b - a)
    .slice(0, 10)
    .reduce((a, g, i) => a + (2 ** g - 1) / Math.log2(i + 2), 0);

  const ndcg10 = idcg === 0 ? null : dcg / idcg;
  const success3 = top.slice(0, 3).some((h) => grade(h.full_name) === 2)
    ? 1
    : 0;

  return { p5, p5g2, r10, mrr, ndcg10, success3 };
}

function fmt(v: number | null, digits = 3): string {
  return v === null ? " n/a " : v.toFixed(digits);
}

function printQueryResult(qr: QueryResult): void {
  const filterStr = [
    qr.filters.language ? `lang=${qr.filters.language}` : "",
    qr.filters.topics?.length ? `topics=${qr.filters.topics.join("+")}` : "",
  ]
    .filter(Boolean)
    .join(" ");

  console.log(
    `\n## ${qr.id} — "${qr.query}"${filterStr ? `  [${filterStr}]` : ""}  (${qr.class})`,
  );

  if (qr.orphanedGold.length)
    console.log(`   ⚠ gold repos not in corpus: ${qr.orphanedGold.join(", ")}`);
  console.log("");
  const header = ["metric", ...MODES].map((m, i) =>
    i === 0 ? m.padEnd(12) : m.padStart(14),
  );
  console.log(header.join(""));

  const rows: [string, (m: Metrics) => number | null][] = [
    ["P@5 (g≥1)", (m) => m.p5],
    ["P@5 (g=2)", (m) => m.p5g2],
    ["R@10 (g=2)", (m) => m.r10],
    ["MRR", (m) => m.mrr],
    ["nDCG@10", (m) => m.ndcg10],
    ["Success@3", (m) => m.success3],
  ];

  for (const [label, get] of rows) {
    console.log(
      [
        label.padEnd(12),
        ...MODES.map((m) => fmt(get(qr.modes[m].metrics)).padStart(14)),
      ].join(""),
    );
  }

  const legInfo = MODES.map(
    (m) =>
      `${m}:kw=${qr.modes[m].legs.keyword},sem=${qr.modes[m].legs.semantic}${qr.modes[m].legs.filtered_universe !== null ? `,uni=${qr.modes[m].legs.filtered_universe}` : ""}`,
  ).join("  ");
  console.log(`leg sizes: ${legInfo}`);
  console.log("");
  const w = 44;
  console.log(
    ["rank", ...MODES.map((m) => m.padEnd(w))]
      .map((s, i) => (i === 0 ? s.padEnd(5) : s))
      .join(""),
  );

  for (let r = 0; r < 10; r++) {
    const cells = MODES.map((m) => {
      const h = qr.modes[m].hits[r];

      if (!h) return "—".padEnd(w);
      const g = qr.relevance[h.full_name] ?? 0;

      return `${h.full_name} [${g}]`.padEnd(w);
    });

    console.log([String(r + 1).padEnd(5), ...cells].join(""));
  }
}

function avg(xs: (number | null)[]): number | null {
  const v = xs.filter((x): x is number => x !== null);

  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}

async function main(): Promise<void> {
  const golden = Schema.decodeUnknownSync(GoldQueriesFile)(
    readFileSync(path.join(LAB_DIR, "gold", "queries.json"), "utf8"),
  );
  const index = LabIndex.open();
  console.log(`# starwatch eval-lab — search quality run`);
  console.log(
    `corpus: ${index.repoCount} repos · gold queries: ${golden.queries.length} · modes: ${MODES.join(", ")} · boost factors: ON`,
  );
  const results: QueryResult[] = [];

  for (const q of golden.queries) {
    const orphans = Object.keys(q.relevance).filter((n) => {
      const found = index.db
        .prepare("SELECT 1 AS x FROM repos WHERE full_name = ?")
        .get(n);

      return !found;
    });

    const modes: QueryResult["modes"] = {};

    for (const mode of MODES) {
      const out = await runSearch(index, {
        query: q.query,
        mode,
        filters: q.filters,
        limit: 10,
        boost: true,
      });
      modes[mode] = {
        metrics: computeMetrics(out.hits, q.relevance),
        hits: out.hits,
        timing_ms: out.timing_ms,
        expansion: out.expansion,
        fallback: out.keyword_fallback,
        legs: out.legs,
      };
    }

    const qr: QueryResult = { ...q, modes, orphanedGold: orphans };
    results.push(qr);
    printQueryResult(qr);
  }

  console.log("\n# Overall (mean over queries; n/a skipped)");
  console.log("");
  console.log(
    ["metric", ...MODES]
      .map((m, i) => (i === 0 ? m.padEnd(12) : m.padStart(14)))
      .join(""),
  );

  const rows: [string, (qr: QueryResult, m: Mode) => number | null][] = [
    ["P@5 (g≥1)", (qr, m) => qr.modes[m].metrics.p5],
    ["P@5 (g=2)", (qr, m) => qr.modes[m].metrics.p5g2],
    ["R@10 (g=2)", (qr, m) => qr.modes[m].metrics.r10],
    ["MRR", (qr, m) => qr.modes[m].metrics.mrr],
    ["nDCG@10", (qr, m) => qr.modes[m].metrics.ndcg10],
    ["Success@3", (qr, m) => qr.modes[m].metrics.success3],
  ];

  for (const [label, get] of rows) {
    const cells = MODES.map((m) =>
      fmt(avg(results.map((qr) => get(qr, m)))).padStart(14),
    );
    console.log([label.padEnd(12), ...cells].join(""));
  }

  console.log("\n# By class (nDCG@10 mean)");
  const classes = [...new Set(results.map((r) => r.class))];
  console.log(
    ["class", ...MODES]
      .map((m, i) => (i === 0 ? m.padEnd(14) : m.padStart(14)))
      .join(""),
  );

  for (const c of classes) {
    const rs = results.filter((r) => r.class === c);
    console.log(
      [
        c.padEnd(14),
        ...MODES.map((m) =>
          fmt(avg(rs.map((r) => r.modes[m].metrics.ndcg10))).padStart(14),
        ),
      ].join(""),
    );
  }

  const payload = {
    run_at: new Date().toISOString(),
    corpus: { repos: index.repoCount, db: "data/starwatch-eval.db" },
    modes: MODES,
    queries: results,
    overall: Object.fromEntries(
      MODES.map((m) => [
        m,
        Object.fromEntries(
          rows.map(([label, get]) => [
            label,
            avg(results.map((qr) => get(qr, m))),
          ]),
        ),
      ]),
    ),
  };

  writeFileSync(
    path.join(DATA_DIR, "eval-results.json"),
    JSON.stringify(payload, null, 2) + "\n",
  );
  console.log("\nresults → data/eval-results.json");
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
