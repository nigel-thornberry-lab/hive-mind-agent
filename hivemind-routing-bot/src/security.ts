import { statSync } from "node:fs";
import { resolve } from "node:path";

const REDACT = "[REDACTED]";

/** Redact seed or token-like strings from a string. */
export function redactSecrets(value: string): string {
  if (!value || typeof value !== "string") return value;
  return value
    .replace(/\bsEd[A-Za-z0-9]+/g, REDACT)
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, REDACT)
    .replace(/\bs[A-Za-z0-9]{29,}/g, REDACT);
}

/** Redact sensitive keys in an object (shallow). */
export function redactObject<T extends Record<string, unknown>>(obj: T): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const sensitive = new Set(["seed", "token", "jwt", "authorization", "bot_seed", "api_key"]);
  for (const [k, v] of Object.entries(obj)) {
    if (sensitive.has(k.toLowerCase())) {
      out[k] = REDACT;
    } else if (typeof v === "string") {
      out[k] = redactSecrets(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Enforce that BOT_SEED_FILE has restrictive permissions (e.g. 0o600).
 * Call after config load when using BOT_SEED_FILE.
 */
export function assertSeedFilePermissions(seedFilePath: string): void {
  const path = resolve(process.cwd(), seedFilePath);
  try {
    const st = statSync(path);
    const mode = st.mode & 0o777;
    // Allow 600 or 400 (owner only).
    if (mode !== 0o600 && mode !== 0o400) {
      console.warn(
        `[security] BOT_SEED_FILE should have permissions 600 or 400 (current: ${(mode).toString(8)}). Run: chmod 600 "${path}"`
      );
    }
  } catch {
    // File may not exist yet (e.g. first run before create_wallet).
  }
}
