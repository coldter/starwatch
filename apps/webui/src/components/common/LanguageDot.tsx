import { colorForLanguage } from "@/lib/languages";
import { cn } from "@/lib/utils";

export interface LanguageDotProps {
  language: string | null | undefined;
  className?: string;
}

/** Linguist-colored dot, aria-hidden: the language name is always text beside it. */
export function LanguageDot({ language, className }: LanguageDotProps) {
  return (
    <span
      className={cn("inline-block size-2.5 shrink-0 rounded-full ring-1 ring-black/10", className)}
      style={{ backgroundColor: colorForLanguage(language) }}
      aria-hidden="true"
    />
  );
}
