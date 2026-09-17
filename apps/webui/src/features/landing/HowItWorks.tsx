import { FileText, ListChecks, Sparkles, type LucideIcon } from "lucide-react";
import { useSemanticSearch } from "@/app/capabilities";
import { cn } from "@/lib/utils";

interface IndexingStep {
  Icon: LucideIcon;
  title: string;
  body: string;
}

const STEPS: ReadonlyArray<IndexingStep> = [
  {
    Icon: ListChecks,
    title: "Star list first",
    body: "The public star list loads in seconds, so keyword search works right away.",
  },
  {
    Icon: FileText,
    title: "READMEs next",
    body: "Descriptions, topics and READMEs are fetched while you search.",
  },
  {
    Icon: Sparkles,
    title: "Vectors last",
    body: "Vectors are built for the newest repos, so meaning search improves as coverage grows.",
  },
];

/** Eager-lazy indexing, explained in the plainest words we have. */
export function HowItWorks() {
  // The vector card only describes a deployment that builds vectors; the grid
  // drops to two columns so the row stays even without it.
  const semanticSearch = useSemanticSearch();
  const steps = semanticSearch ? STEPS : STEPS.filter((step) => step.title !== "Vectors last");

  return (
    <section
      className="mx-auto flex w-full max-w-3xl flex-col gap-4"
      aria-labelledby="how-indexing-works"
    >
      <h2 id="how-indexing-works" className="text-base font-semibold tracking-tight">
        How indexing works
      </h2>

      <ol className={cn("grid gap-3", semanticSearch ? "sm:grid-cols-3" : "sm:grid-cols-2")}>
        {steps.map((step) => (
          <li
            key={step.title}
            className="flex flex-col gap-2.5 rounded-2xl border border-border bg-card p-4"
          >
            <span
              className="grid size-9 place-items-center rounded-xl bg-accent text-accent-foreground"
              aria-hidden="true"
            >
              <step.Icon className="size-4" />
            </span>
            <h3 className="text-sm font-semibold tracking-tight">{step.title}</h3>
            <p className="text-xs leading-relaxed text-muted-foreground">{step.body}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}
