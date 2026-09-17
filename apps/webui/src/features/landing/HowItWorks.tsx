import { FileText, ListChecks, Sparkles, type LucideIcon } from "lucide-react";

interface IndexingStep {
  Icon: LucideIcon;
  title: string;
  body: string;
}

const STEPS: ReadonlyArray<IndexingStep> = [
  {
    Icon: ListChecks,
    title: "The star list lands first",
    body: "The public star listing is read in seconds, so keyword search works almost immediately.",
  },
  {
    Icon: FileText,
    title: "READMEs fill in behind it",
    body: "Descriptions, topics and READMEs stream into the index while you search.",
  },
  {
    Icon: Sparkles,
    title: "Meaning arrives last",
    body: "Vectors are built for the newest repositories, so semantic results improve as coverage grows.",
  },
];

/** Eager-lazy indexing, explained in the plainest words we have. */
export function HowItWorks() {
  return (
    <section
      className="mx-auto flex w-full max-w-3xl flex-col gap-4"
      aria-labelledby="how-indexing-works"
    >
      <h2 id="how-indexing-works" className="text-base font-semibold tracking-tight">
        How indexing works
      </h2>

      <ol className="grid gap-3 sm:grid-cols-3">
        {STEPS.map((step) => (
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

      <p className="text-xs leading-relaxed text-muted-foreground">
        Public stars only — nothing private is ever fetched or stored.
      </p>
    </section>
  );
}
