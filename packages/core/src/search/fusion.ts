/**
 * Weighted reciprocal-rank fusion with evidence-gated boosts (docs/17 §3, docs/18 §6).
 *
 * Score shape for a repo `r`:
 *
 *   base(r)  = Σ_leg w_leg / (RRF_K + rank_leg(r))          // legs absent from L contribute 0
 *   score(r) = base(r)
 *            × nameBoost(r)                                  // IDF/specificity-gated (§ nameBoost)
 *            × starPrior(r.stars)                            // capped ×1.25
 *            × (archived ? ARCHIVED_PENALTY : 1)
 *            + overlapBonus(r)                               // additive topic/description evidence
 *            × duplicatePenalty(r)                           // greedy, in score order
 *
 * All constants below are exported so doc 18's eval lab can tune them one at a
 * time (docs/17 §5 #13: "boost/threshold values are tunable units").
 */

import type { MatchSource, Repo } from "@starwatch/domain";
import { tokenize } from "./text.ts";

export interface Ranked {
  readonly repoId: number;
  readonly rank: number;
}

export interface Scored {
  readonly repoId: number;
  readonly score: number;
}

export interface LegWeights {
  readonly keyword: number;
  readonly expanded: number;
  readonly semantic: number;
}

/** RRF dampening constant (Cormack et al. 2009; docs/07 §5.2). */
export const RRF_K = 60;

/**
 * Leg weights from docs/17 §3.2 / docs/18: the expansion leg is additive
 * evidence at 0.6 of the primary legs, so a concept hit can never outrank a
 * strong lexical or semantic hit by itself.
 */
export const DEFAULT_LEG_WEIGHTS: LegWeights = {
  keyword: 1.0,
  expanded: 0.6,
  semantic: 1.0,
};

/**
 * Star prior: `1 + 0.25 · log10(1+stars) / log10(1+50_000)`, capped ×1.25.
 * Popularity is a prior, never a meaning substitute (docs/18 §4.1: a 24★
 * exact-name repo must not be pinned above a 30k★ concept leader).
 */
export const STAR_PRIOR_COEFFICIENT = 0.25;

export const STAR_PRIOR_REFERENCE = 50_000;

export const STAR_PRIOR_CAP = 1.25;

export const ARCHIVED_PENALTY = 0.4;

/**
 * Duplicate penalties (docs/17 §3.5): each additional earlier hit from the
 * same owner costs ×0.85; the same normalized name (lowercased, punctuation
 * stripped) costs ×0.70. Applied greedily after sorting by score, so the best
 * representative of a family is the one that keeps its score.
 */
export const OWNER_DUPLICATE_PENALTY = 0.85;

export const NAME_DUPLICATE_PENALTY = 0.7;

/**
 * Additive topic/description overlap bonus. Evidence terms (query tokens +
 * expansion terms, deduped) are matched as whole token sequences:
 *
 *   bonus = min(topicMatches, TOPIC_OVERLAP_CAP)     × TOPIC_OVERLAP_PER_TERM
 *         + min(descMatches,  DESCRIPTION_OVERLAP_CAP) × DESCRIPTION_OVERLAP_PER_TERM
 *
 * Magnitudes are fractions of `1/(RRF_K+1) ≈ 0.0164`, the strongest single-leg
 * contribution: capped topic evidence is worth at most ~0.55 of a rank-1 leg,
 * capped description evidence ~0.27. Additive (not multiplicative) so a repo
 * with no leg rank never gains score from prose alone.
 */
export const TOPIC_OVERLAP_PER_TERM = 0.003;

export const TOPIC_OVERLAP_CAP = 3;

export const DESCRIPTION_OVERLAP_PER_TERM = 0.0015;

export const DESCRIPTION_OVERLAP_CAP = 3;

/**
 * Name boost tiers (docs/07 §5.3, docs/17 §3.3, docs/18 §6.1). A term's tier
 * factor is damped by its corpus specificity:
 *
 *   specificity = 1 / (1 + log2(1 + df))          // df = #repo names containing the token
 *   factor      = 1 + (tier − 1) · specificity
 *
 * `auth` with df=100 in names gives specificity 0.126 → an exact-name boost of
 * only ×1.057, instead of pinning a 24★ `auth` repo to #1 (docs/18 §4.1).
 * Tier priority: exact name > name prefix (≥3 chars) > name token. Multiple
 * matched terms do not stack; the best single term wins, capped at
 * {@link NAME_BOOST_MAX}. Lower the cap to widen the thin-evidence clamp.
 */
