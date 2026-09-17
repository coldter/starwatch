import { useEffect } from "react";

/**
 * Route-owned document title. Every page states its own title so the browser
 * history and shared links read correctly without a routing-level title map.
 */
export function useDocumentTitle(title: string) {
  useEffect(() => {
    document.title = title;
  }, [title]);
}
