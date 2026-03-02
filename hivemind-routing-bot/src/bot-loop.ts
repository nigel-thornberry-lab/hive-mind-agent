#!/usr/bin/env node
/**
 * Hive Mind Routing Bot: chain-listening loop that responds to routing requests with top-3 member matches.
 * Uses @postfiatorg/pft-chatbot-mcp for scan_messages, get_message, send_message; runs matching locally.
 */

import { resolve } from "node:path";
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { createServer } from "node:http";
import { loadConfig, resolveBotSeed } from "./config.js";
import { assertSeedFilePermissions, redactSecrets } from "./security.js";
import { MemberIndexCache } from "./member-index-cache.js";
import { runMemberMatchWithDataset } from "./match-adapter.js";
import { McpStdioClient } from "./mcp-stdio-client.js";
import {
  InMemoryBriefStore,
  finalizeRankedBrief,
  startOrContinueMatchBrief,
} from "./conversation-state-machine.js";
import type { MatchBrief, RankedCandidate } from "./match-brief.js";
import { getQuestionPromptById } from "./question-policy.js";
import { defaultLogger, generateRequestId } from "./logger.js";

const PFT_CHATBOT_MCP_PATH = resolve(process.cwd(), "node_modules/@postfiatorg/pft-chatbot-mcp/dist/index.js");

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000;
const MAX_SEEN_TX_HASHES = 5000;
const BOT_LOCK_FILE = ".hivemind-bot-loop.lock";

