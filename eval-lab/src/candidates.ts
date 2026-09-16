// candidates — dump the union of top-20 per mode for each gold query, with metadata and a README peek.
// Used to verify the gold sets against the candidate pool (doc 07 §3.3) before locking.
import { Match, Schema } from "effect";
import { readFileSync } from "node:fs";
import path from "node:path";
import { LabIndex, runSearch, type Mode } from "./engine.ts";
import { GoldQueriesFile, LAB_DIR, readReadme } from "./lib.ts";

const MODES: Mode[] = ["keyword", "semantic", "hybrid", "hybrid+expand"];

// Pool repositories are joined back by name; decode the columns this script reads.
const PoolRowSchema = Schema.Struct({
  id: Schema.Number,
  language: Schema.NullOr(Schema.String),
  stars: Schema.Number,
  description: Schema.NullOr(Schema.String),
  readme_len: Schema.Number,
});

async function main(): Promise<void> {
  const golden = Schema.decodeUnknownSync(GoldQueriesFile)(
    readFileSync(path.join(LAB_DIR, "gold", "queries.json"), "utf8"),
  );
  const index = LabIndex.open();

  for (const q of golden.queries) {
    const pool = new Map<string, { grades: string[]; lex: number | null; sem: number | null }>();

    for (const mode of MODES) {
      const out = await runSearch(index, {
        query: q.query,
        mode,
        filters: q.filters,
        limit: 20,
        boost: true,
      });

      const modeTag = Match.value(mode).pipe(
        Match.when("keyword", () => "K"),
        Match.when("semantic", () => "S"),
        Match.when("hybrid", () => "H"),
        Match.when("hybrid+expand", () => "E"),
        Match.exhaustive,
      );

      for (const h of out.hits) {
        const cur = pool.get(h.full_name) ?? { grades: [], lex: null, sem: null };
        cur.grades.push(`#${h.rank}${modeTag}`);

        if (h.lex_rank && (cur.lex === null || h.lex_rank < cur.lex)) cur.lex = h.lex_rank;

        if (h.sem_rank && (cur.sem === null || h.sem_rank < cur.sem)) cur.sem = h.sem_rank;
        pool.set(h.full_name, cur);
      }
    }

    console.log(`\n########## ${q.id} — "${q.query}"  pool=${pool.size}`);

    for (const [name, info] of pool) {
      const row = Schema.decodeUnknownSync(PoolRowSchema)(
        index.db
          .prepare(
            "SELECT id, language, stars, description, readme_len FROM repos WHERE full_name = ?",
          )
          .get(name),
      );

      const gold = q.relevance[name] ?? 0;
      const readme = readReadme(name);
      const peek = readme ? readme.replace(/\s+/g, " ").slice(0, 130) : "";
      console.log(
        `${gold} | ${name} [${row.language ?? "-"}] ★${row.stars} rl=${row.readme_len} | ${info.grades.join(" ")} | lex=${info.lex ?? "-"} sem=${info.sem ?? "-"}`,
      );
      console.log(`    desc: ${row.description ?? ""}`);
      console.log(`    readme: ${peek}`);
    }
  }
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
