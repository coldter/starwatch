// candidates — dump the union of top-20 per mode for each gold query, with metadata and a README peek.
// Used to verify the gold sets against the candidate pool (doc 07 §3.3) before locking.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { LabIndex, runSearch, type Mode } from './engine.ts';
import { LAB_DIR, readReadme, type Filters } from './lib.ts';

interface GoldQuery { id: string; query: string; filters: Filters; relevance: Record<string, number> }
const MODES: Mode[] = ['keyword', 'semantic', 'hybrid', 'hybrid+expand'];

async function main(): Promise<void> {
  const golden = JSON.parse(readFileSync(path.join(LAB_DIR, 'gold', 'queries.json'), 'utf8')) as { queries: GoldQuery[] };
  const index = LabIndex.open();
  for (const q of golden.queries) {
    const pool = new Map<string, { grades: string[]; lex: number | null; sem: number | null }>();
    for (const mode of MODES) {
      const out = await runSearch(index, { query: q.query, mode, filters: q.filters, limit: 20, boost: true });
      for (const h of out.hits) {
        const cur = pool.get(h.full_name) ?? { grades: [], lex: null, sem: null };
        cur.grades.push(`#${h.rank}${mode === 'keyword' ? 'K' : mode === 'semantic' ? 'S' : mode === 'hybrid' ? 'H' : 'E'}`);
        if (h.lex_rank && (cur.lex === null || h.lex_rank < cur.lex)) cur.lex = h.lex_rank;
        if (h.sem_rank && (cur.sem === null || h.sem_rank < cur.sem)) cur.sem = h.sem_rank;
        pool.set(h.full_name, cur);
      }
    }
    console.log(`\n########## ${q.id} — "${q.query}"  pool=${pool.size}`);
    for (const [name, info] of pool) {
      const row = index.db.prepare('SELECT id, language, stars, description, readme_len FROM repos WHERE full_name = ?').get(name) as
        { id: number; language: string | null; stars: number; description: string | null; readme_len: number };
      const gold = q.relevance[name] ?? 0;
      const readme = readReadme(name);
      const peek = readme ? readme.replace(/\s+/g, ' ').slice(0, 130) : '';
      console.log(`${gold} | ${name} [${row.language ?? '-'}] ★${row.stars} rl=${row.readme_len} | ${info.grades.join(' ')} | lex=${info.lex ?? '-'} sem=${info.sem ?? '-'}`);
      console.log(`    desc: ${row.description ?? ''}`);
      console.log(`    readme: ${peek}`);
    }
  }
}

void main().catch((err) => { console.error(err); process.exit(1); });