export const NAME_EXACT_FACTOR = 1.45;

export const NAME_PREFIX_FACTOR = 1.2;

export const NAME_TOKEN_FACTOR = 1.1;

export const NAME_PREFIX_MIN_CHARS = 3;

export const NAME_BOOST_MAX = 1.6;

const EMPTY_GROUPS: ReadonlyArray<string> = Object.freeze([]);

/** Match-source emission order (must stay a subset of the domain MatchSource order). */
const MATCH_SOURCE_ORDER: ReadonlyArray<MatchSource> = [
  "keyword",
  "expanded",
  "semantic",
  "name",
];

/** Lowercase + strip everything that is not a letter/digit: `better-auth` → `betterauth`. */
export const normalizeName = (value: string): string =>
  value
    .normalize("NFC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");

export const toRanked = (
  rows: ReadonlyArray<{ readonly repoId: number; readonly rank: number }>,
): ReadonlyArray<Ranked> =>
  rows.map((row) => ({ repoId: row.repoId, rank: row.rank }));

/**
 * Convert raw per-leg scores (e.g. semantic cosine 0..1) into deterministic
 * rank order. Ties break by repoId ascending so fusion never depends on input
 * array order.
 */
export const rankByScore = (
  rows: ReadonlyArray<Scored>,
): ReadonlyArray<Ranked> =>
  [...rows]
    .sort((a, b) => b.score - a.score || a.repoId - b.repoId)
    .map((row, index) => ({ repoId: row.repoId, rank: index + 1 }));

/**
 * Document frequency of name tokens across the corpus (docs/17 §3.3, docs/18 §6.1).
 * Each repo contributes at most once per token.
 */
export const computeNameStats = (
  repos: ReadonlyArray<Repo>,
): Map<string, number> => {
  const stats = new Map<string, number>();
  const seen = new Set<string>();

  for (const repo of repos) {
    seen.clear();

    for (const token of tokenize(repo.name)) {
      if (seen.has(token)) continue;
      seen.add(token);
      stats.set(token, (stats.get(token) ?? 0) + 1);
    }
  }

  return stats;
};

/**
 * Specificity of a term against {@link computeNameStats}. Multi-token terms
 * use the most common constituent token's df (the most generic reading).
 */
export const termSpecificity = (
  term: string,
  nameStats: ReadonlyMap<string, number>,
): number => {
  let df = 0;

  for (const token of tokenize(term)) {
    df = Math.max(df, nameStats.get(token) ?? 0);
  }

  return 1 / (1 + Math.log2(1 + df));
};

/** Deduped evidence terms (query tokens + concept terms), preserving caller order. */
export const evidenceTerms = (
  queryTokens: ReadonlyArray<string>,
  conceptTerms: ReadonlyArray<string>,
): ReadonlyArray<string> => {
  const seen = new Set<string>();
  const out: string[] = [];

  for (const term of [...queryTokens, ...conceptTerms]) {
    const key = term.trim().toLowerCase();

    if (key.length < 2 || seen.has(key)) continue;
    seen.add(key);
    out.push(term);
  }

  return out;
};

/**
 * Tiered, specificity-gated name boost. Returns 1 (no-op) when nothing
 * matches. Exact match = the whole normalized name equals the term; prefix =
 * the normalized name starts with a ≥3-char term; token = the term is one of
 * the name's tokens (`auth` in `better-auth`).
 */
export const nameBoost = (
  repo: Repo,
  queryTokens: ReadonlyArray<string>,
  nameStats: ReadonlyMap<string, number>,
  conceptTerms: ReadonlyArray<string> = [],
): number => {
  const repoName = normalizeName(repo.name);

  if (repoName.length === 0) return 1;

  const nameTokens = new Set(tokenize(repo.name));
  const candidates = evidenceTerms(queryTokens, conceptTerms);
  let best = 1;

  for (const term of candidates) {
    const normalized = normalizeName(term);

    if (normalized.length < 2) continue;

    let tier = 1;

    if (normalized === repoName) {
      tier = NAME_EXACT_FACTOR;
    } else if (
      normalized.length >= NAME_PREFIX_MIN_CHARS &&
      repoName.startsWith(normalized)
    ) {
      tier = NAME_PREFIX_FACTOR;
    } else if (nameTokens.has(normalized)) {
      tier = NAME_TOKEN_FACTOR;
    }

    if (tier <= 1) continue;

    const factor = 1 + (tier - 1) * termSpecificity(term, nameStats);

    if (factor > best) best = factor;
  }

  return Math.min(best, NAME_BOOST_MAX);
};

