import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { fetchHealth } from "@/api";

/**
 * Deployment capabilities, probed once per page load.
 *
 * The worker decides whether this deployment builds and serves embeddings
 * (`STARWATCH_SEMANTIC_SEARCH`, off by default), and the UI must never offer a
 * retrieval mode the API cannot answer. Until the probe lands the value is
 * `false`: hiding a semantic control for a frame is better than showing one
 * that cannot work.
 *
 * A failed probe is deliberately silent. The page's own requests surface the
 * real problem, and the capability simply stays hidden rather than being
 * assumed on.
 */
const SemanticSearchContext = createContext(false);

/** Whether this deployment runs semantic (embedding) search. */
export function useSemanticSearch(): boolean {
  return useContext(SemanticSearchContext);
}

export function CapabilitiesProvider({ children }: { children: ReactNode }) {
  const [semanticSearch, setSemanticSearch] = useState(false);

  useEffect(() => {
    const controller = new AbortController();

    void fetchHealth(controller.signal)
      .then((health) => setSemanticSearch(health.semanticSearch))
      .catch(() => {
        // Handled above: the capability stays off.
      });

    return () => controller.abort();
  }, []);

  return (
    <SemanticSearchContext.Provider value={semanticSearch}>
      {children}
    </SemanticSearchContext.Provider>
  );
}
