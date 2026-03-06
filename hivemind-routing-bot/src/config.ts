import { readFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { homedir } from "node:os";

export interface BotConfig {
  /** Path to file containing bot wallet seed (recommended). Prefer over BOT_SEED. */
  botSeedFile: string | null;
  /** Inline seed (avoid in production; use BOT_SEED_FILE). */
  botSeed: string | null;
  /** Task Node base URL for member index fetches. */
  taskNodeUrl: string;
  /** JWT for Task Node API (member index). */
  taskNodeJwt: string | null;
  /** PFTL RPC URL (testnet default). */
  pftlRpcUrl: string;
  /** PFTL WSS URL (testnet default). */
  pftlWssUrl: string;
  /** Keystone gRPC URL. */
  keystoneGrpcUrl: string;
  /** Member index cache TTL in ms. */
  memberIndexTtlMs: number;
  /** Max operators to load for matching. */
  memberIndexLimit: number;
  /** Poll interval for scan_messages in ms. */
  scanIntervalMs: number;
  /** Path to persist idempotency cursor (since_ledger). Defaults to ~/.hivemind-bot-cursor. */
  cursorFilePath: string;
  /** Directory for persistent brief + seen-hash store. Defaults to ~/.hivemind-bot-store. */
  persistStorePath: string;
  /** Optional health server port (0 = disabled). */
  healthPort: number;
}

const DEFAULT_TASKNODE_URL = "https://tasknode.postfiat.org";
const DEFAULT_PFTL_RPC = "https://rpc.testnet.postfiat.org";
const DEFAULT_PFTL_WSS = "wss://ws.testnet.postfiat.org";
const DEFAULT_KEYSTONE_GRPC = "keystone-grpc.postfiat.org:443";

function env(name: string): string | undefined {
  return process.env[name];
}

function envNumber(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Load config from environment. Validates that bot identity is present
 * via BOT_SEED_FILE (preferred) or BOT_SEED. Does not read seed contents here.
 */
export function loadConfig(): BotConfig {
  const botSeedFile = env("BOT_SEED_FILE")?.trim() || null;
  const botSeed = env("BOT_SEED")?.trim() || null;

  if (!botSeedFile && !botSeed) {
    throw new Error(
      "Missing bot identity: set BOT_SEED_FILE (recommended) or BOT_SEED. Use a dedicated bot wallet, not your personal wallet."
    );
  }

  if (botSeedFile && botSeed) {
    throw new Error("Set only one of BOT_SEED_FILE or BOT_SEED, not both.");
  }

  return {
    botSeedFile,
    botSeed,
    taskNodeUrl: env("PFT_TASKNODE_URL")?.trim() || DEFAULT_TASKNODE_URL,
    taskNodeJwt: env("PFT_TASKNODE_JWT")?.trim() || null,
    pftlRpcUrl: env("PFTL_RPC_URL")?.trim() || DEFAULT_PFTL_RPC,
    pftlWssUrl: env("PFTL_WSS_URL")?.trim() || DEFAULT_PFTL_WSS,
    keystoneGrpcUrl: env("KEYSTONE_GRPC_URL")?.trim() || DEFAULT_KEYSTONE_GRPC,
    memberIndexTtlMs: envNumber("PFT_MEMBER_INDEX_TTL_MS", 300_000),
    memberIndexLimit: Math.max(1, Math.min(200, envNumber("PFT_MEMBER_INDEX_LIMIT", 40))),
    scanIntervalMs: Math.max(5_000, envNumber("PFT_SCAN_INTERVAL_MS", 30_000)),
    // Default to absolute home-dir paths so cursor + seenSet survive restarts
    // regardless of the working directory the bot is launched from.
    cursorFilePath: env("PFT_BOT_CURSOR_FILE")?.trim() || join(homedir(), ".hivemind-bot-cursor"),
    persistStorePath: env("PFT_BOT_PERSIST_STORE_PATH")?.trim() || join(homedir(), ".hivemind-bot-store"),
    healthPort: Math.max(0, envNumber("PFT_BOT_HEALTH_PORT", 0)),
  };
}

/**
 * Resolve bot seed from config. Prefers BOT_SEED_FILE and reads with minimal exposure.
 * Call only when needed for MCP child process env; do not log return value.
 */
export function resolveBotSeed(config: BotConfig): string {
  if (config.botSeed) return config.botSeed;
  if (!config.botSeedFile) throw new Error("BOT_SEED_FILE is not set.");
  const path = resolve(process.cwd(), config.botSeedFile);
  if (!existsSync(path)) throw new Error(`BOT_SEED_FILE not found: ${path}`);
  return readFileSync(path, "utf8").trim();
}
