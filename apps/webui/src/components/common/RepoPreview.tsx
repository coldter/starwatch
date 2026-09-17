import { useState } from "react";
import type { Repo } from "@starwatch/domain";
import { ogImageUrl } from "@/lib/repo-images";
import { cn } from "@/lib/utils";

export interface RepoPreviewProps {
  repo: Repo;
  className?: string;
  /** `lazy` in a result list, `eager` in the drawer the reader just opened. */
  loading?: "lazy" | "eager";
}

/**
 * GitHub's social preview for a repository, on the 2:1 canvas it is drawn for.
 * It is decoration, not information: the tile holds its shape while the image
 * streams in, fades it in when it arrives, and removes itself when GitHub
 * rate-limits the request or the repo has no preview — the card around it never
 * moves. The repo name beside it already links to GitHub, so the tile stays out
 * of the tab order and of the accessibility tree.
 */
export function RepoPreview({ repo, className, loading = "lazy" }: RepoPreviewProps) {
  const [state, setState] = useState<"loading" | "ready" | "failed">("loading");

  if (state === "failed") return null;

  return (
    <a
      href={repo.htmlUrl}
      target="_blank"
      rel="noreferrer noopener"
      tabIndex={-1}
      aria-hidden="true"
      className={cn(
        "relative block aspect-2/1 self-start overflow-hidden rounded-xl border border-border bg-muted",
        // GitHub always draws its card on a light canvas, so a touch of dimming
        // keeps a column of them from glowing against the dark theme.
        "dark:opacity-90",
        className,
      )}
    >
      <img
        src={ogImageUrl(repo)}
        alt=""
        width={1200}
        height={600}
        loading={loading}
        decoding="async"
        referrerPolicy="no-referrer"
        onLoad={() => setState("ready")}
        onError={() => setState("failed")}
        className={cn(
          "h-full w-full object-cover transition-opacity duration-300 motion-reduce:transition-none",
          state === "ready" ? "opacity-100" : "opacity-0",
        )}
      />
    </a>
  );
}
