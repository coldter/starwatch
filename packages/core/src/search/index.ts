/**
 * `@starwatch/core/search` — the pure search engine.
 *
 * No I/O, no SQL, no fetch: callers (Worker/CLI/eval) run the legs and pass
 * ranked rows in; this module owns normalization, classification, expansion,
 * fusion and snippets.
 */

export * from "./classify.ts";

export * from "./expand.ts";

export * from "./fusion.ts";

export * from "./snippet.ts";

export * from "./text.ts";

export * from "./vector.ts";
