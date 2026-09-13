import type { Group, Repo, SearchFilters, UserIndexState, UserProfile } from "@starwatch/domain";
import type { ReadmeFetchState, ReadmeStateMap } from "@starwatch/core/sync";
import { Context, Effect, Layer, Schema } from "effect";
import type { SqlError } from "effect/unstable/sql/SqlError";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { Fragment } from "effect/unstable/sql/Statement";
import {
  boolToInt,
  chunk,
  GroupIdRow,
  GroupRepoRow,
  GroupRow,
  GroupSlugRow,
  IndexStateRow,
  intToBool,
  nowIso,
  parseTopicsJson,
  README_MAX_CHARS,
  ReadmeStateRow,
  ReadmeTextRow,
  RepoIdRow,
  RepoRow,
  RepoStatsRow,
  StarEtagRow,
  StarPageRow,
  UserRow,
  VectorBlobRow,
  type ReadmeState
} from "./sql.ts";

/** Aggregate counts for `user_index_state` (docs/08 status payload). */
export interface RepoStats {
  readonly starsTotal: number;
  readonly reposMetadata: number;
  readonly readmesFetched: number;
}

/** Pointer row for the per-user vector blob in R2 (docs/15 §2.6). */
export interface VectorBlobPointer {
  readonly dims: number;
  readonly bytesLen: number;
  readonly updatedAt: string;
}

/**
 * Repos per JSON1 bulk statement. 16 params/row × 50 rows stays far inside
 * D1's 100-param/statement and 100 KB/statement ceilings (docs/13 §1).
 */
export const REPO_BATCH_SIZE = 50;

/** Map the persisted README state onto the sync planner's fetch status. */
const toFetchStatus = (state: ReadmeState): ReadmeFetchState["status"] => {
  switch (state) {
    case "present":
      return "ok";
    case "missing":
      return "missing";
    case "too_big":
      return "ok";
    default:
      return "error";
  }
};

/** Columns written when a README is fetched or re-checked. */
export interface ReadmeUpdate {
  readonly text: string | null;
  readonly hash: string | null;
  readonly state: ReadmeState;
  readonly checkedAt: string | null;
}

/**
 * D1-backed repository for users, the shared repo corpus, per-user stars,
 * listing ETags and groups. Every method takes/returns `@starwatch/domain`
 * types and fails only with `SqlError`.
 *
 * No method uses transactions (D1 has none) and every write is an idempotent
 * `INSERT ... ON CONFLICT DO UPDATE`, so callers may retry a partial batch.
 */