/** `1 + 0.25 · log10(1+stars)/log10(1+50000)`, capped ×1.25. */
export const starPrior = (stars: number): number => {
  if (!Number.isFinite(stars) || stars <= 0) return 1;
  const ratio = Math.log10(1 + stars) / Math.log10(1 + STAR_PRIOR_REFERENCE);

  return Math.min(1 + STAR_PRIOR_COEFFICIENT * ratio, STAR_PRIOR_CAP);
};

const containsTokenSequence = (
  haystack: ReadonlyArray<string>,
  needle: ReadonlyArray<string>,
): boolean => {
  if (needle.length === 0 || needle.length > haystack.length) return false;

  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }

    return true;
  }

  return false;
};

const countFieldMatches = (
  terms: ReadonlyArray<string>,
  field: string,
): number => {
  if (field.length === 0) return 0;
  const fieldTokens = tokenize(field);
  let matches = 0;

  for (const term of terms) {
    if (containsTokenSequence(fieldTokens, tokenize(term))) matches++;
  }

  return matches;
};

/** Additive whole-token overlap bonus; see the constants' doc comment. */
export const overlapBonus = (
  repo: Repo,
  terms: ReadonlyArray<string>,
): number => {
  if (terms.length === 0) return 0;
  const topicMatches = Math.min(
    countFieldMatches(terms, repo.topics.join(" ")),
    TOPIC_OVERLAP_CAP,
  );

  const descriptionMatches = Math.min(
    countFieldMatches(terms, repo.description ?? ""),
    DESCRIPTION_OVERLAP_CAP,
  );

  return (
    topicMatches * TOPIC_OVERLAP_PER_TERM +
    descriptionMatches * DESCRIPTION_OVERLAP_PER_TERM
  );
};

export interface FuseInput {
  readonly keyword?: ReadonlyArray<Ranked>;
  /** Expansion-leg ranks from {@link expandQuery.expression} (weight 0.6). */
  readonly expanded?: ReadonlyArray<Ranked>;
  /** Semantic ranks — convert cosine scores with {@link rankByScore} first. */
  readonly semantic?: ReadonlyArray<Ranked>;
  /** Eligible repos (filters already applied) by GitHub numeric id. */
  readonly repos: ReadonlyMap<number, Repo>;
  readonly groups?: ReadonlyMap<number, ReadonlyArray<string>>;
}

export interface FuseOptions {
  /** Original parsed query tokens (name + topic/description evidence). */
  readonly queryTokens?: ReadonlyArray<string>;
  /** Activated lexicon terms (name + topic/description evidence). */
  readonly conceptTerms?: ReadonlyArray<string>;
  /** Name document frequencies from {@link computeNameStats} (IDF gating). */
  readonly nameStats?: ReadonlyMap<string, number>;
  /** Per-query weight overrides for eval A/B runs. */
  readonly weights?: Partial<LegWeights>;
  /** Toggle the owner/name duplicate penalties (default on). */
  readonly duplicatePenalties?: boolean;
}

export interface FusedHit {
  readonly repo: Repo;
  readonly score: number;
  readonly matchedBy: ReadonlyArray<MatchSource>;
  readonly legRanks: Readonly<{
    readonly keyword?: number;
    readonly expanded?: number;
    readonly semantic?: number;
  }>;
  readonly groups: ReadonlyArray<string>;
}

interface Accumulator {
  readonly repo: Repo;
  rrf: number;
  readonly legRanks: { keyword?: number; expanded?: number; semantic?: number };
  score: number;
  boostFired: boolean;
}

type LegName = "keyword" | "expanded" | "semantic";

