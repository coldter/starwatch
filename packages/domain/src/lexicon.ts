import * as Schema from "effect/Schema";

/**
 * Static concept lexicon for deterministic query expansion (docs/17 §2).
 *
 * `triggers` are lowercase query tokens/phrases that activate a concept;
 * `expand` terms are appended to the retrieval query (as a separate,
 * lower-weighted expansion leg — never replacing the original query).
 */
export const Concept = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  triggers: Schema.Array(Schema.String),
  expand: Schema.Array(Schema.String),
});

export type Concept = typeof Concept.Type;

export const LEXICON: ReadonlyArray<Concept> = [
  {
    id: "auth",
    label: "Authentication & Authorization",
    triggers: [
      "auth",
      "authentication",
      "authorization",
      "login",
      "oauth",
      "oidc",
      "sso",
      "iam",
      "jwt",
      "session",
      "permissions",
    ],
    expand: [
      "authentication",
      "authorization",
      "oauth",
      "oidc",
      "jwt",
      "sso",
      "session",
      "permissions",
      "access control",
      "identity",
    ],
  },
  {
    id: "http-client",
    label: "HTTP clients",
    triggers: ["http", "fetch", "rest", "api-client", "axios", "ky"],
    expand: ["http client", "fetch", "request", "retry", "interceptor", "rest"],
  },
  {
    id: "jobs",
    label: "Background jobs & workflows",
    triggers: ["job", "jobs", "scheduler", "cron", "queue", "workflow", "background"],
    expand: [
      "background jobs",
      "job queue",
      "scheduler",
      "cron",
      "durable execution",
      "task queue",
      "workflow engine",
    ],
  },
  {
    id: "database",
    label: "Databases",
    triggers: ["database", "db", "sql", "postgres", "sqlite", "orm"],
    expand: ["database", "sql", "postgres", "sqlite", "query builder", "orm"],
  },
  {
    id: "vector-search",
    label: "Vector search & embeddings",
    triggers: ["vector", "embedding", "embeddings", "semantic", "rag", "similarity"],
    expand: [
      "vector database",
      "embeddings",
      "semantic search",
      "similarity",
      "rag",
      "nearest neighbor",
    ],
  },
  {
    id: "tui",
    label: "Terminal UIs",
    triggers: ["tui", "terminal", "cli"],
    expand: ["terminal user interface", "tui", "cli", "terminal"],
  },
  {
    id: "rate-limit",
    label: "Rate limiting & backpressure",
    triggers: ["rate-limit", "ratelimit", "throttle", "quota", "backpressure"],
    expand: ["rate limiting", "throttle", "quota", "backpressure", "debounce"],
  },
  {
    id: "state",
    label: "State management",
    triggers: ["state", "store", "reactive", "signals"],
    expand: ["state management", "store", "reactive", "signals"],
  },
  {
    id: "testing",
    label: "Testing",
    triggers: ["test", "testing", "assert", "mock"],
    expand: ["testing", "test runner", "assertions", "mocking", "snapshot"],
  },
  {
    id: "caching",
    label: "Caching",
    triggers: ["cache", "caching", "memo"],
    expand: ["caching", "cache", "memoization", "kv store"],
  },
  {
    id: "cli",
    label: "CLI tooling",
    triggers: ["cli", "command-line", "args", "flags"],
    expand: ["command line", "cli framework", "argument parser", "flags"],
  },
  {
    id: "observability",
    label: "Observability",
    triggers: ["observability", "logging", "tracing", "metrics", "telemetry"],
    expand: ["logging", "tracing", "metrics", "telemetry", "monitoring"],
  },
  {
    id: "validation",
    label: "Schema validation & parsing",
    triggers: ["validation", "schema", "parser", "parsing"],
    expand: ["schema validation", "parser", "type safety", "serialization"],
  },
  {
    id: "editor",
    label: "Editors & IDEs",
    triggers: ["editor", "ide", "vim", "neovim", "vscode"],
    expand: ["editor", "ide", "vim", "neovim", "vscode", "language server"],
  },
  {
    id: "ui",
    label: "UI frameworks & components",
    triggers: ["ui", "components", "react", "css", "design-system"],
    expand: ["ui components", "design system", "css", "react", "headless ui"],
  },
];

export const conceptById = (id: string): Concept | undefined => LEXICON.find((c) => c.id === id);
