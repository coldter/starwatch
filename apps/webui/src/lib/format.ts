/**
 * Pure formatting helpers (no React, no DOM): numbers, dates, relative time.
 * Kept side-effect free so they stay unit-testable if vitest is added later.
 */

const compactFormatter = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});

const numberFormatter = new Intl.NumberFormat("en-US");

const dateFormatter = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "short",
  day: "numeric",
});

const dateTimeFormatter = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

/** `12400` → `12.4k`, `1500000` → `1.5M`, `842` → `842`. */
export function formatCompact(value: number): string {
  if (!Number.isFinite(value)) return "—";

  if (Math.abs(value) < 1000) return String(Math.round(value));

  return compactFormatter.format(value).replace("K", "k");
}

/** `12400` → `12,400`. */
export function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return "—";

  return numberFormatter.format(Math.round(value));
}

/** ISO timestamp → `3h ago` / `2d ago` / `never`. Tolerates future clocks. */
export function relativeTime(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return "never";
  const timestamp = Date.parse(iso);

  if (Number.isNaN(timestamp)) return "unknown";
  const seconds = Math.max(0, Math.round((now - timestamp) / 1000));

  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);

  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);

  if (hours < 48) return `${hours}h ago`;
  const days = Math.round(hours / 24);

  if (days < 30) return `${days}d ago`;
  const months = Math.round(days / 30);

  if (months < 12) return `${months}mo ago`;

  return `${Math.round(months / 12)}y ago`;
}

/** ISO timestamp → `Mar 4, 2021`. */
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const date = new Date(iso);

  if (Number.isNaN(date.getTime())) return "—";

  return dateFormatter.format(date);
}

/** ISO timestamp → `Mar 4, 2021, 3:12 PM` (used for title/tooltip text). */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "never";
  const date = new Date(iso);

  if (Number.isNaN(date.getTime())) return "unknown";

  return dateTimeFormatter.format(date);
}

/**
 * Semantic coverage can arrive as a 0..1 ratio or a 0..100 percentage.
 * Normalize defensively so the UI never prints `4200%`.
 */
export function coveragePercent(value: number | null | undefined): number {
  if (value === null || value === undefined || !Number.isFinite(value)) return 0;
  const percent = value <= 1 ? value * 100 : value;

  return Math.max(0, Math.min(100, Math.round(percent)));
}

/** `Math.round(100 * done / total)` clamped to 0..100 (0 when total is 0). */
export function percent(done: number, total: number): number {
  if (!Number.isFinite(done) || !Number.isFinite(total) || total <= 0) return 0;

  return Math.max(0, Math.min(100, Math.round((done / total) * 100)));
}
