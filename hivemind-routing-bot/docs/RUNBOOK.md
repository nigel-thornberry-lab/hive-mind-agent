# Hive Mind Routing Bot – Runbook

## Startup

1. Ensure environment is set (see README): `BOT_SEED_FILE` or `BOT_SEED`, `PFT_TASKNODE_JWT`, and optional overrides.
2. Ensure seed file exists and has restrictive permissions: `chmod 600 "$BOT_SEED_FILE"`.
3. From repo root:
   - **Chain-listening bot**: `npm run build && npm run start` (or `npm run dev`).
   - **Single MCP server with routing tool**: `npm run build && npm run mcp:server` (exposes official chatbot tools + `match_members` on one server).

## Rollback

- Stop the process (Ctrl+C or process manager). If `PFT_BOT_CURSOR_FILE` is set, restart will resume from the last persisted ledger index (idempotency). Otherwise the bot rescans from the latest ledger.

## Key rotation

- **Bot seed**: Generate a new wallet via MCP `create_wallet`, fund it, update `BOT_SEED_FILE` to point to the new seed file, restart. Do not commit the new seed.
- **PFT_TASKNODE_JWT**: Update the env var and restart. No in-repo change needed.
- **Keystone API key**: Replace `.keystone-api-key` and restart. Ensure file is not in git.

## Incidents

- **Bot not responding to messages**: Check Task Node JWT is valid and not expired; check PFTL RPC/WSS connectivity; check logs for redacted errors.
- **Match results empty**: Verify Task Node leaderboard returns operators; check `PFT_MEMBER_INDEX_LIMIT` and network connectivity; confirm request text or tags are not over-constrained.
- **High memory or CPU**: Reduce `PFT_MEMBER_INDEX_LIMIT` or increase `PFT_MEMBER_INDEX_TTL_MS`; ensure a single bot process is running.

## Testnet end-to-end validation

1. **Create bot wallet** (if needed): Run the MCP server without `BOT_SEED` (setup mode), then use the `create_wallet` tool from an MCP client (e.g. Cursor with pft-chatbot-mcp). Save the returned seed securely.
2. **Fund the bot**: Send at least 10 PFT to the bot’s r-address on testnet (e.g. via [tasknode.postfiat.org](https://tasknode.postfiat.org)).
3. **Configure**: Set `BOT_SEED_FILE` (or `BOT_SEED`) and `PFT_TASKNODE_JWT`. Optionally set `PFTL_RPC_URL` / `PFTL_WSS_URL` for testnet.
4. **Register bot** (optional): Use the `register_bot` tool so the bot appears in the agent registry.
5. **Start the bot**: `npm run build && npm run start`. Confirm in stderr: "MCP connected; starting scan loop."
6. **Send a routing request**: From another wallet, send an encrypted message to the bot’s address. Body can be plain text (e.g. "Find members for TypeScript and API design") or JSON: `{"request_text": "...", "tags": ["typescript"]}`.
7. **Verify response**: The bot should reply with a decrypted message containing "Top 3 member matches:" and up to three wallet addresses with confidence scores. Confirm the reply is encrypted and delivered on-chain (e.g. via Task Node Messages UI).

## Keeping the server running (laptop / always-on)

- **Laptop**: When the machine sleeps or is offline, the process stops; the agent is hidden from the agents page after ~20 minutes. While the laptop is on, use **tmux** so closing the terminal doesn’t kill the server, or use **launchd** to run the bot in the background (see [docs/KEEP_SERVER_RUNNING.md](KEEP_SERVER_RUNNING.md)).
- **24/7 visibility**: Run the server (or the chain-listening bot) on an **always-on host** (VPS, cloud, or a machine that doesn’t sleep). Details: [docs/KEEP_SERVER_RUNNING.md](KEEP_SERVER_RUNNING.md).

## Health and readiness

- Set `PFT_BOT_HEALTH_PORT` (e.g. `9810`) to enable an HTTP server:
  - `GET /health` returns 200 when the process is running.
  - `GET /ready` returns 200 when the member index has been loaded at least once (and 503 otherwise). Use for orchestration readiness probes.
- Logs redact secrets (tokens, seeds) automatically. MCP and scan errors are retried with backoff (3 attempts).