export interface RepoStoreShape {
  readonly upsertUser: (profile: UserProfile) => Effect.Effect<void, SqlError>;
  readonly getUser: (login: string) => Effect.Effect<UserProfile | null, SqlError>;
  readonly upsertIndexState: (state: UserIndexState) => Effect.Effect<void, SqlError>;
  readonly getIndexState: (login: string) => Effect.Effect<UserIndexState | null, SqlError>;
  /**
   * Upsert repo metadata (never the README fields) and link each repo to
   * `login` in `user_stars`. Safe to re-run: `first_seen_at` is preserved on
   * conflict and an explicit `starredAt` wins over an existing value.
   */
  readonly upsertRepos: (login: string, repos: ReadonlyArray<Repo>) => Effect.Effect<void, SqlError>;
  /**
   * Bulk variant of {@link upsertRepos} for listing pages: writes `repos` and
   * `user_stars` with one JSON1 statement per ≤{@link REPO_BATCH_SIZE}-repo
   * chunk instead of two statements per repo. On the free tier D1 allows 50
   * queries per invocation, so a 100-repo page must cost O(1) statements, not
   * O(rows) (docs/13 §1, docs/14 §0.2).
   *
   * `page` (when given) attributes the rows to a listing page so an
   * ETag-aware re-list can diff fresh and 304 pages exactly (migration 0002).
   */
  readonly upsertRepoBatch: (
    login: string,
    repos: ReadonlyArray<Repo>,
    page?: number
  ) => Effect.Effect<void, SqlError>;
  readonly listRepoIds: (login: string) => Effect.Effect<ReadonlyArray<number>, SqlError>;
  /**
   * `(star_page, repo_id)` for every row of the user's star universe.
   * Unattributed rows (NULL page) are returned with `starPage: null`; callers
   * must keep them rather than treat them as unstarred.
   */
  readonly getStarPageRows: (
    login: string
  ) => Effect.Effect<ReadonlyArray<{ readonly starPage: number | null; readonly repoId: number }>, SqlError>;
  /** Drop the user↔repo links; shared `repos` rows survive for other users. */
  readonly markUnstarred: (login: string, repoIds: ReadonlyArray<number>) => Effect.Effect<void, SqlError>;
  readonly getRepos: (login: string, ids: ReadonlyArray<number>) => Effect.Effect<ReadonlyArray<Repo>, SqlError>;
  /**
   * Resolve a filter set to full repo rows in the user's star universe.
   *
   * Topics use **AND** semantics: a repo must carry every provided topic
   * (matched case-insensitively against `topics_json` via `json_each`).
   * Groups also use OR semantics across the listed slugs (docs/04 §5.2).
   *
   * Facet lists become bound parameters; the query parser keeps them small,
   * but combined topics+groups should stay under ~90 to respect D1's
   * 100-parameter-per-statement ceiling.
   */
  readonly listReposForSearch: (login: string, filters: SearchFilters) => Effect.Effect<ReadonlyArray<Repo>, SqlError>;
  readonly getRepoByFullName: (fullName: string) => Effect.Effect<Repo | null, SqlError>;
  readonly countStats: (login: string) => Effect.Effect<RepoStats, SqlError>;
  readonly starEtag: (login: string, page: number) => Effect.Effect<string | null, SqlError>;
  readonly putStarEtag: (login: string, page: number, etag: string) => Effect.Effect<void, SqlError>;
  /** Replace the login's groups and memberships in one pass (delete + insert). */
  readonly replaceGroups: (login: string, groups: ReadonlyArray<Group>) => Effect.Effect<void, SqlError>;
  readonly listGroups: (login: string) => Effect.Effect<ReadonlyArray<Group>, SqlError>;
  /** Map `repo_id` → group **slugs**, for `SearchHit.groups` (docs/05 §4.4). */
  readonly groupsForRepos: (
    login: string,
    repoIds: ReadonlyArray<number>
  ) => Effect.Effect<ReadonlyMap<number, ReadonlyArray<string>>, SqlError>;
  /** Write the README budget fields; `readme_text` is capped at 64 KB. */
  readonly putReadme: (repoId: number, update: ReadmeUpdate) => Effect.Effect<void, SqlError>;
  /**
   * README text for a set of the user's repos, for snippet hydration. Repos
   * with no stored text are absent from the map.
   */
  readonly getReadmeTexts: (
    login: string,
    ids: ReadonlyArray<number>
  ) => Effect.Effect<ReadonlyMap<number, string>, SqlError>;
  /**
   * README bookkeeping for every repo in the user's star universe, keyed by
   * repo id — the `ReadmeStateMap` `planReadmeWork` consumes (docs/09 §3.3).
   */
  readonly getReadmeStates: (login: string) => Effect.Effect<ReadmeStateMap, SqlError>;
  /** Upsert the pointer for `vectors/{login}.bin` (the blob store stays pure). */
  readonly putVectorBlob: (login: string, dims: number, bytesLen: number) => Effect.Effect<void, SqlError>;
  readonly getVectorBlob: (login: string) => Effect.Effect<VectorBlobPointer | null, SqlError>;
  readonly deleteVectorBlob: (login: string) => Effect.Effect<void, SqlError>;
}

const toUser = (row: UserRow): UserProfile => ({
  login: row.login,
  id: row.id,
  name: row.name,
  // GitHub always returns an avatar; degrade to "" rather than fail a read.
  avatarUrl: row.avatarUrl ?? "",
  bio: row.bio,
  company: row.company,
  location: row.location,
  followers: row.followers,
  publicRepos: row.publicRepos,
  createdAt: row.createdAtGh ?? ""
});

const toRepo = (row: RepoRow): Repo => ({
  id: row.id,
  fullName: row.fullName,
  owner: row.owner,
  name: row.name,
  description: row.description,
  language: row.language,
  topics: parseTopicsJson(row.topicsJson),
  stars: row.stars,
  forks: row.forks,
  archived: intToBool(row.archived),
  license: row.license,
  homepage: row.homepage,
  pushedAt: row.pushedAt,
  starredAt: row.starredAt,
  htmlUrl: row.htmlUrl
});

