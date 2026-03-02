# Hive Mind Prompting Guide

Use plain language. One sentence works.

Good default format:
- "I need help with [task], using [tech/domain], deliver by [time], budget [optional], prefer [constraints]."

## What This Agent Does

Hive Mind Routing finds the top 3 members for a task request from normal text.
It uses network profile signals (capabilities/expert tags), task activity, and trust signals to rank candidates.
You get:
- top 3 wallet matches
- confidence scores
- short reasoning for each match

## 15 Natural-Language Request Templates

These templates are based on observed active network categories (frontend engineering, realtime auth, Discord/LLM bots, NFT minting workflows, AI marketing ops, analytics dashboards, routing/scoring pipelines, and node telemetry tasks).

1) React + TypeScript build
- "I need a React + TypeScript engineer to build a dashboard for [use case] with filters and a clean handoff."

2) Auth/session bug fix
- "I need help fixing auth/session persistence bugs in a React app with JWT and race conditions."

3) WebSocket realtime sync
- "Looking for someone to implement realtime WebSocket sync for [entity/events] with reliable reconnect handling."

4) Frontend UX + architecture
- "I need an engineer who can design and ship an enterprise-grade frontend information architecture for [product]."

5) Discord bot automation
- "Need a Discord bot developer to implement slash commands, role flows, and moderation/automation logic."

6) LLM orchestration
- "I need an LLM integration engineer to wire multi-model prompts, retries, and response ranking for [workflow]."

7) NFT collection on-chain launch
- "I want help creating an NFT collection on-chain, including metadata pipeline, mint flow, and launch checklist."

8) Blockchain agent integration
- "Need a developer to integrate blockchain transactions/signing into a bot workflow with safe key handling."

9) AI marketing operations
- "Looking for an AI marketing operator to build an automated campaign workflow for [channel] and weekly reporting."

10) Competitive intelligence pipeline
- "Need a builder for a market/competitor intelligence pipeline that produces structured insights each week."

11) Routing/scoring algorithm work
- "I need help designing a ranking model that combines skill fit, trust scores, and recent delivery activity."

12) Data mapping / canonical schema
- "Need someone to map multiple API sources into a canonical schema with fallback rules and validation."

13) Node health telemetry + alerts
- "I need an engineer to set up node health telemetry and alerting for degraded network conditions."

14) Productized explainability UI
- "Need frontend help to show ranked candidates with confidence, risk flags, and human-readable explanations."

15) Fast MVP from idea
- "I need a full-stack builder who can turn this idea into a working MVP in [timeframe], with clean docs."

## Tips For Better Matches

- Include the stack ("React", "TypeScript", "Discord", "NFT", "WebSocket", etc.).
- Include the outcome ("fix bugs", "ship MVP", "add telemetry").
- Include urgency ("today", "this week", "no hard deadline").
- Include constraints ("budget", "timezone", "must include docs").

## Example Inputs

- "I need help creating an NFT collection on-chain and shipping mint metadata this week."
- "Need a React + TypeScript engineer to fix auth race conditions and websocket reconnect bugs."
- "Looking for someone to build an AI marketing intelligence pipeline with weekly summary reports."
