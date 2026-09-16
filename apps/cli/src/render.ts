/**
 * Pure output formatters. Every function takes plain data and returns a string
 * (or scalar) — no I/O, no `process`, so the whole module is unit-testable.
 *
 * Human output contract (`docs/05-cli.md` §4, adapted to the public service):
 *   owner/name  ★12.3k  TypeScript  [group-a, group-b]
 *     dimmed snippet (≤ 120 cols)
 */
import type {
  Group,
  MatchSource,
  Repo,
  SearchHit,
  SearchResponse,
  SyncPhase,
  UserIndexState,
  UserProfile
} from "@starwatch/domain";

export interface TerminalTarget {
  readonly isTTY?: boolean | undefined;
}

export interface ColorEnv {
  readonly NO_COLOR?: string | undefined;
}

/** Any `NO_COLOR` value (including empty) disables ANSI; color also needs a TTY. */
export const shouldUseColor = (target: TerminalTarget, env: ColorEnv): boolean =>
  target.isTTY === true && env.NO_COLOR === undefined;

/** `$COLUMNS` fallback when the stream has no `columns`; capped at 120, floor 40. */
export const resolveWidth = (columns: number | undefined, envColumns: string | undefined): number => {
  const fromEnv = envColumns === undefined ? Number.NaN : Number.parseInt(envColumns, 10);
  const candidate = columns ?? (Number.isFinite(fromEnv) ? fromEnv : undefined);

  if (candidate === undefined || !Number.isFinite(candidate)) return 80;

  return Math.min(120, Math.max(40, Math.trunc(candidate)));
};

const RESET_INTENSITY = "\u001b[22m";

export const bold = (text: string, color: boolean): string =>
  color ? `\u001b[1m${text}${RESET_INTENSITY}` : text;

export const dim = (text: string, color: boolean): string =>
  color ? `\u001b[2m${text}${RESET_INTENSITY}` : text;

/** `12345` → `12.3k`, `950` → `950`, `1_000_000` → `1M`. */
export const formatStars = (stars: number): string => {
  const trimZero = (value: string): string =>
    value.endsWith(".0") ? value.slice(0, -2) : value;

  const absolute = Math.abs(stars);

  if (absolute >= 1_000_000) return `${trimZero((stars / 1_000_000).toFixed(1))}M`;

  if (absolute >= 1_000) return `${trimZero((stars / 1_000).toFixed(1))}k`;

  return String(stars);
};

/** `3277` → `3,277` (manual grouping so output never depends on ICU data). */
export const formatCount = (value: number): string =>
  String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

/** Collapses newlines/tabs so snippet text stays on one terminal line. */
export const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();

/** Truncates to `max` columns using a single `…` when needed. */
export const truncate = (text: string, max: number): string => {
  if (max <= 0) return "";

  if (text.length <= max) return text;

  if (max === 1) return "…";

  return `${text.slice(0, max - 1)}…`;
};

/** ISO timestamps render as their UTC date (`2026-09-13T03:00:00Z` → `2026-09-13`). */
export const formatDate = (value: string | null | undefined): string | undefined => {
  if (value === null || value === undefined || value === "") return undefined;

  return /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : value;
};

const LEG_LABELS: Readonly<Record<MatchSource, string>> = {
  keyword: "kw",
  expanded: "exp",
  semantic: "sem",
  name: "name"
};

const LEG_ORDER: ReadonlyArray<MatchSource> = ["keyword", "expanded", "semantic", "name"];

/**
 * `--explain` line. The public `SearchResponse` contract exposes `matchedBy`
 * but no per-leg ranks, so we show which legs matched plus the fused score.
 */
export const formatExplain = (matchedBy: ReadonlyArray<MatchSource>, score: number): string => {
  const present = new Set(matchedBy);
  const legs = LEG_ORDER.map((leg) => `${LEG_LABELS[leg]}:${present.has(leg) ? "+" : "-"}`).join(" ");

  return `${legs} · score ${score.toFixed(4)}`;
};

