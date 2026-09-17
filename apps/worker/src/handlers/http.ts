import type { SearchMode, SearchSort, UserIndexState } from "@starwatch/domain";
import * as Option from "effect/Option";
import * as Headers from "effect/unstable/http/Headers";
import type * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import { DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT, MAX_SEARCH_OFFSET } from "../constants.ts";
import type { SearchQuery } from "../api.ts";

/** Canonical login handling: GitHub logins are case-insensitive. */
export const normalizeLogin = (raw: string): string => raw.trim().replace(/^@+/, "").toLowerCase();

/** `cf-connecting-ip`, then the first `x-forwarded-for` hop (dev). */
export const clientIp = (request: HttpServerRequest.HttpServerRequest): string => {
  const direct = Option.getOrUndefined(Headers.get(request.headers, "cf-connecting-ip"));

  if (direct !== undefined && direct.length > 0) return direct;

  const forwarded = Option.getOrUndefined(Headers.get(request.headers, "x-forwarded-for"));

  const first = forwarded?.split(",")[0]?.trim();

  return first !== undefined && first.length > 0 ? first : "unknown";
};

/** Default index state for a user that exists on GitHub but has no row yet. */
export const idleState = (login: string): UserIndexState => ({
  login,
  phase: "idle",
  starsTotal: 0,
  reposMetadata: 0,
  readmesFetched: 0,
  semanticDocs: 0,
  lastSyncedAt: null,
  lastError: null,
  updatedAt: new Date().toISOString(),
});

/** ISO-8601 -> epoch ms, `null` for missing/invalid values. */
export const parseTime = (value: string | null | undefined): number | null => {
  if (value === null || value === undefined) return null;
  const ms = Date.parse(value);

  return Number.isFinite(ms) ? ms : null;
};

const parseNumber = (value: string | undefined): number | undefined => {
  if (value === undefined || value.trim().length === 0) return undefined;
  const parsed = Number(value);

  return Number.isFinite(parsed) ? parsed : undefined;
};

const parseBoolean = (value: string | undefined): boolean | undefined => {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();

  if (normalized === "true" || normalized === "1") return true;

  if (normalized === "false" || normalized === "0") return false;

  return undefined;
};

const splitList = (value: string | undefined): ReadonlyArray<string> | undefined => {
  if (value === undefined) return undefined;

  const items = value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);

  return items.length > 0 ? items : undefined;
};

const optionalText = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();

  return trimmed !== undefined && trimmed.length > 0 ? trimmed : undefined;
};

/**
 * Query params -> domain filters. `topic` is AND across all listed topics
 * (storage semantics); `group` is OR across listed slugs.
 */
export const parseFilters = (query: SearchQuery) => ({
  language: optionalText(query.lang),
  minStars: parseNumber(query.minStars),
  maxStars: parseNumber(query.maxStars),
  topics: splitList(query.topic),
  groups: splitList(query.group),
  archived: parseBoolean(query.archived),
  license: optionalText(query.license),
  starredAfter: optionalText(query.starredAfter),
  starredBefore: optionalText(query.starredBefore),
});

export const parseMode = (value: string | undefined): SearchMode => {
  const normalized = value?.trim().toLowerCase();

  return normalized === "keyword" || normalized === "hybrid" || normalized === "semantic"
    ? normalized
    : "auto";
};

/** Unknown sorts fall back to relevance — never an error, never a random key. */
export const parseSort = (value: string | undefined): SearchSort => {
  const normalized = value?.trim().toLowerCase();

  return normalized === "stars" || normalized === "starred" || normalized === "pushed"
    ? normalized
    : "relevance";
};

/** Row offset for paging. Negative/garbage clamps to 0, everything else to the cap. */
export const parseOffset = (value: string | undefined): number => {
  const parsed = parseNumber(value);

  if (parsed === undefined) return 0;

  return Math.min(MAX_SEARCH_OFFSET, Math.max(0, Math.floor(parsed)));
};

export const parseLimit = (value: string | undefined): number => {
  const parsed = parseNumber(value);

  if (parsed === undefined) return DEFAULT_SEARCH_LIMIT;

  return Math.min(MAX_SEARCH_LIMIT, Math.max(1, Math.floor(parsed)));
};

/**
 * Budget key for a caller (docs/14 §3.3: no raw IPs at rest).
 *
 * The day is mixed in as the salt, so a stored counter cannot be correlated
 * across days even if the table leaks, and a leaked row cannot be reversed to
 * an address without guessing 2^32 candidates per day.
 */
export const hashIp = async (ip: string, day: string): Promise<string> => {
  const bytes = new TextEncoder().encode(`${day}\u0000${ip}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);

  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};
