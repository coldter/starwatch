import { cn } from "@/lib/utils";

/** Neutral shimmer block used by every loading state. */
export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("animate-pulse rounded-md bg-muted", className)} aria-hidden="true" />;
}

/** Placeholder with the same anatomy as a result card, so nothing jumps on load. */
export function ResultSkeleton({ index = 0 }: { index?: number }) {
  return (
    <article
      className="rounded-2xl border border-border bg-card p-5"
      style={{ animationDelay: `${index * 80}ms` }}
      aria-hidden="true"
    >
      <div className="flex items-start gap-3">
        <Skeleton className="size-9 rounded-lg" />
        <div className="flex-1 space-y-2.5">
          <Skeleton className="h-4 w-2/5" />
          <Skeleton className="h-3.5 w-11/12" />
          <Skeleton className="h-3.5 w-3/5" />
          <div className="flex gap-2 pt-1">
            <Skeleton className="h-5 w-20 rounded-full" />
            <Skeleton className="h-5 w-16 rounded-full" />
            <Skeleton className="h-5 w-24 rounded-full" />
          </div>
        </div>
      </div>
    </article>
  );
}

export function ResultSkeletonList({ count = 4 }: { count?: number }) {
  return (
    <div className="flex flex-col gap-3" role="status" aria-label="Loading results">
      {Array.from({ length: count }, (_, index) => (
        <ResultSkeleton key={index} index={index} />
      ))}
    </div>
  );
}

/** Landing/user page hero placeholder. */
export function HeroSkeleton() {
  return (
    <div
      className="flex items-center gap-4 rounded-2xl border border-border bg-card p-5"
      aria-hidden="true"
    >
      <Skeleton className="size-14 rounded-full" />
      <div className="flex-1 space-y-2.5">
        <Skeleton className="h-5 w-1/3" />
        <Skeleton className="h-3.5 w-2/3" />
        <Skeleton className="h-5 w-40 rounded-full" />
      </div>
    </div>
  );
}
