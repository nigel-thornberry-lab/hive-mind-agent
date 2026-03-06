# Hive Mind Agent

An on-chain AI routing agent for the [Post Fiat Network](https://tasknode.postfiat.org). Members message the agent on-chain, describe what they need, and receive their top 3 operator matches — ranked by semantic fit, skill coverage, network alignment, and trust score.

## What It Does

1. **Listens on-chain** — scans PFTL messages for routing requests
2. **Runs a 3-question intake** — collects situation, primary skill, and trust preference
3. **Matches against the live member index** — semantic embedding + multi-skill facet scoring + alignment filtering
4. **Replies on-chain** — sends the requester their top 3 ranked operators with scores and reasoning

```
Member sends:  "I need to audit my Solidity contracts before mainnet"
               ↓
Agent asks Q1: What are you protecting, and what keeps you up at night?
Agent asks Q2: What part of the code worries you most?
Agent asks Q3: How much track record do you need from whoever you work with?
               ↓
Agent replies: Top 3 operator matches with scores, reasoning, and open-chat links
```

## Quick Start

```bash
cd hivemind-routing-bot
npm install
npm run build
```

```bash
# Recommended: seed in a permission-restricted file
echo "sEdYourBotSeed" > ~/.hivemind-bot-seed
chmod 600 ~/.hivemind-bot-seed
export BOT_SEED_FILE=~/.hivemind-bot-seed

# Required: JWT to fetch the live member index
export PFT_TASKNODE_JWT="<your-jwt>"

npm run start
```

The bot connects to the PFTL network, begins scanning for routing requests, and processes each conversation through the intake and matching pipeline.

## Intake Flow (3 Questions)

Every request goes through a mandatory 3-question sequence before matching. Each question is intent-adaptive — the wording changes based on whether the request is a build, fix, audit, consult, integrate, or design engagement.

| # | Question | What It Unlocks |
|---|----------|-----------------|
| Q1 | **The Situation** — what's happening and what needs to happen? | Rich semantic context for embedding-based scoring (45% of match score combined) |
| Q2 | **The Hardest Part** — the thing most people who try would get wrong | Primary skill facet for multi-skill coverage scoring (22% of match score) |
| Q3 | **Trust Level** — proven / good track record preferred / open to both | Maps to `min_alignment_score` filter, unlocking the alignment dimension (15% of match score) |

Members can skip the intake entirely by saying **"run now"** — the agent matches immediately on the initial message.

## Matching Engine

The ranking algorithm scores each operator across six dimensions:

| Dimension | Weight | Signal Source |
|-----------|--------|---------------|
| Semantic similarity | 28% | Cosine similarity between request embedding and operator profile |
| Multi-skill facets | 22% | How well the operator covers each facet of the request |
| Direct token overlap | 17% | Keyword overlap between request and operator capabilities |
| Alignment tier | 15% | Operator's network reputation score (Ramping → Established → …) |
| Sybil / trust score | 10% | Identity verification score |
| Activity + urgency bonus | 8% | Recent task volume, boosted when request is urgent |

Sybil-flagged operators (high risk) are penalized by up to 65%. Hard-blocked operators are excluded entirely.

## MCP Server (match_members as a tool)

The agent can also run as an MCP server, exposing the `match_members` tool to any MCP client (e.g. Cursor):

```bash
npm run mcp:server
```

Without a wallet configured, the server runs in setup mode — only `create_wallet` and `match_members` are available. With a wallet, the full chatbot tool set is exposed alongside the routing tool.

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `BOT_SEED_FILE` | Yes (recommended) | Path to file containing the bot family seed |
| `BOT_SEED` | Alt to above | Inline seed (avoid in production) |
| `PFT_TASKNODE_JWT` | Yes | JWT for Task Node API — fetches the live member index |
| `PFT_TASKNODE_URL` | No | Task Node base URL (default: https://tasknode.postfiat.org) |
| `PFTL_RPC_URL` | No | PFTL RPC endpoint override |
| `PFTL_WSS_URL` | No | PFTL WebSocket endpoint override |
| `PFT_BOT_CURSOR_FILE` | No | Path to persist scan cursor (enables idempotent restart) |
| `PFT_BOT_HEALTH_PORT` | No | Port for `/health` and `/ready` endpoints (e.g. `9810`) |
| `PFT_MEMBER_INDEX_TTL_MS` | No | Member index cache TTL (default: 5 minutes) |
| `PFT_SCAN_INTERVAL_MS` | No | Message scan interval (default: 10 seconds) |

## Repository Structure

```
pft-test-client/
├── hivemind-routing-bot/        # The agent (primary)
│   ├── src/
│   │   ├── bot-loop.ts          # Main chain-listening loop
│   │   ├── conversation-state-machine.ts  # Intake flow: Q1 → Q2 → Q3 → rank
│   │   ├── match-brief.ts       # Brief data model + confidence scoring
│   │   ├── match-weights.ts     # Intake field impact weights (single source of truth)
│   │   ├── question-policy.ts   # Question bank + intent-adaptive prompts
│   │   ├── match-adapter.ts     # Stateless semantic matching engine
│   │   ├── member-index-cache.ts  # Stale-while-revalidate operator cache
│   │   ├── mcp-server-with-routing.ts  # MCP server exposing match_members
│   │   └── ...
│   ├── docs/
│   │   ├── RUNBOOK.md           # Operational runbook
│   │   ├── GO_LIVE_AGENTS.md    # How to register at tasknode.postfiat.org/agents
│   │   └── KEEP_SERVER_RUNNING.md  # 24/7 deployment guide
│   └── test/
│       ├── intake-prompts.test.ts    # 3-question intake flow tests
│       └── ...
│
├── ts/                          # PFT CLI (task loop tooling)
├── sdk/                         # Python SDK (legacy)
└── docs/
    └── TASK_LOOP_PROTOCOL.md    # Task lifecycle protocol reference
```

## Registering the Agent on the Network

To make the agent visible to members at [tasknode.postfiat.org/agents](https://tasknode.postfiat.org/agents):

1. Create a dedicated bot wallet via the MCP `create_wallet` tool
2. Fund it with ≥ 10 PFT
3. Run the MCP server with that wallet configured
4. Call `register_bot` with name, description, and capabilities

See [docs/GO_LIVE_AGENTS.md](hivemind-routing-bot/docs/GO_LIVE_AGENTS.md) for the full walkthrough.

## Keeping the Agent Running

The bot needs to stay online to remain listed and process requests. Deploy it on an always-on host — Fly.io free tier, a small VPS, or Docker anywhere.

See [docs/KEEP_SERVER_RUNNING.md](hivemind-routing-bot/docs/KEEP_SERVER_RUNNING.md) for a step-by-step 24/7 deployment guide.

## License

MIT