const addLeg = (
  accs: Map<number, Accumulator>,
  repos: ReadonlyMap<number, Repo>,
  rows: ReadonlyArray<Ranked> | undefined,
  leg: LegName,
  weight: number,
): void => {
  if (!rows || rows.length === 0) return;

  const bestRankByRepo = new Map<number, number>();

  for (const row of rows) {
    if (!Number.isFinite(row.rank) || row.rank < 1) continue;
    const current = bestRankByRepo.get(row.repoId);

    if (current === undefined || row.rank < current)
      bestRankByRepo.set(row.repoId, row.rank);
  }

  for (const [repoId, rank] of bestRankByRepo) {
    const repo = repos.get(repoId);

    if (!repo) continue;
    const existing = accs.get(repoId);

    const acc: Accumulator = existing ?? {
      repo,
      rrf: 0,
      legRanks: {},
      score: 0,
      boostFired: false,
    };

    acc.rrf += weight / (RRF_K + rank);
    acc.legRanks[leg] = rank;
    accs.set(repoId, acc);
  }
};

const compareHits = (a: Accumulator, b: Accumulator): number =>
  b.score - a.score || b.repo.stars - a.repo.stars || a.repo.id - b.repo.id;

const applyDuplicatePenalties = (hits: ReadonlyArray<Accumulator>): void => {
  const ownerCounts = new Map<string, number>();
  const nameCounts = new Map<string, number>();

  for (const hit of hits) {
    const ownerKey = hit.repo.owner.toLowerCase();
    const nameKey = normalizeName(hit.repo.name);
    const ownerPrior = ownerCounts.get(ownerKey) ?? 0;
    const namePrior = nameCounts.get(nameKey) ?? 0;
    hit.score *=
      OWNER_DUPLICATE_PENALTY ** ownerPrior *
      NAME_DUPLICATE_PENALTY ** namePrior;
    ownerCounts.set(ownerKey, ownerPrior + 1);
    nameCounts.set(nameKey, namePrior + 1);
  }
};

/**
 * Fuse ranked legs into one deterministic list. Repos absent from
 * {@link FuseInput.repos} (i.e. filtered out) are dropped even if a leg ranked
 * them — filters are constraints, not boosts (docs/07 §2).
 */
export const fuse = (
  input: FuseInput,
  options: FuseOptions = {},
): ReadonlyArray<FusedHit> => {
  const weights: LegWeights = {
    keyword: options.weights?.keyword ?? DEFAULT_LEG_WEIGHTS.keyword,
    expanded: options.weights?.expanded ?? DEFAULT_LEG_WEIGHTS.expanded,
    semantic: options.weights?.semantic ?? DEFAULT_LEG_WEIGHTS.semantic,
  };

  const nameStats = options.nameStats ?? new Map<string, number>();
  const queryTokens = options.queryTokens ?? [];
  const conceptTerms = options.conceptTerms ?? [];
  const terms = evidenceTerms(queryTokens, conceptTerms);

  const accs = new Map<number, Accumulator>();
  addLeg(accs, input.repos, input.keyword, "keyword", weights.keyword);
  addLeg(accs, input.repos, input.expanded, "expanded", weights.expanded);
  addLeg(accs, input.repos, input.semantic, "semantic", weights.semantic);

  for (const acc of accs.values()) {
    const boost = nameBoost(acc.repo, queryTokens, nameStats, conceptTerms);
    acc.boostFired = boost > 1;
    let score = acc.rrf * boost * starPrior(acc.repo.stars);

    if (acc.repo.archived) score *= ARCHIVED_PENALTY;
    score += overlapBonus(acc.repo, terms);
    acc.score = score;
  }

  const ordered = [...accs.values()].sort(compareHits);

  if (options.duplicatePenalties !== false) applyDuplicatePenalties(ordered);
  ordered.sort(compareHits);

  return ordered.map((acc) => {
    const matchedBy: MatchSource[] = [];

    for (const source of MATCH_SOURCE_ORDER) {
      if (source === "name") {
        if (acc.boostFired) matchedBy.push(source);
        continue;
      }

      if (acc.legRanks[source] !== undefined) matchedBy.push(source);
    }

    return {
      repo: acc.repo,
      score: acc.score,
      matchedBy,
      legRanks: { ...acc.legRanks },
      groups: input.groups?.get(acc.repo.id) ?? EMPTY_GROUPS,
    };
  });
};