export interface RenderSearchOptions {
  readonly color: boolean;
  readonly width: number;
  readonly explain?: boolean | undefined;
}

export const renderSearchHit = (hit: SearchHit, options: RenderSearchOptions): string => {
  const header = [hit.repo.fullName, `★${formatStars(hit.repo.stars)}`];

  if (hit.repo.language !== null && hit.repo.language !== "") header.push(hit.repo.language);

  if (hit.groups.length > 0) header.push(`[${hit.groups.join(", ")}]`);
  const lines = [bold(header.join("  "), options.color)];
  const snippet = oneLine(hit.snippet);

  if (snippet !== "") {
    lines.push(`  ${dim(truncate(snippet, Math.max(20, options.width - 2)), options.color)}`);
  }

  if (options.explain === true) {
    lines.push(`  ${dim(formatExplain(hit.matchedBy, hit.score), options.color)}`);
  }

  return lines.join("\n");
};

/** Human search results: one block per hit, separated by a blank line. */
export const renderSearch = (response: SearchResponse, options: RenderSearchOptions): string =>
  response.hits.map((hit) => renderSearchHit(hit, options)).join("\n\n");

/** `--plain`: one canonical `owner/name` per line, no ANSI, no blank lines. */
export const renderSearchPlain = (response: SearchResponse): string =>
  response.hits.map((hit) => hit.repo.fullName).join("\n");

/** `--json`: the raw decoded response, pretty-printed. */
export const renderJson = <A>(value: A): string => JSON.stringify(value, null, 2);

/** `semanticCoverage` may arrive as a 0–1 fraction or a 0–100 percentage. */
export const formatCoverage = (value: number): number => {
  const percent = value <= 1 ? value * 100 : value;

  return Math.min(100, Math.max(0, Math.round(percent)));
};

export const renderSearchSummary = (response: SearchResponse): string => {
  const count = response.hits.length;

  const parts = [
    `${formatCount(count)} result${count === 1 ? "" : "s"}`,
    `${response.tookMs} ms`,
    `mode ${response.mode}`
  ];

  const coverage = formatCoverage(response.semanticCoverage);

  if (coverage < 100) parts.push(`semantic ${coverage}%`);

  if (response.degraded !== undefined) parts.push(`degraded: ${response.degraded}`);

  return parts.join(" · ");
};

/** stderr guidance for an empty result set, mentions `--mode semantic`. */
export const renderEmptyHint = (query: string, mode: string): string =>
  [
    `No results for "${query}" in ${mode} mode.`,
    "Try: --mode semantic for meaning-based matches · --mode keyword for exact names ·",
    "widen --min-stars/--lang/--topic filters."
  ].join(" ");

export interface RepoPageInput {
  readonly repo: Repo;
  readonly groups: ReadonlyArray<Group>;
}

/** `show`: repo metadata + GitHub List names from the public index. */
export const renderRepoPage = (page: RepoPageInput, options: { readonly color: boolean }): string => {
  const { repo, groups } = page;
  const header = [bold(repo.fullName, options.color), `★${formatStars(repo.stars)}`];

  if (repo.language !== null && repo.language !== "") header.push(repo.language);

  if (repo.license !== null && repo.license !== "") header.push(repo.license);
  header.push(repo.archived ? "archived" : "not archived");
  const lines = [header.join("  ")];

  if (repo.description !== null && repo.description !== "") lines.push(repo.description);

  const meta: Array<string> = [];
  const starred = formatDate(repo.starredAt);
  const pushed = formatDate(repo.pushedAt);

  if (starred !== undefined) meta.push(`Starred ${starred}`);

  if (pushed !== undefined) meta.push(`Pushed ${pushed}`);

  if (groups.length > 0) meta.push(`Groups: ${groups.map((group) => group.slug).join(", ")}`);

  if (meta.length > 0) lines.push(meta.join(" · "));

  const topics = repo.topics.length > 0 ? `Topics: ${repo.topics.join(", ")}` : undefined;
  lines.push([topics, repo.htmlUrl].filter((part): part is string => part !== undefined).join(" · "));

  return lines.join("\n");
};

