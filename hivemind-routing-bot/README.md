# Hive Mind Routing Bot

Chain-listening bot that receives encrypted on-chain routing requests and responds with the top 3 member matches. Uses the official [@postfiatorg/pft-chatbot-mcp](https://www.npmjs.com/package/@postfiatorg/pft-chatbot-mcp) package for wallet identity, encryption, and PFTL messaging.

## Security (required)

- **Use a dedicated bot wallet.** Do not use your personal wallet. Create a new wallet via the MCP `create_wallet` tool and fund it with minimal PFT for fees.
- **Prefer `BOT_SEED_FILE` over `BOT_SEED`.** Store the seed in a file with restricted permissions:
  ```bash
  echo "sEdYourBotSeed" > ~/.hivemind-bot-seed
  chmod 600 ~/.hivemind-bot-seed
  export BOT_SEED_FILE=~/.hivemind-bot-seed
  ```
- **Do not commit** `.keystone-api-key`, seed files, or `.env` with secrets. They are listed in `.gitignore`.

## Prerequisites

- Node.js >= 20
- A PFTL bot wallet (create via MCP `create_wallet`, then deposit at least 10 PFT to activate)

## Setup

1. **Create and fund a bot wallet (if needed)**  
   Use an MCP client (e.g. Cursor with pft-chatbot-mcp configured) and run the `create_wallet` tool. Save the seed securely, then fund the returned address with at least 10 PFT on testnet (e.g. via [tasknode.postfiat.org](https://tasknode.postfiat.org)).

2. **Install and build**
   ```bash
   cd hivemind-routing-bot
   npm install
   npm run build
   ```

3. **Configure environment**
   - `BOT_SEED_FILE` (recommended): path to file containing the bot family seed, e.g. `~/.hivemind-bot-seed`
   - Or `BOT_SEED`: inline seed (avoid in production)
   - `PFT_TASKNODE_JWT`: JWT for Task Node API (used to fetch member index for matching)
   - Optional: `PFT_TASKNODE_URL`, `PFTL_RPC_URL`, `PFTL_WSS_URL`, `KEYSTONE_GRPC_URL`, `PFT_MEMBER_INDEX_TTL_MS`, `PFT_MEMBER_INDEX_LIMIT`, `PFT_SCAN_INTERVAL_MS`, `PFT_BOT_CURSOR_FILE` (path to persist scan cursor for idempotency), `PFT_BOT_HEALTH_PORT` (e.g. 9810 for `/health` and `/ready`)

4. **Run the bot**
   ```bash
   npm run start
   # or for development
   npm run dev
   ```

The bot will connect to the PFTL network via the Chatbot MCP stack, scan for incoming messages, parse routing requests, run the Hive Mind matcher (cached member index + top-3 ranking), and send encrypted replies with the top 3 operator wallets and scores.

## Prompting guide (natural language)

Members should use plain-English requests (no JSON needed). See `docs/PROMPTING_GUIDE.md` for a practical guide and 15 request templates based on current network task/member categories.

## MCP server with routing tool (single process)

To run **one** MCP server that includes both the official chatbot tools (scan_messages, get_message, send_message, etc.) and the Hive Mind **match_members** tool:

```bash
npm run build
npm run mcp:server
```

- **Without** `BOT_SEED` / `BOT_SEED_FILE`: server runs in setup mode; only `create_wallet` and `match_members` are available.
- **With** `BOT_SEED` or `BOT_SEED_FILE`: full tool set (create_wallet, scan_messages, get_message, send_message, register_bot, … plus **match_members**).
- **match_members** uses `PFT_TASKNODE_JWT` (and optionally `PFT_TASKNODE_URL`, `PFT_MEMBER_INDEX_TTL_MS`, `PFT_MEMBER_INDEX_LIMIT`) for the live member index.

Configure wallet and RPC the same way as the standard package: `BOT_SEED` or `BOT_SEED_FILE`, `PFTL_RPC_URL`, `PFTL_WSS_URL`, `KEYSTONE_GRPC_URL`. The server connects to PFTL and Keystone when a wallet is configured and exposes the routing tool to any MCP client.

## Project layout

- `src/config.ts` – env-based config and seed resolution
- `src/security.ts` – seed-file permissions and log redaction
- `src/member-index-cache.ts` – cached Task Node operator snapshot
- `src/match-adapter.ts` – stateless match_members logic (top-3)
- `src/bot-loop.ts` – MCP client loop: scan → get_message → match → send_message
- `src/mcp-server-with-routing.ts` – Extended MCP server: official chatbot tools + **match_members**
- `docs/RUNBOOK.md` – operational runbook

## Make the agent visible at tasknode.postfiat.org/agents

To have PFT members see and message your agent on the [Task Node Agents page](https://tasknode.postfiat.org/agents), create a bot wallet, fund it with ≥10 PFT, run the MCP server with that wallet, then call **register_bot** (name, description, capabilities). Keep the server running so it keeps pinging and stays listed. **Step-by-step:** [docs/GO_LIVE_AGENTS.md](docs/GO_LIVE_AGENTS.md).

## Keep the agent running when the laptop is asleep

Run the bot on an **always-on host** (e.g. Fly.io free tier, a small VPS, or Docker anywhere). Step-by-step: [docs/KEEP_SERVER_RUNNING.md](docs/KEEP_SERVER_RUNNING.md) → **Deploy 24/7**.

## Testnet

Defaults point at Post Fiat testnet. After a soak period and verification, production can switch to production PFTL and Task Node endpoints via environment variables.
