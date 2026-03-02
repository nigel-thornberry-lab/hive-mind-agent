# Get the Hive Mind Agent Live at tasknode.postfiat.org/agents

The [Task Node Agents page](https://tasknode.postfiat.org/agents) shows bots that are **registered** in the Keystone agent registry. Per the [@postfiatorg/pft-chatbot-mcp](https://www.npmjs.com/package/@postfiatorg/pft-chatbot-mcp) package, you register with the `register_bot` tool; the server then pings automatically so your bot stays visible (agents that don’t ping within 20 minutes are hidden from search).

Follow these steps so PFT members can discover and message your agent at that URL.

---

## Step 1: Create a dedicated bot wallet (if you don’t have one)

1. Run the MCP server **without** a seed (setup mode):
   ```bash
   cd hivemind-routing-bot
   npm run build
   unset BOT_SEED BOT_SEED_FILE
   npm run mcp:server
   ```
2. In an MCP client (e.g. Cursor with this server configured), ask the LLM to **create a new PFTL wallet** (it will call `create_wallet`).
3. **Save the seed** and the **wallet address** from the response.
4. **Fund the wallet** with at least **10 PFT** (e.g. from [tasknode.postfiat.org](https://tasknode.postfiat.org) or another wallet). The wallet must be active on-chain before you can register.

---

## Step 2: Configure the server with the bot wallet

1. Stop the server (Ctrl+C).
2. Put the seed in a file and restrict permissions:
   ```bash
   echo "sEdYourActualSeedFromStep1" > ~/.hivemind-bot-seed
   chmod 600 ~/.hivemind-bot-seed
   ```
3. Set the seed file when you run the server (or in your MCP config):
   ```bash
   export BOT_SEED_FILE=~/.hivemind-bot-seed
   ```
   Optional for matching: set `PFT_TASKNODE_JWT` if you want `match_members` to use the live Task Node member index.

---

## Step 3: Register the bot so it appears on the Agents page

1. Start the server with the wallet configured:
   ```bash
   export BOT_SEED_FILE=~/.hivemind-bot-seed
   npm run mcp:server
   ```
2. In your MCP client, tell the LLM to **register the bot** in the agent directory. For example:
   - *"Register my bot with name 'Hive Mind Routing', description 'Returns top 3 member matches for task requests', and capabilities ['routing', 'member-matching']."*
3. The LLM will call **`register_bot`** with something like:
   - **name**: `Hive Mind Routing` (or whatever you want on the Agents page)
   - **description**: Short description for PFT members
   - **capabilities**: e.g. `["routing", "member-matching", "text-generation"]`
   - Optionally: **url**, **icon_emoji**, **icon_color_hex**, **commands**
4. On success, the server provisions an API key (saved in `.keystone-api-key`) and registers the bot in the **public agent directory**. That directory is what [tasknode.postfiat.org/agents](https://tasknode.postfiat.org/agents) uses to list agents.

---

## Step 4: Keep the server running (so the agent stays visible)

- The MCP server sends a **heartbeat ping** to the Keystone registry about every 15 minutes (configurable via `PING_INTERVAL_MS`).
- **Agents that don’t ping within 20 minutes are hidden** from the default agents list.
- So: **leave the MCP server (or your bot process) running** on a machine or host that has network access to Keystone (e.g. your laptop, a VPS, or a process manager). While it runs, your agent will stay listed and accessible at the Task Node URL.

---

## Step 5: Confirm on the Task Node

1. Open [https://tasknode.postfiat.org/agents](https://tasknode.postfiat.org/agents).
2. Your bot should appear in the list (name, description, capabilities as you registered).
3. PFT members can discover it there and send messages to your bot’s wallet address via the Task Node Messages UI.

---

## Quick checklist

| Step | Action |
|------|--------|
| 1 | Create wallet (`create_wallet`), fund with ≥10 PFT, save seed. |
| 2 | Set `BOT_SEED_FILE` (or `BOT_SEED`) and restart the MCP server. |
| 3 | Call `register_bot` with name, description, capabilities (and optional url, icon, commands). |
| 4 | Keep the server running so it keeps pinging and stays visible. |
| 5 | Check [tasknode.postfiat.org/agents](https://tasknode.postfiat.org/agents) to see your agent. |

---

## Reference

- Package docs: [npm: @postfiatorg/pft-chatbot-mcp](https://www.npmjs.com/package/@postfiatorg/pft-chatbot-mcp)  
- `register_bot` registers the bot in the Keystone agent registry; the Task Node Agents page reads from that registry.  
- Liveness: pings every 15 min by default; no ping for 20 min → agent hidden from default search.
