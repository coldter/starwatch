import { Link, useRouterState } from "@tanstack/react-router";
import { Search, Star } from "lucide-react";
import { ThemeToggle } from "@/components/motion/theme-toggle";
import { ButtonLink } from "@/components/motion/button/base";
import { GitHubMark } from "@/components/common/Brand";

function loginFromPath(pathname: string): string | null {
  const match = /^\/u\/([^/?#]+)/.exec(pathname);
  const raw = match?.[1];

  return raw === undefined ? null : decodeURIComponent(raw);
}

export interface HeaderProps {
  onOpenPalette: () => void;
}

/**
 * Sticky app chrome. The brand doubles as the way home, the login breadcrumb
 * shows which index you are browsing, and the palette trigger is the single
 * visible entry point to every global action (⌘K also works from anywhere).
 */
export function Header({ onOpenPalette }: HeaderProps) {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const login = loginFromPath(pathname);

  return (
    <header className="sticky top-0 z-40 border-b border-border/80 bg-background/75 backdrop-blur-xl">
      <div className="page-shell flex h-14 items-center gap-3">
        <Link
          to="/"
          className="flex items-center gap-2 rounded-lg pr-1 text-sm font-semibold tracking-tight"
          aria-label="starwatch — home"
        >
          <span
            className="grid size-7 place-items-center rounded-[0.55rem] bg-linear-to-br from-primary/15 to-star/25 ring-1 ring-border"
            aria-hidden="true"
          >
            <Star className="size-4 fill-star text-star" />
          </span>
          <span>starwatch</span>
        </Link>

        {login !== null ? (
          <>
            <span className="text-muted-foreground/60" aria-hidden="true">
              /
            </span>
            <Link
              to="/u/$login"
              params={{ login }}
              className="max-w-40 truncate rounded-md px-1 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground sm:max-w-none"
            >
              @{login}
            </Link>
          </>
        ) : null}

        <div className="ml-auto flex items-center gap-1.5">
          <button
            type="button"
            data-palette-trigger=""
            onClick={onOpenPalette}
            className="group flex h-8 items-center gap-2 rounded-full border border-border bg-card/70 pr-1.5 pl-3 text-xs text-muted-foreground transition-colors hover:border-border-strong hover:text-foreground"
            aria-label="Open the command palette"
          >
            <Search className="size-3.5" aria-hidden="true" />
            <span className="hidden sm:inline">Jump to…</span>
            <kbd className="hidden rounded-full border border-border bg-muted px-1.5 py-0.5 font-mono text-[0.625rem] tracking-tight sm:inline">
              ⌘K
            </kbd>
          </button>

          <ButtonLink
            variant="ghost"
            size="icon"
            href="https://github.com/coldter/starwatch"
            target="_blank"
            rel="noreferrer noopener"
            aria-label="starwatch on GitHub"
          >
            <GitHubMark className="size-4" />
          </ButtonLink>

          <ThemeToggle
            variant="circle-blur"
            start="top-right"
            className="size-8 rounded-lg text-muted-foreground transition-colors hover:bg-primary/5 hover:text-foreground"
            iconClassName="size-4"
          />
        </div>
      </div>
    </header>
  );
}
