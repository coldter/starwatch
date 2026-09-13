// search — CLI over the local eval index.
// usage: node src/search.ts "auth" --mode hybrid --lang ts --limit 10 [--json] [--no-boost]
import { runSearch, LabIndex, type Mode } from './engine.ts';

interface Args {
  query: string;
  mode: Mode;
  lang?: string;
  topics: string[];
  minStars?: number;
  maxStars?: number;
  limit: number;
  json: boolean;
  boost: boolean;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { query: '', mode: 'hybrid', topics: [], limit: 10, json: false, boost: true };
  const words: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--': break; // pnpm run passes the separator through
      case '--mode': a.mode = argv[++i] as Mode; break;
      case '--lang': a.lang = argv[++i]; break;
      case '--topic': a.topics.push(argv[++i]); break;
      case '--min-stars': a.minStars = Number(argv[++i]); break;
      case '--max-stars': a.maxStars = Number(argv[++i]); break;
      case '--limit': a.limit = Number(argv[++i]); break;
      case '--json': a.json = true; break;
      case '--no-boost': a.boost = false; break;
      default:
        if (arg.startsWith('--')) throw new Error(`unknown flag ${arg}`);
        words.push(arg);
    }
  }
  a.query = words.join(' ');
  if (!a.query) throw new Error('usage: search "query" [--mode ...] [--lang ...] [--limit N] [--json]');
  if (!['keyword', 'semantic', 'hybrid', 'hybrid+expand'].includes(a.mode)) throw new Error(`bad mode ${a.mode}`);
  return a;
}

function fmt(n: number, w = 6): string {
  return n.toFixed(w).padStart(w + 2);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const index = LabIndex.open();
  const out = await runSearch(index, {
    query: args.query,
    mode: args.mode,
    filters: { language: args.lang, topics: args.topics, minStars: args.minStars, maxStars: args.maxStars },
    limit: args.limit,
    boost: args.boost,
  });

  if (args.json) {
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  const f = out.filters;
  const filterStr = [
    f.language ? `lang=${f.language}` : '',
    f.topics?.length ? `topics=${f.topics.join('+')}` : '',
    f.minStars !== undefined ? `minStars=${f.minStars}` : '',
  ].filter(Boolean).join(' ');
  console.log(`query: "${out.query}"  mode=${out.mode}${filterStr ? '  ' + filterStr : ''}${args.boost ? '' : '  [no boosts]'}`);
  if (out.expansion.length) console.log(`expansion: ${out.expansion.join(', ')}`);
  if (out.keyword_fallback) console.log(`keyword fallback: ${out.keyword_fallback}`);
  console.log(`legs: keyword=${out.legs.keyword} semantic=${out.legs.semantic}${out.legs.filtered_universe !== null ? ` filtered_universe=${out.legs.filtered_universe}` : ''}  ·  total=${out.timing_ms.total.toFixed(1)} ms (kw ${out.timing_ms.keyword?.toFixed(1) ?? '-'} / embed ${out.timing_ms.embed?.toFixed(1) ?? '-'} / sem ${out.timing_ms.semantic?.toFixed(1) ?? '-'})`);
  console.log('');
  for (const h of out.hits) {
    const ranks = `lex:${h.lex_rank ?? '-'} sem:${h.sem_rank ?? '-'}`;
    const reason = h.reasons.length ? `  ${h.reasons.join(' ')}` : '';
    console.log(`#${String(h.rank).padStart(2)}  ${h.full_name.padEnd(42)} ${String(h.language ?? '-').padEnd(11)} ★${String(h.stars).padStart(6)}  ${fmt(h.score)}  ${ranks}${reason}`);
  }
  console.log('');
}

void main().catch((err) => { console.error(err); process.exit(1); });
