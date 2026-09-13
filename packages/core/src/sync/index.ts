/**
 * `@starwatch/core/sync` — pure sync planning + transport contracts.
 *
 * The Worker supplies implementations (GitHub client, Workers AI embedder);
 * this package owns ids, ordering, batching and admission decisions.
 */

export * from "./plan.ts";
export * from "./types.ts";
export * from "./wire.ts";
