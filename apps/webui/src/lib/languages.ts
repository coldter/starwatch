/**
 * Curated language facet + Linguist-ish dot colors.
 * The facet is a fixed list (docs/06 §3 keeps the rail small); the API takes
 * the exact language string as a hard filter.
 */

export const LANGUAGES: ReadonlyArray<string> = [
  "TypeScript",
  "JavaScript",
  "Python",
  "Rust",
  "Go",
  "Java",
  "C",
  "C++",
  "C#",
  "Ruby",
  "PHP",
  "Swift",
  "Kotlin",
  "Shell",
  "HTML",
  "CSS",
  "Vue",
  "Svelte",
  "Zig",
  "Elixir",
  "Haskell",
  "Lua",
  "Scala",
  "Dart",
  "Jupyter Notebook",
  "Objective-C",
  "R",
  "Perl",
  "Clojure",
  "OCaml",
  "Nix",
];

const COLORS = {
  TypeScript: "#3178c6",
  JavaScript: "#f1e05a",
  Python: "#3572A5",
  Rust: "#dea584",
  Go: "#00ADD8",
  Java: "#b07219",
  C: "#555555",
  "C++": "#f34b7d",
  "C#": "#178600",
  Ruby: "#701516",
  PHP: "#4F5D95",
  Swift: "#F05138",
  Kotlin: "#A97BFF",
  Shell: "#89e051",
  HTML: "#e34c26",
  CSS: "#563d7c",
  Vue: "#41b883",
  Svelte: "#ff3e00",
  Zig: "#ec915c",
  Elixir: "#6e4a7e",
  Haskell: "#5e5086",
  Lua: "#000080",
  Scala: "#c22d40",
  Dart: "#00B4AB",
  "Jupyter Notebook": "#DA5B0B",
  "Objective-C": "#438eff",
  R: "#198CE7",
  Perl: "#0298c3",
  Clojure: "#db5855",
  OCaml: "#ef7a08",
  Nix: "#7e7eff",
} satisfies Record<string, string>;

/** Arbitrary language strings resolve through the map, falling back to the faint colour. */
const COLOR_BY_LANGUAGE: ReadonlyMap<string, string> = new Map(Object.entries(COLORS));

export function colorForLanguage(language: string | null | undefined): string {
  if (!language) return "var(--muted-foreground)";

  return COLOR_BY_LANGUAGE.get(language) ?? "var(--muted-foreground)";
}
