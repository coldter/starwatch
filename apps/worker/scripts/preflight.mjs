/**
 * Credential preflight for `alchemy dev | plan | deploy | destroy`.
 *
 * Alchemy needs a Cloudflare provider account before it can open a stack
 * session. Without one it fails deep in its session code with a wall of
 * Effect stack traces — this turns that into a two-line fix.
 *
 * Passes when either:
 *   - env credentials are present (CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID,
 *     or the legacy CLOUDFLARE_API_KEY + CLOUDFLARE_EMAIL), or
 *   - an Alchemy auth profile exists (`~/.alchemy`).
 *
 * Set STARWATCH_SKIP_PREFLIGHT=1 to bypass (e.g. in CI where credentials are
 * injected later).
 */
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const skip = process.env.STARWATCH_SKIP_PREFLIGHT === "1";
const hasEnvCredentials =
  (Boolean(process.env.CLOUDFLARE_API_TOKEN) && Boolean(process.env.CLOUDFLARE_ACCOUNT_ID)) ||
  (Boolean(process.env.CLOUDFLARE_API_KEY) && Boolean(process.env.CLOUDFLARE_EMAIL));

/** `alchemy profile create` leaves an empty profile dir; configured = non-empty. */
const profile = process.env.ALCHEMY_PROFILE ?? "default";
const profileDir = join(homedir(), ".alchemy", "profiles", profile);
const hasProfile = (() => {
  try {
    return existsSync(profileDir) && readdirSync(profileDir).length > 0;
  } catch {
    return false;
  }
})();

if (skip || hasEnvCredentials || hasProfile) {
  process.exit(0);
}

console.error(`
✗ starwatch: Cloudflare credentials are not configured yet.

  \`alchemy dev\` needs an account because Workers AI and the rate-limit
  bindings run live even locally (D1/R2/Queues/Workflows are emulated).

  Option A — interactive (recommended):
    pnpm --filter @starwatch/worker exec alchemy profile create default
    pnpm --filter @starwatch/worker exec alchemy profile edit

  Option B — environment variables:
    cp apps/worker/.env.example apps/worker/.env
    # then set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN

  Then run \`pnpm dev\` again. (Set STARWATCH_SKIP_PREFLIGHT=1 to bypass this check.)
`);
process.exit(1);
