export function SkeletonCard() {
  return (
    <article className="card card--skeleton" aria-hidden="true">
      <div className="skeleton skeleton--title" />
      <div className="skeleton skeleton--line" />
      <div className="skeleton skeleton--line skeleton--short" />
      <div className="skeleton skeleton--meta" />
    </article>
  );
}

export function SkeletonList({ count = 4 }: { count?: number }) {
  return (
    <div className="result-list" aria-hidden="true">
      {Array.from({ length: count }, (_, index) => (
        <SkeletonCard key={index} />
      ))}
    </div>
  );
}
