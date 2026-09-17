import type { Repo } from "@starwatch/domain";

/**
 * Owner avatars come straight from the login — the same URL the GitHub API
 * hands back as `owner.avatar_url`, so the WebUI can build it without widening
 * the stored `Repo` (and it works for every row already in the index).
 */
export function ownerAvatarUrl(owner: string, size = 64): string {
  return `https://github.com/${encodeURIComponent(owner)}.png?size=${size}`;
}

/**
 * GitHub's social preview card for a repository: the image behind link
 * unfurls. The first path segment is only a cache key, so a constant is fine.
 * GitHub rate-limits this endpoint, so callers must survive a failed request.
 */
export function ogImageUrl(repo: Pick<Repo, "owner" | "name">): string {
  return `https://opengraph.githubassets.com/starwatch/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`;
}
