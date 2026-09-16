/**
 * Landing / context-switcher helpers: accept a login, `@login`,
 * `github.com/login`, or a full profile URL (docs/08 §1.1).
 */

const LOGIN_RE = /^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}$/i;

export function parseLoginInput(raw: string): string | null {
  let value = raw.trim();

  if (!value) return null;
  value = value.replace(/^https?:\/\//i, "");
  value = value.replace(/^www\./i, "");
  value = value.replace(/^github\.com\//i, "");
  value = value.replace(/^@+/, "");
  const first = value.split(/[/?#\s]/)[0] ?? "";

  return LOGIN_RE.test(first) ? first : null;
}

export const SUGGESTED_USERS: ReadonlyArray<string> = ["sindresorhus", "torvalds"];
