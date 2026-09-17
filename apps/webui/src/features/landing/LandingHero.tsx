import { type FormEvent } from "react";
import { ShieldCheck, Star } from "lucide-react";
import { AnimatedBadge } from "@/components/motion/animated-badge";
import { Button } from "@/components/motion/button/base";
import { Input } from "@/components/motion/input";
import { Loader } from "@/components/motion/loader";
import { TextReveal } from "@/components/motion/text-reveal";

/** Shared so the gold second half continues the reveal's rhythm instead of restarting. */
const HEADLINE_STAGGER = 0.09;

export interface LandingHeroProps {
  value: string;
  busy: boolean;
  /** Suggested logins, without the `@`. */
  suggestions: ReadonlyArray<string>;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  onPickSuggestion: (login: string) => void;
}

/**
 * The front door: a quiet badge row, the headline with its one gold word, and a
 * single lookup form. Nothing competes with the input — it is the only thing
 * asking to be used.
 */
export function LandingHero({
  value,
  busy,
  suggestions,
  onChange,
  onSubmit,
  onPickSuggestion,
}: LandingHeroProps) {
  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onSubmit(value);
  }

  return (
    <section className="flex flex-col items-center gap-6 py-6 text-center sm:py-10">
      <div className="flex flex-wrap items-center justify-center gap-2">
        <AnimatedBadge status="neutral" size="sm" icon={<ShieldCheck className="size-3" />}>
          No sign-in
        </AnimatedBadge>
        <AnimatedBadge status="neutral" size="sm" icon={<Star className="size-3" />}>
          Public stars only
        </AnimatedBadge>
      </div>

      <h1 className="max-w-3xl text-3xl font-semibold tracking-tight text-balance sm:text-4xl lg:text-5xl">
        <TextReveal
          as="span"
          split="word"
          stagger={HEADLINE_STAGGER}
          // TextReveal wraps each line in a block; inline keeps the two halves
          // flowing as one sentence that wraps naturally with the viewport.
          className="inline [&>span]:inline"
          text="Search anyone's GitHub "
        />
        <TextReveal
          as="span"
          split="word"
          stagger={HEADLINE_STAGGER}
          delay={HEADLINE_STAGGER * 3}
          className="inline text-star [&>span]:inline"
          text="stars."
        />
      </h1>

      <p className="max-w-xl text-sm leading-relaxed text-muted-foreground sm:text-base">
        Full-text and semantic search over public starred repositories — names, descriptions, topics
        and READMEs, read straight from GitHub.
      </p>

      <form
        onSubmit={handleSubmit}
        className="mt-2 flex w-full max-w-xl flex-col gap-3 text-left sm:flex-row sm:items-end"
      >
        <Input
          label="GitHub username"
          className="min-w-0 flex-1"
          classNames={{ field: "h-12" }}
          value={value}
          onChange={onChange}
          placeholder="@username, github.com/username, or a profile URL"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          autoFocus
          data-search-input
        />

        <Button type="submit" size="lg" disabled={busy} className="w-full sm:w-auto">
          {busy ? <Loader variant="spinner" size={16} label="Searching" /> : null}
          Search
        </Button>
      </form>

      {suggestions.length > 0 ? (
        <div className="flex flex-wrap items-center justify-center gap-x-1 gap-y-0.5">
          <span className="px-1 text-sm text-muted-foreground">Try</span>
          {suggestions.map((login) => (
            <Button key={login} variant="ghost" size="sm" onClick={() => onPickSuggestion(login)}>
              @{login}
            </Button>
          ))}
        </div>
      ) : null}
    </section>
  );
}
