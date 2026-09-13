// fetch-stars — pull every repo coldter has starred into eval-lab/data/stars.json.
// Uses `gh api --paginate` (read-only; requires an authenticated gh).
import { execFile } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { DATA_DIR } from './lib.ts';

const execFileP = promisify(execFile);

const JQ = `.[] | {full_name: .repo.full_name, description: .repo.description, language: .repo.language, topics: .repo.topics, stargazers_count: .repo.stargazers_count, url: .repo.html_url, pushed_at: .repo.pushed_at, archived: .repo.archived, fork: .repo.fork, starred_at: .starred_at}`;

async function main(): Promise<void> {
  // One request per page body, `--jq` flattening; the star+json accept header adds starred_at.
  const args = [
    'api', '--paginate',
    '-H', 'Accept: application/vnd.github.star+json',
    '/user/starred?per_page=100',
    '--jq', JQ,
  ];
  const { stdout } = await execFileP('gh', args, { maxBuffer: 64 * 1024 * 1024, timeout: 10 * 60_000 });
  const lines = stdout.split('\n').filter((l) => l.trim().length > 0);
  const stars = lines.map((l) => JSON.parse(l));
  writeFileSync(path.join(DATA_DIR, 'stars.json'), JSON.stringify(stars, null, 2) + '\n');
  const withLang = stars.filter((s: { language: string | null }) => s.language).length;
  console.log(`fetch-stars: wrote ${stars.length} repos to data/stars.json (${withLang} with a language)`);
}

void main();
