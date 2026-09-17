import { ThemeProvider as NextThemesProvider } from "next-themes";
import type { ReactNode } from "react";

/**
 * Theme ownership. `next-themes` writes `class="dark"` on `<html>`, which is
 * exactly what the Tailwind `dark` variant and every beUI component read.
 *
 * `system` is the default, so a first visit follows the OS; the header toggle
 * overrides it and the choice persists under the app's own storage key.
 * `disableTransitionOnChange` keeps colors from cross-fading mid-switch — the
 * theme toggle animates the switch itself through the View Transition API.
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  return (
    <NextThemesProvider
      attribute="class"
      defaultTheme="system"
      enableSystem
      storageKey="starwatch-theme"
      disableTransitionOnChange
    >
      {children}
    </NextThemesProvider>
  );
}
