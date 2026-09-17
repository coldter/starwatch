import { ButtonLink } from "@/components/motion/button/base";
import { GitHubMark } from "@/components/common/Brand";

/**
 * Quiet footer: what the index is, where the source is, and nothing else.
 * The page's own content is always the loudest thing on screen.
 */
export function SiteFooter() {
  return (
    <footer className="mt-16 border-t border-border/80">
      <div className="page-shell flex flex-col gap-3 py-6 text-xs text-muted-foreground sm:flex-row sm:items-center">
        <p className="flex items-center gap-1.5">
          <span className="inline-block size-1.5 rounded-full bg-live" aria-hidden="true" />
          Public GitHub stars only — no account, no token, nothing private is ever fetched.
        </p>
        <div className="flex items-center gap-1 sm:ml-auto">
          <ButtonLink
            variant="ghost"
            size="sm"
            href="https://github.com/coldter/starwatch"
            target="_blank"
            rel="noreferrer noopener"
          >
            <GitHubMark className="size-3.5" />
            Source
          </ButtonLink>
        </div>
      </div>
    </footer>
  );
}
