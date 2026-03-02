/**
 * Minimal MCP JSON-RPC client over stdio. Spawns the pft-chatbot-mcp process and sends
 * initialize, then tools/call requests; parses NDJSON responses.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";

const MCP_PROTOCOL_VERSION = "2024-11-05";

export interface McpToolCallResult {
  content?: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

export interface McpResponse {
  jsonrpc: string;
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string };
}

function formatRequest(id: number, method: string, params?: unknown): string {
  const msg: Record<string, unknown> = {
    jsonrpc: "2.0",
    id,
    method,
  };
  if (params !== undefined) msg.params = params;
  return JSON.stringify(msg) + "\n";
}

/**
 * Spawn the MCP server (pft-chatbot-mcp) with the given env and return a client
 * that can call tools. Call connect() first, then callTool().
 */
export class McpStdioClient {
  private process: ChildProcess | null = null;
  private requestId = 0;
  private pending = new Map<number, { resolve: (r: McpResponse) => void; reject: (e: Error) => void }>();
  private readline: ReturnType<typeof createInterface> | null = null;

  constructor(
    private command: string,
    private args: string[],
    private env: NodeJS.ProcessEnv
  ) {}

  /** Start the MCP server subprocess and perform handshake (initialize + initialized). */
  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.process = spawn(this.command, this.args, {
        env: { ...process.env, ...this.env },
        stdio: ["pipe", "pipe", "inherit"],
      });

      const stdout = this.process.stdout;
      if (!stdout) {
        reject(new Error("MCP process has no stdout"));
        return;
      }

      this.readline = createInterface({ input: stdout, crlfDelay: Infinity });

      this.readline.on("line", (line) => {
        try {
          const msg = JSON.parse(line) as McpResponse;
          const id = msg.id as number | undefined;
          if (id !== undefined && this.pending.has(id)) {
            const { resolve: res } = this.pending.get(id)!;
            this.pending.delete(id);
            res(msg);
          }
        } catch {
          // ignore non-JSON or malformed
        }
      });

      this.process.on("error", (err) => reject(err));
      this.process.on("exit", (code) => {
        if (code !== 0 && code !== null) {
          for (const [, { reject: rej }] of this.pending) rej(new Error(`MCP process exited with code ${code}`));
          this.pending.clear();
        }
      });

      // Send initialize
      const initId = ++this.requestId;
      this.pending.set(initId, {
        resolve: (response) => {
          if (response.error) {
            reject(new Error(`MCP initialize failed: ${response.error.message}`));
            return;
          }
          // Send notifications/initialized (no id, no response expected)
          const out = this.process?.stdin;
          if (out && !out.destroyed) {
            out.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
          }
          resolve();
        },
        reject,
      });
      const initPayload = formatRequest(initId, "initialize", {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "hivemind-routing-bot", version: "0.1.0" },
      });
      this.process.stdin?.write(initPayload, (err) => {
        if (err) reject(err);
      });
    });
  }

  /**
   * Call an MCP tool by name with the given arguments.
   * Returns the text content of the first content item (tool result is usually JSON string in content[0].text).
   */
  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    if (!this.process?.stdin?.writable || !this.readline) {
      throw new Error("MCP client not connected");
    }
    const id = ++this.requestId;
    const payload = formatRequest(id, "tools/call", { name, arguments: args });
    return new Promise((resolve, reject) => {
      this.pending.set(id, {
        resolve: (response) => {
          if (response.error) {
            reject(new Error(`tools/call ${name} failed: ${response.error.message}`));
            return;
          }
          const result = response.result as McpToolCallResult | undefined;
          const text = result?.content?.[0]?.text ?? "";
          if (result?.isError) reject(new Error(text || "Tool returned error"));
          else resolve(text);
        },
        reject,
      });
      this.process!.stdin!.write(payload, (err) => {
        if (err) {
          this.pending.delete(id);
          reject(err);
        }
      });
    });
  }

  disconnect(): void {
    this.pending.clear();
    if (this.process) {
      this.process.kill("SIGTERM");
      this.process = null;
    }
    this.readline = null;
  }
}
