import { colorForLanguage } from "../lib/languages";

export function LanguageDot({ language }: { language: string | null | undefined }) {
  return (
    <span
      className="language-dot"
      style={{ backgroundColor: colorForLanguage(language) }}
      aria-hidden="true"
    />
  );
}
