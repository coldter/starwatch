// fetch-readmes — download READMEs from raw.githubusercontent.com for every starred repo.
// Fallback: `gh api repos/{owner}/{repo}/readme -H 'Accept: application/vnd.github.raw'`.
// Cache: eval-lab/data/readmes/{owner}__{repo}.md  (a miss marker is recorded in readmes-misses.json)
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { DATA_DIR, README_DIR, readmeFile, readStars, type Star } from './lib.ts';

const execFileP = promisify(execFile);

const CONCURRENCY = 10;
const RUNTIME_CAP_MS = 15 * 60 * 1000;
const CANDIDATES = ['README.md', 'readme.md', 'README.rst', '.github/README.md'];
const UA = 'starwatch-eval-lab (local research; contact: coldter)';

interface MissRecord {
  full_name: string;
  reason: string;
}

const started = Date.now();

async function tryRaw(fullName: string, file: string): Promise<string | null> {
  const url = `https://raw.githubusercontent.com/${fullName}/HEAD/${file}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15_000), redirect: 'follow' });
      if (res.status === 200) return await res.text();
      if (res.status === 404) return null;
      if (res.status === 429 || res.status >= 500) {
        await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
        continue;
      }
      return null;
    } catch (err) {
      if (attempt === 1) return null;
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  return null;
}

async function tryGhApi(fullName: string): Promise<string | null> {
  try {
    const { stdout } = await execFileP(
      'gh',
      ['api', `repos/${fullName}/readme`, '-H', 'Accept: application/vnd.github.raw'],
      { maxBuffer: 16 * 1024 * 1024, timeout: 30_000 },
    );
    return stdout.length > 0 ? stdout : null;
  } catch {
    return null;
  }
}

async function fetchOne(repo: Star): Promise<{ hit: boolean; source?: string; reason?: string }> {
  const target = readmeFile(repo.full_name);
  if (existsSync(target)) return { hit: true, source: 'cache' };
  for (const file of CANDIDATES) {
    const text = await tryRaw(repo.full_name, file);
    if (text !== null) {
      mkdirSync(README_DIR, { recursive: true });
      writeFileSync(target, text);
      return { hit: true, source: `raw:${file}` };
    }
  }
  const viaApi = await tryGhApi(repo.full_name);
  if (viaApi !== null) {
    writeFileSync(target, viaApi);
    return { hit: true, source: 'gh-api' };
  }
  return { hit: false, reason: 'no README on raw or gh api' };
}

async function main(): Promise<void> {
  const stars = readStars();
  const misses: MissRecord[] = [];
  let done = 0;
  let found = 0;
  const total = stars.length;
  let capped = false;

  console.log(`fetch-readmes: ${total} repos, concurrency ${CONCURRENCY}, cap ${RUNTIME_CAP_MS / 60_000} min`);

  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < total) {
      if (Date.now() - started > RUNTIME_CAP_MS) { capped = true; return; }
      const repo = stars[cursor++];
      const res = await fetchOne(repo);
      done++;
      if (res.hit) found++;
      else misses.push({ full_name: repo.full_name, reason: res.reason ?? 'unknown' });
      if (done % 100 === 0 || done === total) {
        const rate = done / ((Date.now() - started) / 1000);
        console.log(`  ${done}/${total} found=${found} miss=${misses.length} ${rate.toFixed(1)} repos/s`);
      }
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  writeFileSync(path.join(DATA_DIR, 'readmes-misses.json'), JSON.stringify(misses, null, 2) + '\n');
  console.log(`fetch-readmes done: done=${done}/${total} found=${found} miss=${misses.length}${capped ? ' (RUNTIME CAPPED)' : ''} in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  if (misses.length > 0) {
    console.log(`misses written to data/readmes-misses.json (first 10: ${misses.slice(0, 10).map((m) => m.full_name).join(', ')})`);
  }
}

void main();