async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  let last: Error | null = null;
  for (let i = 0; i < MAX_RETRIES; i++) {
    try {
      return await fn();
    } catch (err) {
      last = err instanceof Error ? err : new Error(String(err));
      if (i < MAX_RETRIES - 1) {
        const delay = RETRY_DELAY_MS * Math.pow(2, i);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  throw last;
}

function readCursor(path: string): number | undefined {
  try {
    if (!existsSync(path)) return undefined;
    const s = readFileSync(path, "utf8").trim();
    const n = parseInt(s, 10);
    return Number.isFinite(n) ? n : undefined;
  } catch {
    return undefined;
  }
}

function writeCursor(path: string, value: number): void {
  try {
    writeFileSync(path, String(value), "utf8");
  } catch (err) {
    console.error("[bot] Failed to write cursor file:", redactSecrets((err as Error).message));
  }
}

function acquireSingleInstanceLock(lockPath: string): void {
  if (!existsSync(lockPath)) {
    writeFileSync(lockPath, String(process.pid), { encoding: "utf8", flag: "wx" });
    return;
  }
  const existing = readFileSync(lockPath, "utf8").trim();
  const existingPid = Number(existing);
  if (Number.isFinite(existingPid)) {
    try {
      process.kill(existingPid, 0);
      throw new Error(`Another bot-loop process is already running (pid ${existingPid}).`);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ESRCH") throw err;
      // stale lock file from a dead process
    }
  }
  try {
    unlinkSync(lockPath);
  } catch {}
  writeFileSync(lockPath, String(process.pid), { encoding: "utf8", flag: "wx" });
}

function parseScanResult(text: string): { messages?: Array<{ tx_hash?: string; sender?: string; direction?: string }>; next_cursor?: number } {
  try {
    return JSON.parse(text) as { messages?: Array<{ tx_hash?: string; sender?: string; direction?: string }>; next_cursor?: number };
  } catch {
    return {};
  }
}

function parseGetMessageResult(text: string): { message?: string; sender?: string } {
  try {
    return JSON.parse(text) as { message?: string; sender?: string };
  } catch {
    return {};
  }
}

/** Route only /match requests to enforce paid command UX in clients. */
type ParsedCommand =
  | { action: "match"; request_text: string; tags?: string[] }
  | { action: "followup"; text: string }
  | { action: "help" };

function parseRoutingRequest(body: string, hasActiveBrief: boolean): ParsedCommand | null {
  const trimmed = body?.trim() || "";
  if (!trimmed) return null;

  // Command mode (required): /match <free text request>
  if (trimmed.startsWith("/match")) {
    const requestText = trimmed.replace(/^\/match\s*/i, "").trim();
    return { action: "match", request_text: requestText };
  }
  // Optional JSON command mode for programmatic callers:
  // {"command":"/match","request_text":"...","tags":["..."]}
  try {
    const obj = JSON.parse(trimmed) as Record<string, unknown>;
    const command = String(obj?.command ?? "").trim().toLowerCase();
    if (
      obj &&
      command === "/match" &&
      (typeof obj.request_text === "string" || typeof obj.user_request_text === "string" || Array.isArray(obj.tags))
    ) {
      return {
        action: "match",
        request_text: ((obj.request_text as string) ?? (obj.user_request_text as string) ?? "").trim(),
        tags: Array.isArray(obj.tags) ? (obj.tags as string[]) : undefined,
      };
    }
  } catch {
    // not JSON
  }
  // Allow normal follow-up answers only while an active brief exists.
  if (hasActiveBrief) return { action: "followup", text: trimmed };

  // Ignore non-command messages when no active brief exists.
  return null;
}

function shortWallet(value: string): string {
  if (!value || value.length < 12) return value || "Unknown";
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

function deriveRiskLines(match: {
  sybil_risk?: string | null;
  alignment_score?: number | null;
  confidence?: number;
}): string[] {
  const risks: string[] = [];
  const sybil = (match.sybil_risk ?? "").toLowerCase();
  const alignment = Number(match.alignment_score ?? 0);
  const confidence = Number(match.confidence ?? 0);

  if (sybil.includes("high") || sybil.includes("elevated")) {
    risks.push(`Trust signal: ${match.sybil_risk ?? "elevated risk"}`);
  } else if (sybil.includes("moderate")) {
    risks.push("Trust signal: moderate; validate recent work before committing.");
  }

  if (alignment > 0 && alignment < 60) {
    risks.push(`Alignment score is lower (${alignment}); scope tightly and set milestones.`);
  }

  if (confidence < 0.35) {
    risks.push("Lower confidence match; ask for relevant portfolio examples first.");
  }

  if (risks.length === 0) {
    risks.push("No major risk flags from available trust/activity signals.");
  }
  return risks;
}

interface CardMatch {
  rank: number;
  operator_id?: string;
  wallet_address?: string;
  confidence?: number;
  reasoning?: string;
  matched_expert_domains?: string[];
  sybil_risk?: string | null;
  alignment_score?: number | null;
  summary?: string | null;
  capability_highlights?: string[];
  activity_level?: string;
}

function formatTop3Reply(
  matchResult: {
    request_text?: string;
    top_matches: CardMatch[];
  },
  operatorMeta: Map<string, { walletLabel?: string; summary?: string; capabilities?: string[] }>
): string {
  if (!matchResult.top_matches || matchResult.top_matches.length === 0) {
    return [
      "I couldn't find strong matches for this request yet.",
      "Try adding a must-have skill, timeline, or budget and run /match again.",
    ].join("\n");
  }

  const lines: string[] = [
    `Here are your top ${matchResult.top_matches.length} matches:`,
  ];
  for (const m of matchResult.top_matches) {
    const wallet = m.wallet_address ?? m.operator_id ?? "Unknown";
    const meta = operatorMeta.get(wallet);
    const nameOrWallet = meta?.walletLabel?.trim() || shortWallet(wallet);
    const percent = Math.round((m.confidence ?? 0) * 100);
    const matched = (m.matched_expert_domains ?? []).filter(Boolean).slice(0, 3);

    const whyLine = m.reasoning && !m.reasoning.startsWith("Semantic fit")
      ? m.reasoning
      : matched.length > 0
        ? `Proven expertise in ${matched.join(", ")}.`
        : "Profile signals align with your request.";

    const capLines = (m.capability_highlights ?? meta?.capabilities ?? [])
      .filter(Boolean)
      .slice(0, 2);

    const riskLines = deriveRiskLines(m);
    const openChatLink = buildTaskNodeChatLink(wallet);
    const actLine = m.activity_level && m.activity_level.includes("active")
      ? `Activity: ${m.activity_level}`
      : null;

    lines.push(
      [
        `==== MATCH ${m.rank} ====`,
        `${nameOrWallet} (${wallet})`,
        `Match: ${percent}%`,
        `Why: ${whyLine}`,
        "Signals:",
        ...(matched.length > 0 ? matched.map((s) => `  - ${s}`) : ["  - General profile alignment"]),
        ...(capLines.length > 0 ? capLines.map((c) => `  - ${c}`) : []),
        actLine,
        "Risk:",
        ...riskLines.map((r) => `  - ${r}`),
        `Open chat: ${openChatLink}`,
      ]
        .filter(Boolean)
        .join("\n")
    );
    lines.push("");
  }
  lines.push("Reply with a wallet address or name to learn more, or run /match again to refine.");
  return lines.join("\n");
}

function buildTaskNodeChatLink(wallet: string): string {
  const template = process.env.PFT_TASKNODE_CHAT_URL_TEMPLATE?.trim() || "";
  if (template.includes("{wallet}")) return template.replaceAll("{wallet}", encodeURIComponent(wallet));
  return `https://tasknode.postfiat.org/inbox?address=${encodeURIComponent(wallet)}`;
}

function formatHelpReply(): string {
  return [
    "Use /match to run routing.",
    "Example:",
    "/match I need help creating an NFT collection on-chain and shipping metadata this week",
    "",
    "After /match, reply naturally to any clarifying question (or say: run now).",
    "This command is priced at 5 PFT.",
  ].join("\n");
}

function formatClarifier(prompt: string): string {
  return [
    "Quick question before ranking:",
    prompt,
    "",
    "Reply in one message, or say: run now",
  ].join("\n");
}

function formatPendingQuestionReminder(prompt: string): string {
  return [
    "Please answer the current question before starting a new /match request.",
    "",
    `Pending question: ${prompt}`,
    "",
    "Reply in one message, or say: run now",
  ].join("\n");
}

function buildRequestTextFromBrief(brief: MatchBrief): string {
  const parts = [
    brief.objective ?? "",
    brief.deliverable ? `Deliverable: ${brief.deliverable}` : "",
    brief.must_have_skills.length ? `Must-have: ${brief.must_have_skills.join(", ")}` : "",
    brief.nice_to_have_skills.length ? `Nice-to-have: ${brief.nice_to_have_skills.join(", ")}` : "",
    brief.urgency !== "unknown" ? `Urgency: ${brief.urgency}` : "",
    brief.budget_pft != null ? `Budget: ${brief.budget_pft} PFT` : "",
    brief.budget_band !== "unknown" ? `Budget band: ${brief.budget_band}` : "",
  ].filter(Boolean);
  return parts.join("\n").trim();
}

async function main(): Promise<void> {
  const config = loadConfig();
  if (config.botSeedFile) assertSeedFilePermissions(config.botSeedFile);
  const log = defaultLogger;
  if (!config.taskNodeJwt) {
    log.warn("PFT_TASKNODE_JWT is not set. Matching will fail; only fallback help replies will be sent.");
  }
  const lockFilePath = resolve(process.cwd(), BOT_LOCK_FILE);
  acquireSingleInstanceLock(lockFilePath);

  const botSeed = resolveBotSeed(config);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    BOT_SEED: botSeed,
    BOT_SEED_FILE: "", // prefer inline so child does not need file path
    PFTL_RPC_URL: config.pftlRpcUrl,
    PFTL_WSS_URL: config.pftlWssUrl,
    KEYSTONE_GRPC_URL: config.keystoneGrpcUrl,
  };
  delete env.BOT_SEED_FILE; // force child to use BOT_SEED

  let lastCacheStatus: "hit" | "miss" | "stale" = "miss";

  const cache = new MemberIndexCache({
    config,
    onCacheEvent: (type, detail) => {
      if (type === "hit") lastCacheStatus = "hit";
      else if (type === "stale_serve") lastCacheStatus = "stale";
      else if (type === "miss") lastCacheStatus = "miss";
      log.cache(
        type === "stale_serve" ? "cache_stale_serve"
          : type === "error" ? "cache_error"
          : type === "refresh" ? "cache_refresh"
          : "cache_hit",
        detail
      );
    },
  });
  const mcp = new McpStdioClient("node", [PFT_CHATBOT_MCP_PATH], env);

  await mcp.connect();
  log.info("MCP connected; starting scan loop.");

  const cursorFilePath = config.cursorFilePath ? resolve(process.cwd(), config.cursorFilePath) : null;
  let cursor: number | undefined = cursorFilePath ? readCursor(cursorFilePath) : undefined;
  const scanIntervalMs = config.scanIntervalMs;
  let ready = false;
  let tickInFlight = false;
  const seenTxHashes = new Set<string>();
  const seenQueue: string[] = [];
  const briefStore = new InMemoryBriefStore();
  cache.getSnapshot({ forceRefresh: false }).then(() => { ready = true; }).catch(() => {});

  const markSeen = (txHash: string): void => {
    if (seenTxHashes.has(txHash)) return;
    seenTxHashes.add(txHash);
    seenQueue.push(txHash);
    if (seenQueue.length > MAX_SEEN_TX_HASHES) {
      const oldest = seenQueue.shift();
      if (oldest) seenTxHashes.delete(oldest);
    }
  };

  const tick = async (): Promise<void> => {
    if (tickInFlight) return;
    tickInFlight = true;
    try {
      const scanParams: Record<string, unknown> = { limit: 50, direction: "inbound" };
      if (cursor != null) scanParams.since_ledger = cursor;

      const scanText = await withRetry(() => mcp.callTool("scan_messages", scanParams));
      const scan = parseScanResult(scanText);
      if (scan.next_cursor != null) {
        cursor = scan.next_cursor;
        if (cursorFilePath) writeCursor(cursorFilePath, cursor);
      }

      const messages = scan.messages ?? [];
      for (const msg of messages) {
        if (msg.direction !== "inbound" || !msg.tx_hash || !msg.sender) continue;
        if (seenTxHashes.has(msg.tx_hash)) continue;
        const requestId = generateRequestId();
        try {
          const getText = await withRetry(() => mcp.callTool("get_message", { tx_hash: msg.tx_hash }));
          const get = parseGetMessageResult(getText);
          const body = get.message ?? "";
          const existingBrief = briefStore.get(msg.sender);
          const hasActiveFollowup =
            Boolean(existingBrief) &&
            (existingBrief?.stage === "clarifying" || existingBrief?.stage === "ready");
          const request = parseRoutingRequest(body, hasActiveFollowup);
          if (!request) {
            markSeen(msg.tx_hash);
            continue;
          }
          if (request.action === "help") {
            await withRetry(() =>
              mcp.callTool("send_message", {
                recipient: msg.sender,
                message: formatHelpReply(),
                reply_to_tx: msg.tx_hash,
              })
            );
            markSeen(msg.tx_hash);
            continue;
          }

          if (
            request.action === "match" &&
            existingBrief?.stage === "clarifying" &&
            !request.request_text.trim()
          ) {
            const pendingPrompt =
              getQuestionPromptById(existingBrief.last_question_id) ??
              "Please provide one more detail to continue.";
            await withRetry(() =>
              mcp.callTool("send_message", {
                recipient: msg.sender,
                message: formatPendingQuestionReminder(pendingPrompt),
                reply_to_tx: msg.tx_hash,
              })
            );
            markSeen(msg.tx_hash);
            continue;
          }

          const userText =
            request.action === "match"
              ? request.request_text
              : request.text;
          const isFollowup = request.action === "followup";
          const isRunNow = isFollowup && /\brun now\b/i.test(userText);
          const briefForThisTurn =
            request.action === "match"
              ? null
              : existingBrief;

          if (request.action === "match") {
            briefStore.recordBriefStarted();
          }
          if (isFollowup && existingBrief?.stage === "clarifying") {
            if (isRunNow) {
              briefStore.recordRunNowSkip();
            } else {
              briefStore.recordQuestionAnswered();
            }
          }

          const action = startOrContinueMatchBrief({
            requester_wallet: msg.sender,
            conversation_id: msg.sender,
            text: userText,
            existing_brief: briefForThisTurn,
          });

          log.matchRequest({
            request_id: requestId,
            sender: msg.sender,
            action: request.action as "match" | "followup" | "help",
            text_length: userText.length,
            brief_stage: action.brief.stage,
            brief_confidence: action.brief.brief_confidence,
          });

          if (action.type === "ask") {
            briefStore.set(msg.sender, action.brief);
            briefStore.recordQuestionAsked();
            log.clarification("clarification_asked", {
              request_id: requestId,
              sender: msg.sender,
              question_id: action.question_id,
              questions_asked: action.brief.questions_asked,
              brief_confidence: action.brief.brief_confidence,
            });
            await withRetry(() =>
              mcp.callTool("send_message", {
                recipient: msg.sender,
                message: formatClarifier(action.prompt),
                reply_to_tx: msg.tx_hash,
              })
            );
            markSeen(msg.tx_hash);
            continue;
          }

          if (action.type === "close") {
            briefStore.delete(msg.sender);
            briefStore.recordClosed();
            log.briefLifecycle("brief_closed", {
              request_id: requestId,
              sender: msg.sender,
              questions_answered: action.brief.questions_asked,
              brief_confidence: action.brief.brief_confidence,
            });
            await withRetry(() =>
              mcp.callTool("send_message", {
                recipient: msg.sender,
                message: "Match request closed. Send /match when you want to start again.",
                reply_to_tx: msg.tx_hash,
              })
            );
            markSeen(msg.tx_hash);
            continue;
          }

          if (action.type === "noop") {
            briefStore.set(msg.sender, action.brief);
            markSeen(msg.tx_hash);
            continue;
          }

          const matchT0 = Date.now();
          lastCacheStatus = "miss";
          const dataset = await cache.getSnapshot({ forceRefresh: false });
          if (!ready) ready = true;
          const requestText = buildRequestTextFromBrief(action.brief);
          const matchResult = runMemberMatchWithDataset(
            {
              request_text: requestText || userText,
              tags: action.brief.must_have_skills.length > 0 ? action.brief.must_have_skills : action.brief.domain,
            },
            dataset
          );
          const matchLatency = Date.now() - matchT0;

          briefStore.recordRanked(action.provisional);
          log.matchResult({
            request_id: requestId,
            sender: msg.sender,
            match_count: matchResult.top_matches.length,
            top_score: matchResult.top_matches[0]?.overall_match_score ?? 0,
            top_confidence: matchResult.top_matches[0]?.confidence ?? 0,
            provisional: action.provisional,
            latency_ms: matchLatency,
            cache_status: lastCacheStatus,
          });

          const operatorMeta = new Map<string, { walletLabel?: string; summary?: string; capabilities?: string[] }>();
          for (const op of dataset.operator_profiles ?? []) {
            if (!op.wallet_address) continue;
            operatorMeta.set(op.wallet_address, {
              walletLabel: op.wallet_label ?? undefined,
              summary: (op.summary as string) ?? undefined,
              capabilities: (Array.isArray(op.capabilities) ? op.capabilities as string[] : []).slice(0, 2),
            });
          }
          const header = action.provisional ? "Provisional matches (share one more detail to improve quality):\n\n" : "";
          const reply = `${header}${formatTop3Reply(matchResult, operatorMeta)}`.trim();
          await withRetry(() =>
            mcp.callTool("send_message", {
              recipient: msg.sender,
              message: reply,
              reply_to_tx: msg.tx_hash,
            })
          );
          const rankedCandidates: RankedCandidate[] = matchResult.top_matches.map((m) => ({
            rank: m.rank,
            operator_id: m.operator_id ?? "",
            wallet_address: m.wallet_address ?? "",
            score: m.overall_match_score ?? 0,
            confidence: m.confidence ?? 0,
            factors: {},
            why: m.reasoning ?? "",
            risk_flags: [],
            open_chat_link: buildTaskNodeChatLink(m.wallet_address ?? m.operator_id ?? ""),
          }));
          const finalized = finalizeRankedBrief(action.brief, rankedCandidates, action.provisional);
          briefStore.set(msg.sender, finalized);
          markSeen(msg.tx_hash);
          log.briefLifecycle("brief_ranked", {
            request_id: requestId,
            sender: msg.sender,
            questions_answered: action.brief.questions_asked,
            brief_confidence: action.brief.brief_confidence,
          });
        } catch (err) {
          const errMsg = redactSecrets((err as Error).message);
          log.error(errMsg, `message ${msg.tx_hash}`, requestId);
          try {
            await withRetry(() =>
              mcp.callTool("send_message", {
                recipient: msg.sender,
                message: formatHelpReply(),
                reply_to_tx: msg.tx_hash,
              })
            );
            markSeen(msg.tx_hash);
          } catch (sendErr) {
            log.error(redactSecrets((sendErr as Error).message), "fallback_help_reply", requestId);
          }
        }
      }
    } catch (err) {
      log.error(redactSecrets((err as Error).message), "scan_tick");
    } finally {
      tickInFlight = false;
    }
  };

  if (config.healthPort > 0) {
    const server = createServer((req, res) => {
      const url = req.url?.split("?")[0] ?? "";
      if (url === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok" }));
        return;
      }
      if (url === "/ready") {
        res.writeHead(ready ? 200 : 503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ready }));
        return;
      }
      if (url === "/stats") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          cache: cache.stats,
          funnel: briefStore.funnel,
          active_briefs: briefStore.size,
        }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    server.listen(config.healthPort, () => {
      log.info(`Health server on port ${config.healthPort}`);
    });
  }

  await tick();
  const intervalId = setInterval(tick, scanIntervalMs);
  const sweepIntervalId = setInterval(() => {
    const removed = briefStore.sweep();
    if (removed > 0) log.info(`Swept ${removed} expired brief(s). Store size: ${briefStore.size}`);
  }, 5 * 60 * 1000);

  const shutdown = (): void => {
    clearInterval(intervalId);
    clearInterval(sweepIntervalId);
    mcp.disconnect();
    try {
      unlinkSync(lockFilePath);
    } catch {}
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("[bot] Fatal:", err);
  process.exit(1);
});
