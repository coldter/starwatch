import type { ReactNode } from "react";
import { AlertTriangle, SearchX, type LucideIcon } from "lucide-react";
import { Button } from "@/components/motion/button/base";
import { cn } from "@/lib/utils";

/** The parts of an error the UI actually renders — satisfied by `ApiError` and `Error`. */
export interface DisplayError {
  message: string;
  detail?: string | null;
}

export interface StatePanelProps {
  icon?: LucideIcon;
  title: string;
  /** Heading level for the title — `h1` when the panel is the page content. */
  titleAs?: "h1" | "h2";
  body?: ReactNode;
  tone?: "default" | "error" | "muted";
  children?: ReactNode;
  className?: string;
}

/**
 * The one panel used for every "nothing to show" moment — empty, no results,
 * error, not indexed. Keeping a single anatomy (icon, title, body, actions)
 * means states never look like different products.
 */
export function StatePanel({
  icon: Icon = SearchX,
  title,
  titleAs: Title = "h2",
  body,
  tone = "default",
  children,
  className,
}: StatePanelProps) {
  return (
    <section
      className={cn(
        "mx-auto flex max-w-xl flex-col items-center gap-3 rounded-2xl border border-border bg-card px-6 py-10 text-center",
        tone === "error" && "border-destructive/30",
        className,
      )}
      role={tone === "error" ? "alert" : undefined}
    >
      <span
        className={cn(
          "grid size-11 place-items-center rounded-xl bg-accent text-accent-foreground",
          tone === "error" && "bg-destructive/10 text-destructive",
        )}
        aria-hidden="true"
      >
        <Icon className="size-5" />
      </span>
      <Title className="text-base font-semibold tracking-tight text-balance">{title}</Title>
      {body ? (
        <p className="max-w-md text-sm leading-relaxed text-muted-foreground">{body}</p>
      ) : null}
      {children ? (
        <div className="mt-1 flex flex-wrap items-center justify-center gap-2">{children}</div>
      ) : null}
    </section>
  );
}

export interface ErrorPanelProps {
  title: string;
  error: DisplayError;
  /** Heading level for the title — `h1` when the panel is the page content. */
  titleAs?: "h1" | "h2";
  onRetry?: () => void;
  children?: ReactNode;
}

/** A `StatePanel` that already knows how to show an API error. */
export function ErrorPanel({ title, error, titleAs, onRetry, children }: ErrorPanelProps) {
  const detail = error.detail;

  return (
    <StatePanel
      icon={AlertTriangle}
      tone="error"
      title={title}
      titleAs={titleAs}
      body={
        <>
          {error.message}
          {detail !== undefined && detail !== null && detail !== error.message ? (
            <span className="mt-1 block text-xs text-muted-foreground">{detail}</span>
          ) : null}
        </>
      }
    >
      {onRetry ? (
        <Button variant="outline" size="sm" onClick={onRetry}>
          Try again
        </Button>
      ) : null}
      {children}
    </StatePanel>
  );
}

/** A quiet inline strip for non-blocking notices (degraded search, stale data). */
export function NoticeStrip({
  icon: Icon,
  children,
  tone = "default",
  action,
}: {
  icon?: LucideIcon;
  children: ReactNode;
  tone?: "default" | "error";
  action?: ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-xl border border-border bg-muted/40 px-3.5 py-2.5 text-sm text-muted-foreground",
        tone === "error" && "border-destructive/30 bg-destructive/5 text-foreground",
      )}
      role={tone === "error" ? "alert" : "status"}
    >
      {Icon ? <Icon className="size-4 shrink-0" aria-hidden="true" /> : null}
      <span className="min-w-0 flex-1">{children}</span>
      {action}
    </div>
  );
}
