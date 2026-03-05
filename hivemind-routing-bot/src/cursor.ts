/**
 * Cursor persistence for scan_messages idempotency.
 * Only persist after a full tick completes so replay is safe on crash.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";

export function readCursor(path: string): number | undefined {
  try {
    if (!existsSync(path)) return undefined;
    const s = readFileSync(path, "utf8").trim();
    const n = parseInt(s, 10);
    return Number.isFinite(n) ? n : undefined;
  } catch {
    return undefined;
  }
}

export function writeCursor(path: string, value: number): boolean {
  try {
    writeFileSync(path, String(value), "utf8");
    return true;
  } catch {
    return false;
  }
}
