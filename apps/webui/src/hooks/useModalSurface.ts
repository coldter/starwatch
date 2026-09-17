import { useEffect } from "react";

/**
 * Makes the app inert while a modal surface is open.
 *
 * beUI's `BottomSheet` and `CommandPalette` portal to `<body>` and mark
 * themselves `aria-modal`, but neither contains Tab on its own — without this,
 * a keyboard user tabs from the overlay back into the dimmed page behind it.
 * Marking the app root inert removes the background from both the tab order and
 * pointer interaction, which is exactly what `aria-modal` promises. Overlays
 * that render *inside* the root (the repo drawer) must not use this; they
 * contain focus themselves.
 */
export function useModalSurface(active: boolean) {
  useEffect(() => {
    if (!active) return;

    const root = document.getElementById("root");

    if (!root) return;

    root.setAttribute("inert", "");

    return () => {
      root.removeAttribute("inert");
    };
  }, [active]);
}
