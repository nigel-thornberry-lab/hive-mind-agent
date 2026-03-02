#!/usr/bin/env node
/**
 * Creates a new PFTL bot wallet via the MCP server (setup mode) and saves the seed
 * to a secure file OUTSIDE the repo (never committed). Call from repo root after npm run build.
 */

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const SEED_FILE = join(homedir(), ".hivemind-bot-seed");
const MCP_SCRIPT = "dist/src/mcp-server-with-routing.js";

function send(obj) {
  return JSON.stringify(obj) + "\n";
}

async function main() {
  const cwd = process.cwd();
  const child = spawn("node", [MCP_SCRIPT], {
    cwd,
    env: { ...process.env, BOT_SEED: "", BOT_SEED_FILE: "" },
    stdio: ["pipe", "pipe", "inherit"],
  });

  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const nextLine = () => new Promise((resolve) => rl.once("line", resolve));

  child.stdin.write(send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "create-wallet-script", version: "0.1.0" } } }));
  await nextLine();
  child.stdin.write(send({ jsonrpc: "2.0", method: "notifications/initialized" }));
  child.stdin.write(send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "create_wallet", arguments: {} } }));

  let line;
  while ((line = await nextLine())) {
    try {
      const msg = JSON.parse(line);
      if (msg.id === 2 && msg.result?.content?.[0]?.text) {
        const text = msg.result.content[0].text;
        const data = JSON.parse(text);
        const seed = data.seed;
        const address = data.address;
        if (!seed || !address) {
          console.error("Unexpected create_wallet response:", text);
          process.exit(1);
        }
        writeFileSync(SEED_FILE, seed.trim() + "\n", "utf8");
        chmodSync(SEED_FILE, 0o600);
        console.log("Wallet created and seed saved securely.");
        console.log("Seed file:", SEED_FILE, "(mode 600, outside repo – never committed)");
        console.log("Address:", address);
        console.log("\nNext: Send at least 10 PFT to this address to activate, then run:");
        console.log("  export BOT_SEED_FILE=" + SEED_FILE);
        console.log("  npm run mcp:server");
        child.kill("SIGTERM");
        process.exit(0);
      }
      if (msg.error) {
        console.error("MCP error:", msg.error);
        child.kill("SIGTERM");
        process.exit(1);
      }
    } catch (_) {}
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