const toIndexState = (row: IndexStateRow): UserIndexState => ({
  login: row.login,
  phase: row.phase,
  starsTotal: row.starsTotal,
  reposMetadata: row.reposMetadata,
  readmesFetched: row.readmesFetched,
  semanticDocs: row.semanticDocs,
  lastSyncedAt: row.lastSyncedAt,
  lastError: row.lastError,
  updatedAt: row.updatedAt
});

export class RepoStore extends Context.Service<RepoStore, RepoStoreShape>()("RepoStore") {
  static readonly layer = Layer.effect(
    RepoStore,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      const upsertUser = Effect.fn("RepoStore.upsertUser")(function* (profile: UserProfile) {
        yield* sql`
          INSERT INTO users (
            login, id, name, avatar_url, bio, company, location,
            followers, public_repos, created_at_gh, fetched_at
          ) VALUES (
            ${profile.login}, ${profile.id}, ${profile.name}, ${profile.avatarUrl}, ${profile.bio},
            ${profile.company}, ${profile.location}, ${profile.followers}, ${profile.publicRepos},
            ${profile.createdAt}, ${nowIso()}
          )
          ON CONFLICT(login) DO UPDATE SET
            id = excluded.id,
            name = excluded.name,
            avatar_url = excluded.avatar_url,
            bio = excluded.bio,
            company = excluded.company,
            location = excluded.location,
            followers = excluded.followers,
            public_repos = excluded.public_repos,
            created_at_gh = excluded.created_at_gh,
            fetched_at = excluded.fetched_at
        `;
      });

      const getUser = Effect.fn("RepoStore.getUser")(function* (login: string) {
        const rows = yield* sql<UserRow>`SELECT * FROM users WHERE login = ${login} LIMIT 1`;
        const row = rows[0];
        return row === undefined ? null : toUser(Schema.decodeUnknownSync(UserRow)(row));
      });

      const upsertIndexState = Effect.fn("RepoStore.upsertIndexState")(function* (state: UserIndexState) {
        yield* sql`
          INSERT INTO user_index_state (
            login, phase, stars_total, repos_metadata, readmes_fetched,
            semantic_docs, last_synced_at, last_error, updated_at
          ) VALUES (
            ${state.login}, ${state.phase}, ${state.starsTotal}, ${state.reposMetadata},
            ${state.readmesFetched}, ${state.semanticDocs}, ${state.lastSyncedAt},
            ${state.lastError}, ${state.updatedAt}
          )
          ON CONFLICT(login) DO UPDATE SET
            phase = excluded.phase,
            stars_total = excluded.stars_total,
            repos_metadata = excluded.repos_metadata,
            readmes_fetched = excluded.readmes_fetched,
            semantic_docs = excluded.semantic_docs,
            last_synced_at = excluded.last_synced_at,
            last_error = excluded.last_error,
            updated_at = excluded.updated_at
        `;
      });

      const getIndexState = Effect.fn("RepoStore.getIndexState")(function* (login: string) {
        const rows = yield* sql<IndexStateRow>`SELECT * FROM user_index_state WHERE login = ${login} LIMIT 1`;
        const row = rows[0];
        return row === undefined ? null : toIndexState(Schema.decodeUnknownSync(IndexStateRow)(row));
      });

      const upsertRepos = Effect.fn("RepoStore.upsertRepos")(function* (
        login: string,
        repos: ReadonlyArray<Repo>
      ) {
        for (const repo of repos) {
          const now = nowIso();
          yield* sql`
            INSERT INTO repos (
              id, full_name, owner, name, description, language, topics_json,
              stars, forks, archived, license, homepage, pushed_at, html_url,
              first_seen_at, updated_at
            ) VALUES (
              ${repo.id}, ${repo.fullName}, ${repo.owner}, ${repo.name}, ${repo.description},
              ${repo.language}, ${JSON.stringify(repo.topics)}, ${repo.stars}, ${repo.forks},
              ${boolToInt(repo.archived)}, ${repo.license}, ${repo.homepage}, ${repo.pushedAt},
              ${repo.htmlUrl}, ${now}, ${now}
            )
            ON CONFLICT(id) DO UPDATE SET
              full_name = excluded.full_name,
              owner = excluded.owner,
              name = excluded.name,
              description = excluded.description,
              language = excluded.language,
              topics_json = excluded.topics_json,
              stars = excluded.stars,
              forks = excluded.forks,
              archived = excluded.archived,
              license = excluded.license,
              homepage = excluded.homepage,
              pushed_at = excluded.pushed_at,
              html_url = excluded.html_url,
              updated_at = excluded.updated_at
          `;
          yield* sql`
            INSERT INTO user_stars (login, repo_id, starred_at)
            VALUES (${login}, ${repo.id}, ${repo.starredAt})
            ON CONFLICT(login, repo_id) DO UPDATE SET
              starred_at = COALESCE(excluded.starred_at, user_stars.starred_at)
          `;
        }
      });

      const upsertRepoBatch = Effect.fn("RepoStore.upsertRepoBatch")(function* (
        login: string,
        repos: ReadonlyArray<Repo>,
        page?: number
      ) {
        if (repos.length === 0) return;
        const now = nowIso();
        for (const batch of chunk(repos, REPO_BATCH_SIZE)) {
          // `topics` is pre-serialized so the JSON payload stays a flat
          // string, and `archived` is JSON true/false -> SQLite 1/0.
          const repoJson = JSON.stringify(
            batch.map((repo) => ({
              id: repo.id,
              fullName: repo.fullName,
              owner: repo.owner,
              name: repo.name,
              description: repo.description,
              language: repo.language,
              topicsJson: JSON.stringify(repo.topics),
              stars: repo.stars,
              forks: repo.forks,
              archived: repo.archived,
              license: repo.license,
              homepage: repo.homepage,
              pushedAt: repo.pushedAt,
              htmlUrl: repo.htmlUrl
            }))
          );
          // `WHERE true` disambiguates SQLite's INSERT…SELECT…ON CONFLICT parse.
          yield* sql`
            INSERT INTO repos (
              id, full_name, owner, name, description, language, topics_json,
              stars, forks, archived, license, homepage, pushed_at, html_url,
              first_seen_at, updated_at
            )
            SELECT
              json_extract(value, '$.id'),
              json_extract(value, '$.fullName'),
              json_extract(value, '$.owner'),
              json_extract(value, '$.name'),
              json_extract(value, '$.description'),
              json_extract(value, '$.language'),
              json_extract(value, '$.topicsJson'),
              json_extract(value, '$.stars'),
              json_extract(value, '$.forks'),
              json_extract(value, '$.archived'),
              json_extract(value, '$.license'),
              json_extract(value, '$.homepage'),
              json_extract(value, '$.pushedAt'),
              json_extract(value, '$.htmlUrl'),
              ${now}, ${now}
            FROM json_each(${repoJson})
            WHERE true
            ON CONFLICT(id) DO UPDATE SET
              full_name = excluded.full_name,
              owner = excluded.owner,
              name = excluded.name,
              description = excluded.description,
              language = excluded.language,
              topics_json = excluded.topics_json,
              stars = excluded.stars,
              forks = excluded.forks,
              archived = excluded.archived,
              license = excluded.license,
              homepage = excluded.homepage,
              pushed_at = excluded.pushed_at,
              html_url = excluded.html_url,
              updated_at = excluded.updated_at
          `;
          const starJson = JSON.stringify(
            batch.map((repo) => ({
              repoId: repo.id,
              starredAt: repo.starredAt,
              page: page ?? null
            }))
          );
          yield* sql`
            INSERT INTO user_stars (login, repo_id, starred_at, star_page)
            SELECT
              ${login},
              json_extract(value, '$.repoId'),
              json_extract(value, '$.starredAt'),
              json_extract(value, '$.page')
            FROM json_each(${starJson})
            WHERE true
            ON CONFLICT(login, repo_id) DO UPDATE SET
              starred_at = COALESCE(excluded.starred_at, user_stars.starred_at),
              star_page = COALESCE(excluded.star_page, user_stars.star_page)
          `;
        }
      });

      const listRepoIds = Effect.fn("RepoStore.listRepoIds")(function* (login: string) {
        const rows = yield* sql<RepoIdRow>`
          SELECT repo_id FROM user_stars WHERE login = ${login} ORDER BY repo_id
        `;
        return rows.map((row) => Schema.decodeUnknownSync(RepoIdRow)(row).repoId);
      });

      const getStarPageRows = Effect.fn("RepoStore.getStarPageRows")(function* (login: string) {
        const rows = yield* sql<StarPageRow>`
          SELECT star_page, repo_id FROM user_stars WHERE login = ${login} ORDER BY repo_id
        `;
        return rows.map((row) => {
          const decoded = Schema.decodeUnknownSync(StarPageRow)(row);
          return { starPage: decoded.starPage, repoId: decoded.repoId };
        });
      });

      const markUnstarred = Effect.fn("RepoStore.markUnstarred")(function* (
        login: string,
        repoIds: ReadonlyArray<number>
      ) {
        for (const ids of chunk(repoIds, 90)) {
          yield* sql`DELETE FROM user_stars WHERE login = ${login} AND repo_id IN ${sql.in(ids)}`;
        }
      });

      const getRepos = Effect.fn("RepoStore.getRepos")(function* (
        login: string,
        ids: ReadonlyArray<number>
      ) {
        const repos: Array<Repo> = [];
        for (const idsChunk of chunk(ids, 90)) {
          const rows = yield* sql<RepoRow>`
            SELECT r.*, s.starred_at
            FROM repos r
            JOIN user_stars s ON s.repo_id = r.id AND s.login = ${login}
            WHERE r.id IN ${sql.in(idsChunk)}
            ORDER BY r.id
          `;
          for (const row of rows) {
            repos.push(toRepo(Schema.decodeUnknownSync(RepoRow)(row)));
          }
        }
        return repos;
      });

      const listReposForSearch = Effect.fn("RepoStore.listReposForSearch")(function* (
        login: string,
        filters: SearchFilters
      ) {
        const conditions: Array<Fragment> = [];
        if (filters.language !== undefined) {
          // Case-insensitive: GitHub returns "TypeScript", users type "typescript".
          conditions.push(sql`LOWER(r.language) = LOWER(${filters.language})`);
        }
        if (filters.minStars !== undefined) {
          conditions.push(sql`r.stars >= ${filters.minStars}`);
        }
        if (filters.maxStars !== undefined) {
          conditions.push(sql`r.stars <= ${filters.maxStars}`);
        }
        if (filters.archived !== undefined) {
          conditions.push(sql`r.archived = ${boolToInt(filters.archived)}`);
        }
        if (filters.license !== undefined) {
          // SPDX ids are stored uppercase ("MIT"); accept any input casing.
          conditions.push(sql`LOWER(COALESCE(r.license, '')) = LOWER(${filters.license})`);
        }
        if (filters.starredAfter !== undefined) {
          conditions.push(sql`s.starred_at >= ${filters.starredAfter}`);
        }
        if (filters.starredBefore !== undefined) {
          conditions.push(sql`s.starred_at <= ${filters.starredBefore}`);
        }
        // Topic filter: every provided topic must be present (AND), compared
        // case-insensitively because GitHub topics are lowercase by convention
        // but user input need not be.
        for (const topic of filters.topics ?? []) {
          conditions.push(
            sql`EXISTS (SELECT 1 FROM json_each(r.topics_json) AS t WHERE lower(t.value) = lower(${topic}))`
          );
        }
        // Groups are OR by default (docs/04 §5.2).
        const groupSlugs = filters.groups ?? [];
        if (groupSlugs.length > 0) {
          conditions.push(
            sql`EXISTS (
              SELECT 1 FROM group_repos gr
              JOIN groups g ON g.id = gr.group_id
              WHERE gr.repo_id = r.id AND g.login = ${login} AND g.slug IN ${sql.in(groupSlugs)}
            )`
          );
        }
        const where = sql.and(conditions);
        const rows = yield* sql<RepoRow>`
          SELECT r.*, s.starred_at
          FROM repos r
          JOIN user_stars s ON s.repo_id = r.id
          WHERE s.login = ${login} AND ${where}
          ORDER BY s.starred_at DESC, r.id DESC
        `;
        return rows.map((row) => toRepo(Schema.decodeUnknownSync(RepoRow)(row)));
      });

      const getRepoByFullName = Effect.fn("RepoStore.getRepoByFullName")(function* (fullName: string) {
        const rows = yield* sql<RepoRow>`
          SELECT r.*, NULL AS starred_at FROM repos r WHERE r.full_name = ${fullName} LIMIT 1
        `;
        const row = rows[0];
        return row === undefined ? null : toRepo(Schema.decodeUnknownSync(RepoRow)(row));
      });

      const countStats = Effect.fn("RepoStore.countStats")(function* (login: string) {
        const rows = yield* sql<RepoStats>`
          SELECT
            (SELECT COUNT(*) FROM user_stars WHERE login = ${login}) AS stars_total,
            (SELECT COUNT(*) FROM repos r JOIN user_stars s ON s.repo_id = r.id WHERE s.login = ${login})
              AS repos_metadata,
            (SELECT COUNT(*) FROM repos r JOIN user_stars s ON s.repo_id = r.id
              WHERE s.login = ${login} AND r.readme_state = 'present') AS readmes_fetched
        `;
        const row = rows[0];
        if (row === undefined) {
          return { starsTotal: 0, reposMetadata: 0, readmesFetched: 0 };
        }
        return Schema.decodeUnknownSync(RepoStatsRow)(row);
      });

      const starEtag = Effect.fn("RepoStore.starEtag")(function* (login: string, page: number) {
        const rows = yield* sql<StarEtagRow>`
          SELECT etag FROM star_etags WHERE login = ${login} AND page = ${page} LIMIT 1
        `;
        const row = rows[0];
        return row === undefined ? null : Schema.decodeUnknownSync(StarEtagRow)(row).etag;
      });

      const putStarEtag = Effect.fn("RepoStore.putStarEtag")(function* (
        login: string,
        page: number,
        etag: string
      ) {
        yield* sql`
          INSERT INTO star_etags (login, page, etag, fetched_at)
          VALUES (${login}, ${page}, ${etag}, ${nowIso()})
          ON CONFLICT(login, page) DO UPDATE SET
            etag = excluded.etag,
            fetched_at = excluded.fetched_at
        `;
      });

      const replaceGroups = Effect.fn("RepoStore.replaceGroups")(function* (
        login: string,
        groups: ReadonlyArray<Group>
      ) {
        const now = nowIso();
        const existing = yield* sql<GroupIdRow>`SELECT id FROM groups WHERE login = ${login}`;
        const existingIds = existing.map((row) => Schema.decodeUnknownSync(GroupIdRow)(row).id);
        for (const ids of chunk(existingIds, 90)) {
          yield* sql`DELETE FROM group_repos WHERE group_id IN ${sql.in(ids)}`;
        }
        yield* sql`DELETE FROM groups WHERE login = ${login}`;
        for (const group of groups) {
          yield* sql`
            INSERT INTO groups (id, login, name, slug, position, updated_at)
            VALUES (${group.id}, ${login}, ${group.name}, ${group.slug}, ${group.position}, ${now})
            ON CONFLICT(id) DO UPDATE SET
              login = excluded.login,
              name = excluded.name,
              slug = excluded.slug,
              position = excluded.position,
              updated_at = excluded.updated_at
          `;
          const repoIds = [...new Set(group.repoIds)];
          if (repoIds.length > 0) {
            // One bound parameter for the whole membership list via JSON1.
            yield* sql`
              INSERT INTO group_repos (group_id, repo_id)
              SELECT ${group.id}, value FROM json_each(${JSON.stringify(repoIds)})
            `;
          }
        }
      });

      const listGroups = Effect.fn("RepoStore.listGroups")(function* (login: string) {
        const groupRows = yield* sql<GroupRow>`
          SELECT * FROM groups WHERE login = ${login} ORDER BY position ASC, slug ASC
        `;
        const groupRepos = yield* sql<GroupRepoRow>`
          SELECT gr.group_id, gr.repo_id
          FROM group_repos gr
          JOIN groups g ON g.id = gr.group_id
          WHERE g.login = ${login}
          ORDER BY gr.repo_id
        `;
        const memberships = new Map<string, Array<number>>();
        for (const row of groupRepos) {
          const decoded = Schema.decodeUnknownSync(GroupRepoRow)(row);
          const list = memberships.get(decoded.groupId);
          if (list === undefined) {
            memberships.set(decoded.groupId, [decoded.repoId]);
          } else {
            list.push(decoded.repoId);
          }
        }
        return groupRows.map((row) => {
          const group = Schema.decodeUnknownSync(GroupRow)(row);
          return {
            id: group.id,
            name: group.name,
            slug: group.slug,
            position: group.position,
            repoIds: memberships.get(group.id) ?? []
          };
        });
      });

      const groupsForRepos = Effect.fn("RepoStore.groupsForRepos")(function* (
        login: string,
        repoIds: ReadonlyArray<number>
      ) {
        const byRepo = new Map<number, Array<string>>();
        for (const ids of chunk(repoIds, 90)) {
          const rows = yield* sql<GroupSlugRow>`
            SELECT gr.repo_id, g.slug
            FROM group_repos gr
            JOIN groups g ON g.id = gr.group_id
            WHERE g.login = ${login} AND gr.repo_id IN ${sql.in(ids)}
            ORDER BY g.slug
          `;
          for (const row of rows) {
            const decoded = Schema.decodeUnknownSync(GroupSlugRow)(row);
            const list = byRepo.get(decoded.repoId);
            if (list === undefined) {
              byRepo.set(decoded.repoId, [decoded.slug]);
            } else {
              list.push(decoded.slug);
            }
          }
        }
        return byRepo;
      });

      const putReadme = Effect.fn("RepoStore.putReadme")(function* (repoId: number, update: ReadmeUpdate) {
        const text =
          update.text === null
            ? null
            : update.text.length > README_MAX_CHARS
              ? update.text.slice(0, README_MAX_CHARS)
              : update.text;
        yield* sql`
          UPDATE repos SET
            readme_text = ${text},
            readme_hash = ${update.hash},
            readme_state = ${update.state},
            readme_checked_at = ${update.checkedAt},
            updated_at = ${nowIso()}
          WHERE id = ${repoId}
        `;
      });

      const getReadmeTexts = Effect.fn("RepoStore.getReadmeTexts")(function* (
        login: string,
        ids: ReadonlyArray<number>
      ) {
        const out = new Map<number, string>();
        for (const idsChunk of chunk(ids, 90)) {
          const rows = yield* sql<ReadmeTextRow>`
            SELECT r.id AS repo_id, r.readme_text
            FROM repos r
            JOIN user_stars s ON s.repo_id = r.id AND s.login = ${login}
            WHERE r.id IN ${sql.in(idsChunk)} AND r.readme_text IS NOT NULL
          `;
          for (const row of rows) {
            const decoded = Schema.decodeUnknownSync(ReadmeTextRow)(row);
            if (decoded.readmeText !== null) out.set(decoded.repoId, decoded.readmeText);
          }
        }
        return out;
      });

      const getReadmeStates = Effect.fn("RepoStore.getReadmeStates")(function* (login: string) {
        const rows = yield* sql<ReadmeStateRow>`
          SELECT r.id AS repo_id, r.pushed_at, r.readme_state
          FROM repos r
          JOIN user_stars s ON s.repo_id = r.id
          WHERE s.login = ${login}
        `;
        const out = new Map<number, ReadmeFetchState>();
        for (const row of rows) {
          const decoded = Schema.decodeUnknownSync(ReadmeStateRow)(row);
          out.set(decoded.repoId, {
            repoId: decoded.repoId,
            pushedAt: decoded.pushedAt,
            status: toFetchStatus(decoded.readmeState as ReadmeState)
          });
        }
        return out;
      });

      const putVectorBlob = Effect.fn("RepoStore.putVectorBlob")(function* (
        login: string,
        dims: number,
        bytesLen: number
      ) {
        yield* sql`
          INSERT INTO vector_blobs (login, dims, bytes_len, updated_at)
          VALUES (${login}, ${dims}, ${bytesLen}, ${nowIso()})
          ON CONFLICT(login) DO UPDATE SET
            dims = excluded.dims,
            bytes_len = excluded.bytes_len,
            updated_at = excluded.updated_at
        `;
      });

      const getVectorBlob = Effect.fn("RepoStore.getVectorBlob")(function* (login: string) {
        const rows = yield* sql<VectorBlobRow>`SELECT * FROM vector_blobs WHERE login = ${login} LIMIT 1`;
        const row = rows[0];
        if (row === undefined) return null;
        const decoded = Schema.decodeUnknownSync(VectorBlobRow)(row);
        return { dims: decoded.dims, bytesLen: decoded.bytesLen, updatedAt: decoded.updatedAt };
      });

      const deleteVectorBlob = Effect.fn("RepoStore.deleteVectorBlob")(function* (login: string) {
        yield* sql`DELETE FROM vector_blobs WHERE login = ${login}`;
      });

      return RepoStore.of({
        upsertUser,
        getUser,
        upsertIndexState,
        getIndexState,
        upsertRepos,
        upsertRepoBatch,
        listRepoIds,
        getStarPageRows,
        markUnstarred,
        getRepos,
        listReposForSearch,
        getRepoByFullName,
        countStats,
        starEtag,
        putStarEtag,
        replaceGroups,
        listGroups,
        groupsForRepos,
        putReadme,
        getReadmeTexts,
        getReadmeStates,
        putVectorBlob,
        getVectorBlob,
        deleteVectorBlob
      });
    })
  );
}
