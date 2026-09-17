import { useEffect } from "react";

/**
 * `/` focuses the page's search field from anywhere, the way docs/06 §3
 * specifies. It is a DOM focus rather than a state flag so one shortcut works
 * for whichever surface owns the field on this route — the landing lookup form
 * or the search toolbar — without either page having to register anything.
 *
 * Keystrokes inside a field, editable region, or with a modifier are left alone
 * so `/` keeps typing normally wherever text is being entered.
 */
export function useSearchShortcut() {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;

      const target = event.target;

      const typing =
        target instanceof HTMLElement &&
        (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);

      if (typing) return;

      const input = document.querySelector<HTMLInputElement>("[data-search-input]");

      if (!input) return;

      event.preventDefault();
      input.focus();
      input.select();
    };

    window.addEventListener("keydown", onKeyDown);

    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}
