/**
 * Pure GitHub URL helpers (no I/O) — unit-testable on their own.
 *
 * README probing deliberately hits `raw.githubusercontent.com` (zero API
 * quota, docs/09 §3.1) and uses the repo's **default branch**, never `HEAD`:
 * the listing already carries `default_branch`, and pinning it keeps cached
 * paths meaningful.
 */

export const GITHUB_API_BASE = "https://api.github.com";

export const GITHUB_RAW_BASE = "https://raw.githubusercontent.com";

export const GITHUB_GRAPHQL_URL = `${GITHUB_API_BASE}/graphql`;

/** Candidate README paths, in probe order (docs/09 §3.2/§3.3). */
export const README_PROBE_PATHS = [
  "README.md",
  "readme.md",
  "README.rst",
  "README.txt",
  ".github/README.md"
] as const;

/** `GET /users/{login}/starred` URL: newest-first listing with `created asc`. */
export const starPageUrl = (login: string, page: number, perPage: number): string => {
  const params = new URLSearchParams({
    per_page: String(perPage),
    page: String(page),
    sort: "created",
    direction: "asc"
  });

  return `${GITHUB_API_BASE}/users/${encodeURIComponent(login)}/starred?${params.toString()}`;
};

/**
 * Raw README probe URLs for a repo, in order. `fullName` and the branch are
 * percent-encoded per path segment/ref; the returned order is the expected
 * display preference for the common case.
 */
export const readmeProbeUrls = (
  fullName: string,
  defaultBranch: string
): ReadonlyArray<string> => {
  const repoPath = fullName.split("/").map(encodeURIComponent).join("/");
  const ref = encodeURIComponent(defaultBranch);

  return README_PROBE_PATHS.map((path) => `${GITHUB_RAW_BASE}/${repoPath}/${ref}/${path}`);
};

/**
 * Extract the page number of the `Link: <...>; rel="next"` entry.
 * Returns `undefined` when there is no next page or the header is malformed.
 */
export const parseLinkNext = (linkHeader: string | null | undefined): number | undefined => {
  if (linkHeader === null || linkHeader === undefined || linkHeader.length === 0) {
    return undefined;
  }

  for (const part of linkHeader.split(",")) {
    if (!/rel="next"/.test(part)) continue;
    const match = /<([^>]+)>/.exec(part);
    const target = match?.[1];

    if (target === undefined) return undefined;

    try {
      const page = Number(new URL(target).searchParams.get("page"));

      if (Number.isInteger(page) && page > 0) return page;
    } catch {
      return undefined;
    }
  }

  return undefined;
};
