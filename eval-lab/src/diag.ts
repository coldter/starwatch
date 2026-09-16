// diag — boost on/off comparison + filter-precision assertion for the report.
import { Schema } from "effect";
import { readFileSync } from "node:fs";
import path from "node:path";
import { LabIndex, runSearch, type Hit, type Mode } from "./engine.ts";
import { GoldQueriesFile, LAB_DIR } from "./lib.ts";

const MODES: Mode[] = ["keyword", "semantic", "hybrid", "hybrid+expand"];

function metrics(hits: Hit[], rel: Record<string, number>) {
  const grade = (n: string) => rel[n] ?? 0;
  const g2 = Object.entries(rel)
    .filter(([, g]) => g === 2)
    .map(([n]) => n);
  const top = hits.slice(0, 10);
  const p5g2 =
    top.slice(0, 5).filter((h) => grade(h.full_name) === 2).length / 5;
  const r10 = g2.length
    ? g2.filter((n) => top.some((h) => h.full_name === n)).length / g2.length
    : null;
  let mrr: number | null = null;

  for (let i = 0; i < top.length; i++)
    if (grade(top[i].full_name) >= 1) {
      mrr = 1 / (i + 1);
      break;
    }

  const dcg = top.reduce(
    (a, h, i) => a + (2 ** grade(h.full_name) - 1) / Math.log2(i + 2),
    0,
  );
  const idcg = Object.values(rel)
    .sort((a, b) => b - a)
    .slice(0, 10)
    .reduce((a, g, i) => a + (2 ** g - 1) / Math.log2(i + 2), 0);

  return { p5g2, r10, mrr, ndcg: idcg ? dcg / idcg : null };
}

const f = (v: number | null) => (v === null ? "n/a" : v.toFixed(3));

async function main(): Promise<void> {
  const golden = Schema.decodeUnknownSync(GoldQueriesFile)(
    readFileSync(path.join(LAB_DIR, "gold", "queries.json"), "utf8"),
  );
  const index = LabIndex.open();
  console.log(
    "query                mode          boost   P@5g2  R@10  MRR   nDCG@10",
  );

  for (const q of golden.queries) {
    for (const mode of MODES) {
      for (const boost of [true, false]) {
        const out = await runSearch(index, {
          query: q.query,
          mode,
          filters: q.filters,
          limit: 10,
          boost,
        });

        // filter precision assertion
        if (q.filters.language) {
          const bad = out.hits.filter((h) => {
            const row = index.repo(h.repo_id)!;

            return (
              (row.language ?? "unknown").toLowerCase() !==
              q.filters.language!.toLowerCase()
            );
          });

          if (bad.length > 0)
            console.log(
              `  !! filter violation on ${q.id}: ${bad.map((b) => b.full_name).join(",")}`,
            );
        }

        const m = metrics(out.hits, q.relevance);
        console.log(
          `${q.id.padEnd(21)}${mode.padEnd(14)}${String(boost).padEnd(8)}${f(m.p5g2).padEnd(7)}${f(m.r10).padEnd(6)}${f(m.mrr).padEnd(6)}${f(m.ndcg)}`,
        );
      }
    }
  }
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
