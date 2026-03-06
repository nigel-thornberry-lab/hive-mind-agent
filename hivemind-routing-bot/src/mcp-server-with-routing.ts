#!/usr/bin/env node
/**
 * Extended MCP server: all tools from @postfiatorg/pft-chatbot-mcp plus Hive Mind match_members.
 * Run with: node dist/src/mcp-server-with-routing.js (or npm run mcp:server)
 * Requires: BOT_SEED or BOT_SEED_FILE (for chain tools), PFT_TASKNODE_JWT (for match_members).
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { homedir } from "node:os";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { MemberIndexCache } from "./member-index-cache.js";
import { runMemberMatchWithDataset } from "./match-adapter.js";
import type { BotConfig } from "./config.js";

const MATCH_MEMBERS_DESCRIPTION =
  "Find the best 3 Post Fiat members for your task from a normal sentence. Example: 'I need a React + TypeScript engineer to fix auth race conditions and ship this week.' Returns 3 ranked wallets with confidence and short reasoning.";

const matchMembersSchema = z.object({
  request_text: z.string().describe("Natural language task or skills request"),
  tags: z.array(z.string()).optional().describe("Optional skill tags"),
  top_k: z.number().min(1).max(3).optional().describe("Max results (default 3)"),
  refresh_index: z.boolean().optional().describe("Force refresh member index cache"),
});

async function main(): Promise<void> {
  if (!process.env.BOT_SEED && process.env.BOT_SEED_FILE) {
    const path = resolve(process.cwd(), process.env.BOT_SEED_FILE);
    if (existsSync(path)) process.env.BOT_SEED = readFileSync(path, "utf8").trim();
  }

  const pkg = await import("@postfiatorg/pft-chatbot-mcp/dist/version.js");
  const MCP_VERSION = (pkg as { MCP_VERSION?: string }).MCP_VERSION ?? "0.5.0";

  let chatbotConfig: unknown = null;
  let keypair: { address: string } | null = null;
  let grpcClient: { close?: () => void } | null = null;
  let stopPing: (() => void) | null = null;

  try {
    const { loadConfig: loadChatbotConfig } = await import("@postfiatorg/pft-chatbot-mcp/dist/config.js");
    const { deriveBotKeypair } = await import("@postfiatorg/pft-chatbot-mcp/dist/crypto/keys.js");
    const { KeystoneClient } = await import("@postfiatorg/pft-chatbot-mcp/dist/grpc/client.js");
    chatbotConfig = (loadChatbotConfig as () => unknown)();
    const cfg = chatbotConfig as { botSeed: string };
    keypair = await (deriveBotKeypair as (seed: string) => Promise<{ address: string }>)(cfg.botSeed);
    grpcClient = new (KeystoneClient as new (c: unknown) => { close?: () => void })(chatbotConfig);
  } catch {
    // Setup mode: no wallet, only create_wallet + match_members
  }

  const server = new McpServer({
    name: "hivemind-routing-bot",
    version: MCP_VERSION,
  });

  const [
    createWalletMod,
    scanMessagesMod,
    getMessageMod,
    sendMessageMod,
    registerBotMod,
    searchBotsMod,
    getBotMod,
    deleteBotMod,
    uploadContentMod,
    getAttachmentMod,
    getThreadMod,
    checkBalanceMod,
    sendPftMod,
    getWalletInfoMod,
    pingMod,
  ] = await Promise.all([
    import("@postfiatorg/pft-chatbot-mcp/dist/tools/create_wallet.js"),
    import("@postfiatorg/pft-chatbot-mcp/dist/tools/scan_messages.js"),
    import("@postfiatorg/pft-chatbot-mcp/dist/tools/get_message.js"),
    import("@postfiatorg/pft-chatbot-mcp/dist/tools/send_message.js"),
    import("@postfiatorg/pft-chatbot-mcp/dist/tools/register_bot.js"),
    import("@postfiatorg/pft-chatbot-mcp/dist/tools/search_bots.js"),
    import("@postfiatorg/pft-chatbot-mcp/dist/tools/get_bot.js"),
    import("@postfiatorg/pft-chatbot-mcp/dist/tools/delete_bot.js"),
    import("@postfiatorg/pft-chatbot-mcp/dist/tools/upload_content.js"),
    import("@postfiatorg/pft-chatbot-mcp/dist/tools/get_attachment.js"),
    import("@postfiatorg/pft-chatbot-mcp/dist/tools/get_thread.js"),
    import("@postfiatorg/pft-chatbot-mcp/dist/tools/check_balance.js"),
    import("@postfiatorg/pft-chatbot-mcp/dist/tools/send_pft.js"),
    import("@postfiatorg/pft-chatbot-mcp/dist/tools/get_wallet_info.js"),
    import("@postfiatorg/pft-chatbot-mcp/dist/tools/ping.js"),
  ]);

  const createWalletSchema = (createWalletMod as { createWalletSchema: unknown }).createWalletSchema;
  const executeCreateWallet = (createWalletMod as { executeCreateWallet: (p: unknown) => Promise<string> }).executeCreateWallet;
  const scanMessagesSchema = (scanMessagesMod as { scanMessagesSchema: { shape: unknown } }).scanMessagesSchema;
  const executeScanMessages = (scanMessagesMod as { executeScanMessages: (c: unknown, k: unknown, p: unknown) => Promise<string> }).executeScanMessages;
  const getMessageSchema = (getMessageMod as { getMessageSchema: { shape: unknown } }).getMessageSchema;
  const executeGetMessage = (getMessageMod as { executeGetMessage: (c: unknown, k: unknown, p: unknown) => Promise<string> }).executeGetMessage;
  const sendMessageSchema = (sendMessageMod as { sendMessageSchema: { shape: unknown } }).sendMessageSchema;
  const executeSendMessage = (sendMessageMod as { executeSendMessage: (c: unknown, k: unknown, g: unknown, p: unknown) => Promise<string> }).executeSendMessage;
  const registerBotSchema = (registerBotMod as { registerBotSchema: { shape: unknown } }).registerBotSchema;
  const executeRegisterBot = (registerBotMod as { executeRegisterBot: (c: unknown, k: unknown, g: unknown, p: unknown) => Promise<string> }).executeRegisterBot;
  const searchBotsSchema = (searchBotsMod as { searchBotsSchema: { shape: unknown } }).searchBotsSchema;
  const executeSearchBots = (searchBotsMod as { executeSearchBots: (c: unknown, g: unknown, p: unknown) => Promise<string> }).executeSearchBots;
  const getBotSchema = (getBotMod as { getBotSchema: { shape: unknown } }).getBotSchema;
  const executeGetBot = (getBotMod as { executeGetBot: (c: unknown, g: unknown, p: unknown) => Promise<string> }).executeGetBot;
  const executeDeleteBot = (deleteBotMod as { executeDeleteBot: (c: unknown, k: unknown, g: unknown) => Promise<string> }).executeDeleteBot;
  const uploadContentSchema = (uploadContentMod as { uploadContentSchema: { shape: unknown } }).uploadContentSchema;
  const executeUploadContent = (uploadContentMod as { executeUploadContent: (c: unknown, g: unknown, p: unknown, k: unknown) => Promise<string> }).executeUploadContent;
  const getAttachmentSchema = (getAttachmentMod as { getAttachmentSchema: { shape: unknown } }).getAttachmentSchema;
  const executeGetAttachment = (getAttachmentMod as { executeGetAttachment: (c: unknown, k: unknown, p: unknown) => Promise<string> }).executeGetAttachment;
  const getThreadSchema = (getThreadMod as { getThreadSchema: { shape: unknown } }).getThreadSchema;
  const executeGetThread = (getThreadMod as { executeGetThread: (c: unknown, k: unknown, p: unknown) => Promise<string> }).executeGetThread;
  const executeCheckBalance = (checkBalanceMod as { executeCheckBalance: (c: unknown, k: unknown) => Promise<string> }).executeCheckBalance;
  const sendPftSchema = (sendPftMod as { sendPftSchema: { shape: unknown } }).sendPftSchema;
  const executeSendPft = (sendPftMod as { executeSendPft: (c: unknown, k: unknown, p: unknown) => Promise<string> }).executeSendPft;
  const executeGetWalletInfo = (getWalletInfoMod as { executeGetWalletInfo: (c: unknown, k: unknown) => Promise<string> }).executeGetWalletInfo;
  const executePing = (pingMod as { executePing: (k: unknown, g: unknown) => Promise<string> }).executePing;

  // create_wallet always (use package Zod schema)
  (server as { tool: (a: string, b: string, c: unknown, d: (p: unknown) => Promise<unknown>) => void }).tool(
    "create_wallet",
    "Generate a new PFTL wallet locally. Returns the wallet address and seed. IMPORTANT: the wallet must receive a deposit of at least 10 PFT to be activated on-chain. Save the seed securely.",
    (createWalletSchema as { shape: unknown }).shape,
    async (params: unknown) => {
      try {
        const result = await executeCreateWallet(params);
        return { content: [{ type: "text", text: result }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${(err as Error).message}` }], isError: true };
      }
    }
  );

  // match_members (Hive Mind) – always available; use env for member index (no BOT_SEED required)
  const memberIndexConfig: BotConfig = {
    botSeedFile: null,
    botSeed: null,
    taskNodeUrl: process.env.PFT_TASKNODE_URL || "https://tasknode.postfiat.org",
    taskNodeJwt: process.env.PFT_TASKNODE_JWT?.trim() || null,
    pftlRpcUrl: process.env.PFTL_RPC_URL || "https://rpc.testnet.postfiat.org",
    pftlWssUrl: process.env.PFTL_WSS_URL || "wss://ws.testnet.postfiat.org",
    keystoneGrpcUrl: process.env.KEYSTONE_GRPC_URL || "keystone-grpc.postfiat.org:443",
    memberIndexTtlMs: Math.max(1000, Number(process.env.PFT_MEMBER_INDEX_TTL_MS) || 300_000),
    memberIndexLimit: Math.max(1, Math.min(200, Number(process.env.PFT_MEMBER_INDEX_LIMIT) || 40)),
    scanIntervalMs: 30_000,
    cursorFilePath: join(homedir(), ".hivemind-bot-cursor"),
    persistStorePath: join(homedir(), ".hivemind-bot-store"),
    healthPort: 0,
  };
  const cache = new MemberIndexCache({ config: memberIndexConfig });
  (server as { tool: (a: string, b: string, c: unknown, d: (p: unknown) => Promise<unknown>) => void }).tool(
    "match_members",
    MATCH_MEMBERS_DESCRIPTION,
    matchMembersSchema.shape,
    async (params: unknown) => {
      try {
        const p = params as Record<string, unknown>;
        const requestText = String(p?.request_text ?? "").trim();
        if (!requestText) {
          return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: "request_text is required" }) }], isError: true };
        }
        const dataset = await cache.getSnapshot({ forceRefresh: Boolean(p?.refresh_index) });
        const result = runMemberMatchWithDataset(
          {
            request_text: requestText,
            tags: Array.isArray(p?.tags) ? (p.tags as string[]) : undefined,
            top_k: typeof p?.top_k === "number" ? p.top_k : 3,
          },
          dataset
        );
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${(err as Error).message}` }], isError: true };
      }
    }
  );

  const register = (server as { tool: (a: string, b: string, c: unknown, d: (p: unknown) => Promise<unknown>) => void }).tool.bind(server);
  if (chatbotConfig && keypair && grpcClient) {
    const config = chatbotConfig as Record<string, unknown>;
    register("scan_messages", "Scan the bot's PFTL wallet for recent incoming messages.", (scanMessagesSchema as { shape: unknown }).shape, async (params: unknown) => {
      try {
        const result = await executeScanMessages(config, keypair, params);
        return { content: [{ type: "text", text: result }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${(err as Error).message}` }], isError: true };
      }
    });
    register("get_message", "Fetch and decrypt a specific message by tx_hash or CID.", (getMessageSchema as { shape: unknown }).shape, async (params: unknown) => {
      try {
        const result = await executeGetMessage(config, keypair, params);
        return { content: [{ type: "text", text: result }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${(err as Error).message}` }], isError: true };
      }
    });
    register("send_message", "Send an encrypted message to a PFTL address.", (sendMessageSchema as { shape: unknown }).shape, async (params: unknown) => {
      try {
        const result = await executeSendMessage(config, keypair, grpcClient, params);
        return { content: [{ type: "text", text: result }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${(err as Error).message}` }], isError: true };
      }
    });
    register("register_bot", "Register or update this bot in the Keystone agent registry.", (registerBotSchema as { shape: unknown }).shape, async (params: unknown) => {
      try {
        const result = await executeRegisterBot(config, keypair, grpcClient, params);
        return { content: [{ type: "text", text: result }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${(err as Error).message}` }], isError: true };
      }
    });
    register("search_bots", "Search the Keystone agent registry.", (searchBotsSchema as { shape: unknown }).shape, async (params: unknown) => {
      try {
        const result = await executeSearchBots(config, grpcClient, params);
        return { content: [{ type: "text", text: result }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${(err as Error).message}` }], isError: true };
      }
    });
    register("get_bot", "Get a registered bot's full details.", (getBotSchema as { shape: unknown }).shape, async (params: unknown) => {
      try {
        const result = await executeGetBot(config, grpcClient, params);
        return { content: [{ type: "text", text: result }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${(err as Error).message}` }], isError: true };
      }
    });
    register("delete_bot", "Delete this bot's registration.", {}, async () => {
      try {
        const result = await executeDeleteBot(config, keypair, grpcClient);
        return { content: [{ type: "text", text: result }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${(err as Error).message}` }], isError: true };
      }
    });
    register("upload_content", "Upload content to IPFS via Keystone.", (uploadContentSchema as { shape: unknown }).shape, async (params: unknown) => {
      try {
        const result = await executeUploadContent(config, grpcClient, params, keypair);
        return { content: [{ type: "text", text: result }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${(err as Error).message}` }], isError: true };
      }
    });
    register("get_attachment", "Fetch an attachment from IPFS by CID.", (getAttachmentSchema as { shape: unknown }).shape, async (params: unknown) => {
      try {
        const result = await executeGetAttachment(config, keypair, params);
        return { content: [{ type: "text", text: result }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${(err as Error).message}` }], isError: true };
      }
    });
    register("get_thread", "Get all messages in a thread.", (getThreadSchema as { shape: unknown }).shape, async (params: unknown) => {
      try {
        const result = await executeGetThread(config, keypair, params);
        return { content: [{ type: "text", text: result }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${(err as Error).message}` }], isError: true };
      }
    });
    register("check_balance", "Check the bot's wallet balance.", {}, async () => {
      try {
        const result = await executeCheckBalance(config, keypair);
        return { content: [{ type: "text", text: result }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${(err as Error).message}` }], isError: true };
      }
    });
    register("send_pft", "Send PFT to an address.", (sendPftSchema as { shape: unknown }).shape, async (params: unknown) => {
      try {
        const result = await executeSendPft(config, keypair, params);
        return { content: [{ type: "text", text: result }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${(err as Error).message}` }], isError: true };
      }
    });
    register("get_wallet_info", "Return the bot's wallet address and keys.", {}, async () => {
      try {
        const result = await executeGetWalletInfo(config, keypair);
        return { content: [{ type: "text", text: result }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${(err as Error).message}` }], isError: true };
      }
    });
    register("ping", "Send a liveness heartbeat to Keystone.", {}, async () => {
      try {
        const result = await executePing(keypair, grpcClient);
        return { content: [{ type: "text", text: result }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${(err as Error).message}` }], isError: true };
      }
    });
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);

  if (chatbotConfig && grpcClient) {
    const { startPingInterval } = await import("@postfiatorg/pft-chatbot-mcp/dist/liveness/ping.js");
    const config = chatbotConfig as { keystoneApiKey?: string; pingIntervalMs?: number };
    const intervalMs = config.pingIntervalMs ?? 900_000;
    if (config.keystoneApiKey && intervalMs > 0) {
      stopPing = (startPingInterval as (g: unknown, ms: number) => () => void)(grpcClient, intervalMs);
    }
  }

  const shutdown = (): void => {
    stopPing?.();
    grpcClient?.close?.();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  process.stderr.write(`hivemind-routing-bot MCP server (with match_members) v${MCP_VERSION}\n`);
  if (keypair) {
    process.stderr.write(`Wallet: ${keypair.address}\n`);
  } else {
    process.stderr.write("Setup mode: only create_wallet and match_members available. Set BOT_SEED or BOT_SEED_FILE for full tools.\n");
  }
  process.stderr.write("Routing tool: match_members (set PFT_TASKNODE_JWT for live member index).\n");
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${(err as Error).message}\n`);
  process.exit(1);
});
