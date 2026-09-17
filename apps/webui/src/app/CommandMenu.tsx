import { useCallback, useMemo } from "react";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { useTheme } from "next-themes";
import {
  ArrowUpRight,
  Copy,
  Home,
  Monitor,
  Moon,
  Search,
  Sparkles,
  Star,
  Sun,
  Type,
  Waypoints,
} from "lucide-react";
import type { SearchMode } from "@starwatch/domain";
import { useSemanticSearch } from "@/app/capabilities";
import { CommandPalette, type CommandItem } from "@/components/motion/command-palette";
import { useToast } from "@/app/toast";
import { copyText } from "@/lib/clipboard";
import { getRecentUsers } from "@/lib/recent";

const MODES: ReadonlyArray<{ mode: SearchMode; label: string; hint: string }> = [
  { mode: "auto", label: "Smart mode", hint: "best mode per query" },
  { mode: "keyword", label: "Keyword mode", hint: "exact words only" },
  { mode: "hybrid", label: "Hybrid mode", hint: "keyword results re-ranked by meaning" },
  { mode: "semantic", label: "Semantic mode", hint: "meaning over indexed READMEs" },
];

function loginFromPath(pathname: string): string | null {
  const match = /^\/u\/([^/?#]+)/.exec(pathname);
  const raw = match?.[1];

  return raw === undefined ? null : decodeURIComponent(raw);
}

export interface CommandMenuProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * The ⌘K palette: one keyboard surface for every destination and global action.
 *
 * Commands are derived from the current location and the recent-users list, so
 * the palette always offers something the page can actually do — including
 * switching search mode without touching the filter rail.
 */
export function CommandMenu({ open, onOpenChange }: CommandMenuProps) {
  const navigate = useNavigate();
  const toast = useToast();
  const { setTheme } = useTheme();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const login = loginFromPath(pathname);
  const semanticSearch = useSemanticSearch();

  const run = useCallback(
    (action: () => void) => {
      onOpenChange(false);
      action();
    },
    [onOpenChange],
  );

  const items = useMemo<CommandItem[]>(() => {
    const commands: CommandItem[] = [
      {
        id: "focus-search",
        label: "Search this page",
        group: "Go to",
        hint: "/",
        keywords: ["find", "filter", "results"],
        icon: Search,
        onSelect: () =>
          run(() => {
            const input = document.querySelector<HTMLInputElement>("[data-search-input]");

            if (input) {
              input.focus();
              input.select();
            }
          }),
      },
      {
        id: "home",
        label: "Look up another user",
        group: "Go to",
        keywords: ["home", "github", "username", "stars"],
        icon: Home,
        onSelect: () => run(() => void navigate({ to: "/", search: {} })),
      },
    ];

    if (login !== null) {
      commands.push({
        id: "github-user",
        label: `Open @${login} on GitHub`,
        group: "Go to",
        keywords: ["external", "profile"],
        icon: Waypoints,
        onSelect: () =>
          run(() => window.open(`https://github.com/${login}`, "_blank", "noopener,noreferrer")),
      });
    }

    for (const user of getRecentUsers().slice(0, 5)) {
      commands.push({
        id: `recent-${user.login}`,
        label: user.name ?? user.login,
        group: "Recent users",
        hint: `@${user.login}`,
        keywords: [user.login, "recent", "history"],
        icon: Star,
        onSelect: () =>
          run(() => void navigate({ to: "/u/$login", params: { login: user.login }, search: {} })),
      });
    }

    // A keyword-only deployment has no mode to switch: "Smart" and "Keyword"
    // would be the same request, so the group is not offered at all.
    if (login !== null && semanticSearch) {
      for (const entry of MODES) {
        commands.push({
          id: `mode-${entry.mode}`,
          label: entry.label,
          group: "Search mode",
          hint: entry.hint,
          keywords: ["mode", "search", entry.mode],
          icon: entry.mode === "auto" ? Sparkles : Type,
          onSelect: () =>
            run(
              () =>
                void navigate({
                  to: "/u/$login",
                  params: { login },
                  search: (previous) => ({ ...previous, mode: entry.mode, page: undefined }),
                }),
            ),
        });
      }
    }

    commands.push(
      {
        id: "copy-link",
        label: "Copy page link",
        group: "Page",
        keywords: ["share", "url", "clipboard"],
        icon: Copy,
        onSelect: () =>
          run(() => {
            void copyText(window.location.href).then((copied) => {
              if (copied) {
                toast.success("Link copied");

                return;
              }

              toast.error("Couldn't copy the link", "Copy it from the address bar instead.");
            });
          }),
      },
      {
        id: "theme-dark",
        label: "Dark appearance",
        group: "Appearance",
        keywords: ["theme", "night", "mode"],
        icon: Moon,
        onSelect: () => run(() => setTheme("dark")),
      },
      {
        id: "theme-light",
        label: "Light appearance",
        group: "Appearance",
        keywords: ["theme", "day", "mode"],
        icon: Sun,
        onSelect: () => run(() => setTheme("light")),
      },
      {
        id: "theme-system",
        label: "Match system appearance",
        group: "Appearance",
        keywords: ["theme", "auto", "os"],
        icon: Monitor,
        onSelect: () => run(() => setTheme("system")),
      },
      {
        id: "source",
        label: "starwatch on GitHub",
        group: "About",
        keywords: ["source", "code", "repository"],
        icon: Waypoints,
        onSelect: () =>
          run(() =>
            window.open("https://github.com/coldter/starwatch", "_blank", "noopener,noreferrer"),
          ),
      },
      {
        id: "github-search",
        label: "Open GitHub search",
        group: "About",
        keywords: ["external", "github", "repositories"],
        icon: ArrowUpRight,
        onSelect: () =>
          run(() =>
            window.open(
              "https://github.com/search?type=repositories",
              "_blank",
              "noopener,noreferrer",
            ),
          ),
      },
    );

    return commands;
  }, [login, navigate, run, semanticSearch, setTheme, toast]);

  return (
    <CommandPalette
      items={items}
      open={open}
      onOpenChange={onOpenChange}
      placeholder="Jump to a user, action or setting…"
      emptyMessage="Nothing matches that command."
    />
  );
}
