import { createRouter, type SearchParser, type SearchSerializer } from "@tanstack/react-router";
import { rootRoute } from "./routes/__root";
import { landingRoute } from "./routes/landing";
import { userRoute } from "./routes/user";

/**
 * URL-only search serialization: repeated keys for arrays
 * (`?group=work&group=reading`) and no JSON-encoded blobs, so every search
 * URL stays human-readable and shareable (docs/08 §3.1).
 *
 * Both functions carry the router's own `SearchParser`/`SearchSerializer`
 * contracts, so the values crossing this boundary stay described by the
 * library that calls them.
 */
const parseSearch: SearchParser = (searchStr) => {
  const params = new URLSearchParams(searchStr);
  const result: Record<string, string | string[]> = {};

  for (const key of new Set(params.keys())) {
    const values = params.getAll(key);
    const [first] = values;

    if (first === undefined) continue;

    if (values.length > 1) result[key] = values;
    else result[key] = first;
  }

  return result;
};

const stringifySearch: SearchSerializer = (search) => {
  const params = new URLSearchParams();

  for (const [key, value] of Object.entries(search)) {
    if (value === undefined || value === null) continue;
    const values = Array.isArray(value) ? value : [value];

    for (const entry of values) {
      if (entry === undefined || entry === null || entry === "") continue;

      params.append(key, String(entry));
    }
  }

  const query = params.toString();

  return query ? `?${query}` : "";
};

const routeTree = rootRoute.addChildren([landingRoute, userRoute]);

export const router = createRouter({
  routeTree,
  defaultPreload: "intent",
  parseSearch,
  stringifySearch,
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
