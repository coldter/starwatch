import { useCallback, useRef, useState, type ReactNode } from "react";
import { useModalSurface } from "@/hooks/useModalSurface";
import { CommandMenu } from "./CommandMenu";
import { Header } from "./Header";
import { SiteFooter } from "./SiteFooter";

/**
 * App chrome: skip link, sticky header, content, footer, and the ⌘K palette.
 *
 * The palette's open state lives here rather than in the header so the header
 * button and the keyboard shortcut drive exactly one surface.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const [paletteOpen, setPaletteOpen] = useState(false);
  const openerRef = useRef<HTMLElement | null>(null);

  useModalSurface(paletteOpen);

  // The palette portals out of the app and does not restore focus when it
  // closes, so the trigger (or whatever had focus when ⌘K was pressed) gets it
  // back once the app is interactive again.
  const openPalette = useCallback(() => {
    openerRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setPaletteOpen(true);
  }, []);

  const onPaletteOpenChange = useCallback((next: boolean) => {
    setPaletteOpen(next);

    if (next) return;

    const opener = openerRef.current;
    const fallback = document.querySelector<HTMLElement>("[data-palette-trigger]");

    requestAnimationFrame(() => {
      const target = opener !== null && opener !== document.body ? opener : fallback;

      target?.focus();
    });
  }, []);

  return (
    <div className="flex min-h-dvh flex-col">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:top-3 focus:left-3 focus:z-50 focus:rounded-lg focus:bg-card focus:px-3.5 focus:py-2 focus:text-sm focus:font-medium focus:shadow-lg focus:ring-1 focus:ring-border"
      >
        Skip to content
      </a>
      <Header onOpenPalette={openPalette} />
      <main id="main" tabIndex={-1} className="flex-1 outline-none">
        {children}
      </main>
      <SiteFooter />
      <CommandMenu open={paletteOpen} onOpenChange={onPaletteOpenChange} />
    </div>
  );
}
