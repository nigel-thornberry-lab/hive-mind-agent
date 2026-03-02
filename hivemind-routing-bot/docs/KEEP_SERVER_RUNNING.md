# Keeping the Server Running (Laptop & Always-On)

When the MCP server (or bot process) stops, it stops pinging the Keystone registry. **After ~20 minutes without a ping, your agent is hidden** from [tasknode.postfiat.org/agents](https://tasknode.postfiat.org/agents) until the server runs again.

From a **laptop** you have two realities:

- **While the laptop is on and online**: You can keep the server running in the background (tmux, launchd, or a process manager).
- **When the laptop sleeps or is offline**: The process stops. The agent will drop off the agents list until you start the server again.

For **24/7 visibility** on the agents page, run the server on an **always-on host** (e.g. a small VPS or cloud instance). See **Option 3** and **Deploy 24/7** below.

---

## Deploy 24/7 (recommended: run on a cloud host)

So the agent keeps running when your laptop is asleep, run the bot on a machine that never sleeps.

### A. Fly.io (free tier, one-time setup)

1. Install [flyctl](https://fly.io/docs/hands-on/install-flyctl/) and log in: `fly auth login`.
2. From the repo root (`hivemind-routing-bot`):
   ```bash
   fly launch --no-deploy
   ```
   (Answer name, region; say no to PostgreSQL if asked.)
3. Store your seed as a secret (never in the image):
   ```bash
   fly secrets set BOT_SEED="$(cat ~/.hivemind-bot-seed)"
   ```
   Or use `BOT_SEED_FILE` by mounting a secret volume (see Fly.io docs).
4. Deploy and run:
   ```bash
   fly deploy
   fly scale count 1
   ```
5. Check logs: `fly logs`. The bot will ping and process messages 24/7.

### B. Any Linux VPS (DigitalOcean, Railway, Oracle Cloud, etc.)

1. Create a small VM (e.g. 512 MB RAM, Node 20).
2. Clone or copy the repo onto the server. Copy your seed file to the server **securely** (e.g. `scp ~/.hivemind-bot-seed user@server:~/.hivemind-bot-seed`), then `chmod 600 ~/.hivemind-bot-seed` on the server.
3. On the server:
   ```bash
   cd hivemind-routing-bot
   npm ci && npm run build
   export BOT_SEED_FILE=~/.hivemind-bot-seed
   node dist/src/bot-loop.js
   ```
4. Keep it running: use **tmux** (`tmux new -s bot`, run the command, detach with Ctrl+B D), or **systemd** / **PM2** (see Option 3 below).

### C. Docker on any host

From the repo root (includes `hivemind-routing-bot`):

```bash
cd hivemind-routing-bot
docker build -t hivemind-bot .
docker run -d --restart unless-stopped \
  -e BOT_SEED_FILE=/run/secrets/bot_seed \
  -v /path/on/host/.hivemind-bot-seed:/run/secrets/bot_seed:ro \
  --name hivemind-bot hivemind-bot
```

Use the path where you saved the seed on the host. The container restarts automatically if it crashes or after a reboot.

---

## Option 1: Tmux on the laptop (simple, survives terminal close)

Keeps the server running when you close the terminal; it still stops when the laptop sleeps or you shut it down.

```bash
cd /path/to/hivemind-routing-bot
tmux new -s hivemind
export BOT_SEED_FILE=~/.hivemind-bot-seed
npm run mcp:server
# Detach: Ctrl+B then D. Reattach later: tmux attach -t hivemind
```

- **Detach** (leave it running): `Ctrl+B`, then `D`
- **Reattach** (see logs again): `tmux attach -t hivemind`
- **Kill** the session: `tmux kill-session -t hivemind`

---

## Option 2: macOS launchd (background service on your Mac)

Runs the server in the background and restarts it if it exits (e.g. crash). Still stops when the Mac sleeps.

1. Create the plist (replace `YOUR_USERNAME` with your macOS username):

```bash
cat > ~/Library/LaunchAgents/org.postfiat.hivemind-mcp.plist << 'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>org.postfiat.hivemind-mcp</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/env</string>
    <string>node</string>
    <string>dist/src/bot-loop.js</string>
  </array>
  <key>WorkingDirectory</key>
  <string>/Users/YOUR_USERNAME/Projects/pft-test-client/hivemind-routing-bot</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>BOT_SEED_FILE</key>
    <string>/Users/YOUR_USERNAME/.hivemind-bot-seed</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/tmp/hivemind-mcp.stdout.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/hivemind-mcp.stderr.log</string>
</dict>
</plist>
PLIST
```

2. Edit the plist: set `YOUR_USERNAME` in `WorkingDirectory` and in `BOT_SEED_FILE` (and adjust paths if your repo is elsewhere).

3. Load and start:
   ```bash
   launchctl load ~/Library/LaunchAgents/org.postfiat.hivemind-mcp.plist
   ```

4. Check it’s running:
   ```bash
   launchctl list | grep hivemind
   tail -f /tmp/hivemind-mcp.stderr.log
   ```

5. Stop / unload:
   ```bash
   launchctl unload ~/Library/LaunchAgents/org.postfiat.hivemind-mcp.plist
   ```

**Note:** The plist runs the **chain-listening bot** (`bot-loop.js`) so the agent stays visible and replies to messages. The MCP server uses **stdio** to talk to the client. When run as a LaunchAgent it’s not connected to Cursor/IDE. Use this if you want the **chain-listening bot** (`npm run start`) or a **separate MCP-over-HTTP** setup. For “Cursor talks to MCP”, run the server manually or in tmux when you’re working; use launchd for a **headless bot** that only does scan → match → send.

---

## Option 3: Always-on host (VPS / cloud) for 24/7 agents listing

To keep the agent visible on the agents page even when the laptop is closed, run the server on a small always-on machine.

1. **Prepare the host**: Linux VPS (e.g. DigitalOcean, Fly.io, Railway, or a home server that doesn’t sleep).

2. **Deploy the repo** (clone or copy), put the seed on the server in a secure path, e.g.:
   ```bash
   # On the server (never commit this file)
   echo "sEd..." > /opt/hivemind/.hivemind-bot-seed
   chmod 600 /opt/hivemind/.hivemind-bot-seed
   ```

3. **Run under a process manager** so it restarts on crash and survives reboots:
   - **systemd** (Linux): create a user or system service that runs `node dist/src/mcp-server-with-routing.js` with `BOT_SEED_FILE=/opt/hivemind/.hivemind-bot-seed` and `WorkingDirectory` set to the repo.
   - **Docker**: run the Node process in a container with the seed mounted or injected via env (prefer a file with restricted permissions).
   - **PM2**: `pm2 start dist/src/mcp-server-with-routing.js --name hivemind-mcp --env BOT_SEED_FILE=/opt/hivemind/.hivemind-bot-seed` and `pm2 save` / `pm2 startup` for reboot survival.

4. **Security**: Restrict who can read the seed file; use firewall so only required outbound (PFTL, Keystone, Task Node) are allowed; no need to expose the MCP stdio port if the only job is pinging and chain-listening.

---

## Summary

| Goal | Approach |
|------|----------|
| Use MCP from Cursor on the laptop | Run `npm run mcp:server` in a terminal or tmux; when laptop sleeps, agent drops off until you start again. |
| Laptop on, terminal closed | Tmux (Option 1) or launchd for a headless bot (Option 2). |
| Agent always on the agents page | Run the server on an always-on host (Option 3). |