export interface UserPageInput {
  readonly profile: UserProfile;
  readonly state: UserIndexState;
  readonly groups: ReadonlyArray<Group>;
}

const phaseSymbol = (phase: SyncPhase): string => {
  switch (phase) {
    case "ready":
      return "●";
    case "failed":
      return "⚠";
    case "paused":
      return "⏸";
    case "idle":
      return "○";
    default:
      return "◐";
  }
};

const identityLine = (profile: UserProfile, color: boolean): string => {
  const name = profile.name === null || profile.name === "" ? "" : `  ${profile.name}`;

  return `${bold(`@${profile.login}`, color)}${name}`;
};

const indexStateLine = (state: UserIndexState): string =>
  [
    `${phaseSymbol(state.phase)} ${state.phase}`,
    `${formatCount(state.starsTotal)} stars`,
    `metadata ${formatCount(state.reposMetadata)}`,
    `readmes ${formatCount(state.readmesFetched)}`,
    `semantic ${formatCount(state.semanticDocs)}`
  ].join(" · ");

/** `status`: profile + index state + freshness. */
export const renderStatusPage = (
  page: UserPageInput,
  options: { readonly color: boolean }
): string => {
  const lines = [identityLine(page.profile, options.color), indexStateLine(page.state)];
  const synced = formatDate(page.state.lastSyncedAt);
  lines.push(synced === undefined ? "Never synced" : `Last synced ${synced} UTC`);

  if (page.state.lastError !== null && page.state.lastError !== "") {
    lines.push(`Last error: ${page.state.lastError}`);
  }

  return lines.join("\n");
};

/** `groups`: one GitHub List per line with its repo count. */
export const renderGroups = (groups: ReadonlyArray<Group>): string => {
  if (groups.length === 0) return "(no groups)";
  const width = Math.max(...groups.map((group) => group.slug.length));

  return groups
    .map((group) => {
      const count = group.repoIds.length;

      return `${group.slug.padEnd(width)}  ${formatCount(count)} ${count === 1 ? "repo" : "repos"}`;
    })
    .join("\n");
};

export interface SyncStartInput {
  readonly started: boolean;
  readonly phase: SyncPhase;
}

export const renderSyncStart = (result: SyncStartInput): string =>
  result.started ? `Sync started · phase ${result.phase}` : `Sync already running · phase ${result.phase}`;

/** One progress line per poll (stderr while `sync --wait` runs). */
export const renderSyncProgress = (state: UserIndexState): string =>
  [
    `${phaseSymbol(state.phase)} ${state.phase}`,
    `${formatCount(state.reposMetadata)}/${formatCount(state.starsTotal)} metadata`,
    `semantic ${formatCount(state.semanticDocs)}`
  ].join(" · ");

/** Final `sync --wait` / `status` state. */
export const renderSyncState = (state: UserIndexState): string => {
  const lines: Array<string> = [];

  if (state.login !== "") lines.push(`@${state.login}`);
  lines.push(indexStateLine(state));
  const synced = formatDate(state.lastSyncedAt);
  lines.push(synced === undefined ? "Never synced" : `Last synced ${synced} UTC`);

  if (state.lastError !== null && state.lastError !== "") lines.push(`Last error: ${state.lastError}`);

  return lines.join("\n");
};

export interface HealthInput {
  readonly ok: boolean;
  readonly service: string;
  readonly version: string;
}

export const renderHealth = (health: HealthInput, apiUrl: string): string =>
  `${health.service} ${health.version} · ${health.ok ? "ok" : "not ok"} · ${apiUrl}`;

export interface ErrorLike {
  readonly message: string;
  readonly hint?: string | undefined;
}

/** One-line error plus a named fix, on stderr (`docs/05-cli.md` §1.4). */
export const renderError = (error: ErrorLike): string => {
  const lines = [`✗ ${error.message}`];

  if (error.hint !== undefined && error.hint !== "") lines.push(`  ${error.hint}`);

  return lines.join("\n");
};
