import { useState } from "react";
import { cn } from "@/lib/utils";

export interface AvatarProps {
  login: string;
  name?: string | null;
  src?: string | null;
  /** Rendered square size in px. */
  size?: number;
  className?: string;
}

/**
 * GitHub CDN avatar with an initials fallback. `referrerPolicy` is set to
 * `no-referrer` because GitHub's CDN rejects requests that leak the host, and
 * broken images fall back to initials instead of a browser placeholder.
 */
export function Avatar({ login, name, src, size = 40, className }: AvatarProps) {
  const [failed, setFailed] = useState(false);

  if (src && !failed) {
    return (
      <img
        className={cn("shrink-0 rounded-full object-cover ring-1 ring-border", className)}
        src={src}
        alt=""
        width={size}
        height={size}
        loading="lazy"
        decoding="async"
        referrerPolicy="no-referrer"
        onError={() => setFailed(true)}
      />
    );
  }

  return (
    <span
      className={cn(
        "grid shrink-0 place-items-center rounded-full bg-linear-to-br from-primary/25 to-star/25 font-semibold text-foreground ring-1 ring-border select-none",
        className,
      )}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.38) }}
      aria-hidden="true"
    >
      {initialsFor(name, login)}
    </span>
  );
}

function initialsFor(name: string | null | undefined, login: string): string {
  const source = (name ?? login).trim();
  const parts = source.split(/[\s_-]+/).filter(Boolean);
  const first = parts[0]?.[0] ?? "?";
  const last = parts.length > 1 ? parts[parts.length - 1]?.[0] : undefined;

  return `${first}${last ?? ""}`.toUpperCase();
}
