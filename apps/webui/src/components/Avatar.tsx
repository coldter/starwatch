import { useEffect, useState } from "react";

export interface AvatarProps {
  login: string;
  name?: string | null;
  src?: string | null;
  size?: number;
}

/** GitHub CDN avatar with an initials fallback (docs/06 §8.6). */
export function Avatar({ login, name, src, size = 40 }: AvatarProps) {
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(false);
  }, [src]);

  if (src && !failed) {
    return (
      <img
        className="avatar"
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
      className="avatar avatar--fallback"
      style={{ width: size, height: size, fontSize: Math.round(size * 0.4) }}
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
  const second = parts.length > 1 ? parts[parts.length - 1]?.[0] : undefined;

  return `${first}${second ?? ""}`.toUpperCase();
}
