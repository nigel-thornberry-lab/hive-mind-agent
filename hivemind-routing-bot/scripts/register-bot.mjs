#!/usr/bin/env node
/**
 * Calls register_bot on the MCP server so the agent appears at tasknode.postfiat.org/agents.
 * Run after funding the wallet with >= 10 PFT. Requires BOT_SEED_FILE in env or pass path.
 */

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { homedir } from "node:os";

const defaultSeedFile = join(homedir(), ".hivemind-bot-seed");
const seedFile = process.env.BOT_SEED_FILE || defaultSeedFile;
const MCP_SCRIPT = "dist/src/mcp-server-with-routing.js";

const REGISTER_PARAMS = {
  name: "Hive Mind Routing",
  description:
    "Need something done fast? Leverage the Post Fiat Hive Mind. Tell me what you need, and I'll return the top 3 members most likely to deliver - with confidence, trust context, and why they fit.",
  capabilities: ["routing", "member-matching", "text-generation"],
  commands: [
    {
      command: "/match",
      example: "/match I need help creating an NFT collection on chain",
      description: "Return top 3 ranked member matches with confidence and reasoning.",
      min_cost_drops: "5000000",
    },
  ],
  min_cost_first_message_drops: "5000000",
  url: "https://github.com/postfiatorg/pft-chatbot-mcp",
  icon_emoji: "🧠",
};

function send(obj) {
  return JSON.stringify(obj) + "\n";
}

async function main() {
  const cwd = process.cwd();
  const child = spawn("node", [MCP_SCRIPT], {
    cwd,
    env: { ...process.env, BOT_SEED_FILE: seedFile },
    stdio: ["pipe", "pipe", "inherit"],
  });

  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const nextLine = () => new Promise((resolve) => rl.once("line", resolve));

  child.stdin.write(send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "register-bot-script", version: "0.1.0" } } }));
  await nextLine();
  child.stdin.write(send({ jsonrpc: "2.0", method: "notifications/initialized" }));
  child.stdin.write(send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "register_bot", arguments: REGISTER_PARAMS } }));

  let line;
  while ((line = await nextLine())) {
    try {
      const msg = JSON.parse(line);
      if (msg.id === 2) {
        if (msg.result?.content?.[0]?.text) {
          const text = msg.result.content[0].text;
          if (msg.result.isError) {
            console.error("register_bot error:", text);
            child.kill("SIGTERM");
            process.exit(1);
          }
          console.log("register_bot response:", text);
          console.log("\nAgent is now registered. It should appear at https://tasknode.postfiat.org/agents");
          console.log("Keep the MCP server (or bot process) running so it keeps pinging and stays visible.");
        }
        if (msg.error) {
          console.error("MCP error:", msg.error);
          child.kill("SIGTERM");
          process.exit(1);
        }
        child.kill("SIGTERM");
        process.exit(0);
      }
    } catch (_) {}
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
