export interface GroupChipsProps {
  names: ReadonlyArray<string>;
  max?: number;
}

/** Read-only group/collection chips (docs/08 §4.4). */
export function GroupChips({ names, max = 3 }: GroupChipsProps) {
  if (names.length === 0) return null;
  const shown = names.slice(0, max);
  const extra = names.length - shown.length;

  return (
    <span className="chip-row">
      {shown.map((name) => (
        <span key={name} className="badge badge--group">
          {name}
        </span>
      ))}
      {extra > 0 ? (
        <span className="badge badge--group" title={names.join(", ")}>
          +{extra}
        </span>
      ) : null}
    </span>
  );
}
