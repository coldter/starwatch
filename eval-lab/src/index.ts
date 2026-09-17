// index — build eval-lab/data/starwatch-eval.db: repos + FTS5 (porter & trigram) + repo embeddings.
import { existsSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  buildDoc,
  DATA_DIR,
  DB_PATH,
  EMBED_DIMS,
  embedTexts,
  MODEL_ID,
  readReadme,
  readStars,
  stripMarkdown,
  type Star,
} from "./lib.ts";

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);

  return s[Math.floor(s.length / 2)];
}

async function main(): Promise<void> {
  const noEmbed = process.argv.includes("--no-embed");
  const t0 = Date.now();
  const stars = readStars();
  const readmes = new Map<string, string | null>();
  const missing: string[] = [];

  for (const s of stars) {
    const r = readReadme(s.full_name);
    readmes.set(s.full_name, r);

    if (r === null) missing.push(s.full_name);
  }

  const readmeLens: number[] = [];

  for (const readme of readmes.values()) {
    if (readme !== null) readmeLens.push(readme.length);
  }

  console.log(
    `index: ${stars.length} repos, readmes found=${readmeLens.length} missing=${missing.length} median=${median(readmeLens)} bytes max=${Math.max(...readmeLens, 0)}`,
  );

  if (existsSync(DB_PATH)) {
    for (const suf of ["", "-wal", "-shm"])
      if (existsSync(DB_PATH + suf)) unlinkSync(DB_PATH + suf);
  }

  const db = new DatabaseSync(DB_PATH);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec(`
    CREATE TABLE repos (
      id INTEGER PRIMARY KEY,
      full_name TEXT NOT NULL UNIQUE,
      description TEXT,
      language TEXT,
      topics_json TEXT NOT NULL,
      stars INTEGER NOT NULL,
      url TEXT NOT NULL,
      pushed_at TEXT NOT NULL,
      archived INTEGER NOT NULL,
      fork INTEGER NOT NULL,
      starred_at TEXT NOT NULL,
      readme_len INTEGER NOT NULL
    );
    CREATE VIRTUAL TABLE repos_fts USING fts5(name, description, topics, readme, tokenize = 'porter unicode61');
    CREATE VIRTUAL TABLE repos_tri USING fts5(name, description, topics, readme, tokenize = 'trigram');
    CREATE TABLE embeddings (repo_id INTEGER PRIMARY KEY, dims INTEGER NOT NULL, vector BLOB NOT NULL, doc TEXT NOT NULL);
  `);

  const insRepo = db.prepare(`INSERT INTO repos
    (id, full_name, description, language, topics_json, stars, url, pushed_at, archived, fork, starred_at, readme_len)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);

  const insFts = db.prepare(
    "INSERT INTO repos_fts(rowid, name, description, topics, readme) VALUES (?,?,?,?,?)",
  );

  const insTri = db.prepare(
    "INSERT INTO repos_tri(rowid, name, description, topics, readme) VALUES (?,?,?,?,?)",
  );

  const docs = new Map<number, string>();
  db.exec("BEGIN");
  stars.forEach((s: Star, i) => {
    const id = i + 1;
    const readme = readmes.get(s.full_name) ?? null;
    const stripped = readme ? stripMarkdown(readme) : "";
    const name = `${s.full_name} ${s.full_name.split("/")[1]}`;
    insRepo.run(
      id,
      s.full_name,
      s.description ?? null,
      s.language ?? null,
      JSON.stringify(s.topics ?? []),
      s.stargazers_count ?? 0,
      s.url,
      s.pushed_at ?? "",
      s.archived ? 1 : 0,
      s.fork ? 1 : 0,
      s.starred_at ?? "",
      stripped.length,
    );
    insFts.run(id, name, s.description ?? "", (s.topics ?? []).join(" "), stripped);
    insTri.run(id, name, s.description ?? "", (s.topics ?? []).join(" "), stripped);
    docs.set(id, buildDoc(s, readme));
  });
  db.exec("COMMIT");
  console.log(`index: repos+FTS inserted in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  const tEmbed = Date.now();

  if (!noEmbed) {
    const ids = [...docs.keys()];
    // Batch similar lengths together: ONNX pads to the longest sequence, and a few long
    // READMEs in every batch otherwise dominate the cost (5 docs/s → 30+ docs/s).
    ids.sort((a, b) => docs.get(a)!.length - docs.get(b)!.length);
    const texts = ids.map((id) => docs.get(id)!);

    const insEmb = db.prepare(
      "INSERT INTO embeddings(repo_id, dims, vector, doc) VALUES (?,?,?,?)",
    );

    const BATCH = 256; // embedding calls are 32-wide; commit every 256 to bound WAL growth
    let embedded = 0;

    for (let i = 0; i < texts.length; i += BATCH) {
      const sliceIds = ids.slice(i, i + BATCH);
      const sliceTexts = texts.slice(i, i + BATCH);
      const vectors = await embedTexts(sliceTexts);
      db.exec("BEGIN");
      vectors.forEach((v, j) => {
        insEmb.run(
          sliceIds[j],
          EMBED_DIMS,
          new Uint8Array(v.buffer, v.byteOffset, v.byteLength),
          sliceTexts[j],
        );
      });
      db.exec("COMMIT");
      embedded += vectors.length;

      if (embedded % 512 === 0 || embedded === texts.length) {
        const rate = embedded / ((Date.now() - tEmbed) / 1000);
        console.log(`  embedded ${embedded}/${texts.length} (${rate.toFixed(0)} docs/s)`);
      }
    }
  }

  const embedMs = Date.now() - tEmbed;

  const dbBytes = statSync(DB_PATH).size;

  const stats = {
    built_at: new Date().toISOString(),
    model: noEmbed ? null : MODEL_ID,
    dims: noEmbed ? null : EMBED_DIMS,
    repos: stars.length,
    with_language: stars.filter((s) => s.language).length,
    readmes_found: readmeLens.length,
    readmes_missing: missing.length,
    readme_bytes_median: median(readmeLens),
    readme_bytes_p90: readmeLens.length
      ? [...readmeLens].sort((a, b) => a - b)[Math.floor(readmeLens.length * 0.9)]
      : 0,
    doc_chars_total: [...docs.values()].reduce((a, d) => a + d.length, 0),
    doc_chars_mean: Math.round(
      [...docs.values()].reduce((a, d) => a + d.length, 0) / Math.max(docs.size, 1),
    ),
    readme_missing: missing.slice(0, 50),
    embed_ms: embedMs,
    db_bytes: dbBytes,
    build_ms: Date.now() - t0,
  };

  writeFileSync(path.join(DATA_DIR, "index-stats.json"), JSON.stringify(stats, null, 2) + "\n");
  console.log(
    `index: done in ${((Date.now() - t0) / 1000).toFixed(1)}s; db=${(dbBytes / 1024 / 1024).toFixed(1)} MB; embeddings in ${(embedMs / 1000).toFixed(1)}s`,
  );
  console.log(`index: stats → data/index-stats.json`);
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
