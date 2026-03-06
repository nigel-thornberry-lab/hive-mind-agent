/**
 * Unit tests for match-adapter: normalization, constraints, ranking, top-3 output.
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import {
  normalizeMemberMatchPayload,
  runMemberMatchWithDataset,
  getSybilPenaltyMultiplier,
} from "../src/match-adapter.js";
import type { MemberIndexSnapshot } from "../src/member-index-cache.js";
import type { OperatorProfile } from "../src/tasknode-client.js";

function mockOperator(overrides: Partial<OperatorProfile> = {}): OperatorProfile {
  return {
    operator_id: "op-1",
    wallet_address: "rWallet1",
    wallet_label: null,
    summary: null,
    capabilities: [],
    expert_knowledge: [{ domain: "typescript", confidence: null }, { domain: "node", confidence: null }],
    sybil_score: 80,
    sybil_risk: "Low Risk",
    linked_accounts: [],
    alignment_score: 70,
    alignment_tier: null,
    weekly_tasks: 5,
    monthly_tasks: 20,
    weekly_rewards: 100,
    monthly_rewards: 400,
    leaderboard_score_week: 10,
    leaderboard_score_month: 40,
    is_public: true,
    is_published: true,
    published_at: null,
    nft_image_url: null,
    avatar_image_url: null,
    ...overrides,
  };
}

function mockSnapshot(operators: OperatorProfile[]): MemberIndexSnapshot {
  return {
    metadata: { dataset: "test", generated_at: new Date().toISOString() },
    operator_profiles: operators,
  };
}

describe("normalizeMemberMatchPayload", () => {
  it("normalizes request_text and tags", () => {
    const out = normalizeMemberMatchPayload({
      request_text: "  Build a TypeScript API  ",
      tags: ["typescript", "node"],
    });
    assert.strictEqual(out.user_request_text, "Build a TypeScript API");
    assert.deepStrictEqual(out.required_skills, ["typescript", "node"]);
    assert.strictEqual(out.top_k, 3);
  });

  it("clamps top_k to 3", () => {
    const out = normalizeMemberMatchPayload({ request_text: "x", top_k: 10 });
    assert.strictEqual(out.top_k, 3);
  });

  it("normalizes urgency and defaults to unknown", () => {
    const out = normalizeMemberMatchPayload({ request_text: "x", urgency: "this_week" });
    assert.strictEqual(out.urgency, "this_week");
    const out2 = normalizeMemberMatchPayload({ request_text: "x" });
    assert.strictEqual(out2.urgency, "unknown");
  });
});

describe("getSybilPenaltyMultiplier", () => {
  it("returns 1.0 for low risk", () => {
    assert.strictEqual(getSybilPenaltyMultiplier("Low Risk", 90), 1.0);
  });
  it("returns 0.35 for high risk", () => {
    assert.strictEqual(getSybilPenaltyMultiplier("High Risk", 50), 0.35);
  });
});

describe("runMemberMatchWithDataset", () => {
  it("returns top 3 matches for request matching expert_knowledge", () => {
    const operators = [
      mockOperator({ operator_id: "a", wallet_address: "rA", expert_knowledge: [{ domain: "typescript", confidence: null }], alignment_score: 90 }),
      mockOperator({ operator_id: "b", wallet_address: "rB", expert_knowledge: [{ domain: "node", confidence: null }], alignment_score: 80 }),
      mockOperator({ operator_id: "c", wallet_address: "rC", expert_knowledge: [{ domain: "rust", confidence: null }], alignment_score: 70 }),
    ];
    const snapshot = mockSnapshot(operators);
    const result = runMemberMatchWithDataset(
      { request_text: "Need TypeScript and node expertise", tags: ["typescript"] },
      snapshot
    );
    assert.strictEqual(result.ok, true);
    assert.ok(result.top_matches.length >= 1);
    assert.strictEqual(result.top_matches[0].operator_id, "a");
    assert.ok(result.top_matches[0].confidence > 0);
    assert.ok(Array.isArray(result.top_matches[0].matched_expert_domains));
  });

  it("returns empty top_matches when no operator matches", () => {
    const snapshot = mockSnapshot([
      mockOperator({ expert_knowledge: [{ domain: "rust", confidence: null }] }),
    ]);
    const result = runMemberMatchWithDataset(
      { request_text: "Need Haskell and Coq", tags: ["haskell"] },
      snapshot
    );
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.top_matches.length, 0);
  });

  it("routes multi-skill intent (NFT + escrow) to strongest blended operator", () => {
    const operators = [
      mockOperator({
        operator_id: "nft-only",
        wallet_address: "rNFT",
        summary: "NFT collection and minting specialist",
        expert_knowledge: [{ domain: "NFT minting workflows", confidence: null }],
        alignment_score: 70,
      }),
      mockOperator({
        operator_id: "escrow-only",
        wallet_address: "rEscrow",
        summary: "Escrow settlement engineer for blockchain payments",
        expert_knowledge: [{ domain: "Escrow and settlement workflows", confidence: null }],
        alignment_score: 72,
      }),
      mockOperator({
        operator_id: "blended",
        wallet_address: "rBlend",
        summary: "Build NFT marketplaces with escrowed settlement and payment rails",
        expert_knowledge: [
          { domain: "NFT marketplace architecture", confidence: null },
          { domain: "Escrow and settlement logic", confidence: null },
          { domain: "Blockchain payment integrations", confidence: null },
        ],
        alignment_score: 88,
      }),
    ];
    const snapshot = mockSnapshot(operators);
    const result = runMemberMatchWithDataset(
      {
        request_text: "Need help building an NFT marketplace with escrow and payment settlement flows",
        tags: ["nft", "escrow", "marketplace"],
      },
      snapshot
    );
    assert.strictEqual(result.ok, true);
    assert.ok(result.top_matches.length >= 1);
    assert.strictEqual(result.top_matches[0].operator_id, "blended");
    assert.ok(result.top_matches[0].confidence > 0.2);
  });

  it("populates summary, capability_highlights, and activity_level on results", () => {
    const operators = [
      mockOperator({
        operator_id: "rich",
        wallet_address: "rRich",
        summary: "Full-stack TypeScript engineer",
        capabilities: ["Build real-time WebSocket APIs", "Ship React dashboards"],
        expert_knowledge: [{ domain: "typescript", confidence: null }],
        weekly_tasks: 15,
        alignment_score: 85,
      }),
    ];
    const snapshot = mockSnapshot(operators);
    const result = runMemberMatchWithDataset(
      { request_text: "Need TypeScript backend engineer" },
      snapshot
    );
    assert.strictEqual(result.ok, true);
    assert.ok(result.top_matches.length >= 1);
    const top = result.top_matches[0];
    assert.strictEqual(top.summary, "Full-stack TypeScript engineer");
    assert.ok(top.capability_highlights.length > 0, "should have capability highlights");
    assert.ok(top.activity_level.includes("active"), `activity_level should include 'active', got: ${top.activity_level}`);
    assert.ok(!top.reasoning.startsWith("Semantic fit"), "reasoning should be contextual, not raw scores");
  });

  it("observability alias matches monitoring/telemetry operator", () => {
    const operators = [
      mockOperator({
        operator_id: "obs-eng",
        wallet_address: "rObs",
        summary: "Production monitoring and telemetry engineer",
        capabilities: ["Build Prometheus + Grafana monitoring stacks"],
        expert_knowledge: [
          { domain: "Production monitoring and alerting", confidence: null },
          { domain: "Telemetry pipeline engineering", confidence: null },
        ],
        alignment_score: 80,
      }),
      mockOperator({
        operator_id: "unrelated",
        wallet_address: "rUnrelated",
        summary: "NFT artist and minter",
        expert_knowledge: [{ domain: "NFT art creation", confidence: null }],
        alignment_score: 75,
      }),
    ];
    const snapshot = mockSnapshot(operators);
    const result = runMemberMatchWithDataset(
      { request_text: "Need help with production observability hardening", tags: ["observability"] },
      snapshot
    );
    assert.strictEqual(result.ok, true);
    assert.ok(result.top_matches.length >= 1);
    assert.strictEqual(result.top_matches[0].operator_id, "obs-eng");
  });

  it("matches live sample data: React auth race conditions -> Yuri", () => {
    const yuri = mockOperator({
      operator_id: "7f129508-935a-42e2-95d0-85907c552c6c",
      wallet_address: "rDVKRNp3kWE1ykryU8ta6bBZWrFjFetyjB",
      wallet_label: "Yuri",
      summary: "React real-time state authentication architect",
      capabilities: [
        "Architect and implement global state management for real-time identity resolution.",
        "Diagnose and resolve complex React race conditions and async closure bugs.",
        "Design and ship high-performance WebSocket (WSS) synchronization architectures.",
      ],
      expert_knowledge: [
        { domain: "React state management and hooks", confidence: null },
        { domain: "Authentication and session persistence", confidence: null },
        { domain: "WebSocket and real-time architecture", confidence: null },
        { domain: "Asynchronous race condition mitigation", confidence: null },
      ],
      alignment_score: 92,
      sybil_score: 84,
      weekly_tasks: 43,
      monthly_tasks: 79,
    });
    const unrelatedOps = [
      mockOperator({
        operator_id: "marketing",
        wallet_address: "rMkt",
        summary: "AI marketing intelligence pipeline builder",
        expert_knowledge: [
          { domain: "AI-native marketing operations", confidence: null },
          { domain: "Private equity market intelligence", confidence: null },
        ],
        alignment_score: 65,
      }),
      mockOperator({
        operator_id: "forensics",
        wallet_address: "rForensics",
        summary: "macOS Unity reverse engineer forensics",
        expert_knowledge: [
          { domain: "Reverse engineering and decompilation", confidence: null },
          { domain: "Process memory forensics", confidence: null },
        ],
        alignment_score: 84,
      }),
    ];
    const snapshot = mockSnapshot([yuri, ...unrelatedOps]);
    const result = runMemberMatchWithDataset(
      { request_text: "I need a React + TypeScript engineer to fix auth race conditions and ship this week" },
      snapshot
    );
    assert.strictEqual(result.ok, true);
    assert.ok(result.top_matches.length >= 1);
    assert.strictEqual(
      result.top_matches[0].operator_id,
      "7f129508-935a-42e2-95d0-85907c552c6c",
      "Yuri should be the top match for React auth race conditions"
    );
  });

  it("reverse alias: monitoring request matches observability operator", () => {
    const observabilityOp = mockOperator({
      operator_id: "obs-1",
      wallet_address: "rObs",
      summary: "Observability and SRE",
      expert_knowledge: [{ domain: "observability", confidence: null }, { domain: "prometheus", confidence: null }],
    });
    const other = mockOperator({
      operator_id: "other",
      wallet_address: "rOther",
      expert_knowledge: [{ domain: "backend", confidence: null }],
    });
    const snapshot = mockSnapshot([other, observabilityOp]);
    const result = runMemberMatchWithDataset(
      { request_text: "Need monitoring and telemetry for our services" },
      snapshot
    );
    assert.strictEqual(result.ok, true);
    assert.ok(result.top_matches.length >= 1);
    assert.strictEqual(result.top_matches[0].operator_id, "obs-1");
  });

  it("short token ai is kept and matches AI operator", () => {
    const aiOp = mockOperator({
      operator_id: "ai-1",
      wallet_address: "rAI",
      expert_knowledge: [{ domain: "ai", confidence: null }, { domain: "machine learning", confidence: null }],
    });
    const other = mockOperator({
      operator_id: "other",
      wallet_address: "rOther",
      expert_knowledge: [{ domain: "backend", confidence: null }],
    });
    const snapshot = mockSnapshot([other, aiOp]);
    const result = runMemberMatchWithDataset(
      { request_text: "Need ai and ml for a chatbot" },
      snapshot
    );
    assert.strictEqual(result.ok, true);
    assert.ok(result.top_matches.length >= 1);
    assert.strictEqual(result.top_matches[0].operator_id, "ai-1");
  });

  it("urgency today boosts more active operator when skills similar", () => {
    const active = mockOperator({
      operator_id: "active",
      wallet_address: "rActive",
      expert_knowledge: [{ domain: "typescript", confidence: null }],
      weekly_tasks: 15,
      monthly_tasks: 60,
    });
    const quiet = mockOperator({
      operator_id: "quiet",
      wallet_address: "rQuiet",
      expert_knowledge: [{ domain: "typescript", confidence: null }],
      weekly_tasks: 0,
      monthly_tasks: 2,
    });
    const snapshot = mockSnapshot([quiet, active]);
    const result = runMemberMatchWithDataset(
      { request_text: "TypeScript help", tags: ["typescript"], urgency: "today" },
      snapshot
    );
    assert.strictEqual(result.ok, true);
    assert.ok(result.top_matches.length >= 1);
    assert.strictEqual(result.top_matches[0].operator_id, "active");
  });

  it("matches live sample data: Discord bot + LLM -> Discord bot developer", () => {
    const discordDev = mockOperator({
      operator_id: "d6453c54-94b1-467d-a376-6512130cc779",
      wallet_address: "rnmLkDT2SBeaFA5z2ogdUCbJ2GMzn2sLLu",
      summary: "Discord bot LLM NFT developer",
      capabilities: [
        "Develop Discord bots with complex slash command architectures and interactive UI modules.",
        "Integrate LLM APIs (OpenRouter) with parallel execution and multi-model response aggregation.",
      ],
      expert_knowledge: [
        { domain: "Discord bot architecture", confidence: null },
        { domain: "LLM API orchestration", confidence: null },
        { domain: "Full-stack JavaScript development", confidence: null },
      ],
      alignment_score: 82,
      sybil_score: 89,
      weekly_tasks: 11,
    });
    const others = [
      mockOperator({
        operator_id: "ux-designer",
        wallet_address: "rUX",
        summary: "Enterprise AI interface architect",
        expert_knowledge: [
          { domain: "Enterprise UX design systems", confidence: null },
        ],
        alignment_score: 51,
      }),
    ];
    const snapshot = mockSnapshot([discordDev, ...others]);
    const result = runMemberMatchWithDataset(
      { request_text: "Build a Discord bot with LLM integration and slash commands" },
      snapshot
    );
    assert.strictEqual(result.ok, true);
    assert.ok(result.top_matches.length >= 1);
    assert.strictEqual(result.top_matches[0].operator_id, "d6453c54-94b1-467d-a376-6512130cc779");
  });

  it("significantly boosts exact expert knowledge + capability phrase matches", () => {
    const exact = mockOperator({
      operator_id: "exact",
      wallet_address: "rExact",
      summary: "B2B growth systems operator",
      capabilities: [
        "Execute data-driven B2B outreach and lead generation strategies using industry-specific positioning.",
      ],
      expert_knowledge: [
        { domain: "Sales outreach strategy", confidence: null },
        { domain: "Lead generation systems", confidence: null },
      ],
      weekly_tasks: 1,
      monthly_tasks: 4,
    });
    const genericButActive = mockOperator({
      operator_id: "generic-active",
      wallet_address: "rGeneric",
      summary: "Generalist builder",
      capabilities: ["Build web applications and APIs quickly."],
      expert_knowledge: [{ domain: "Full stack web development", confidence: null }],
      weekly_tasks: 40,
      monthly_tasks: 100,
    });
    const snapshot = mockSnapshot([genericButActive, exact]);
    const result = runMemberMatchWithDataset(
      {
        request_text:
          "Need a member to run B2B sales outreach, lead generation, and outbound messaging strategy.",
        tags: ["b2b outreach", "lead generation", "sales outreach"],
      },
      snapshot
    );
    assert.strictEqual(result.ok, true);
    assert.ok(result.top_matches.length >= 1);
    assert.strictEqual(result.top_matches[0].operator_id, "exact");
    assert.ok(
      result.top_matches[0].overall_match_score > 0.3,
      `expected exact match score > 0.3, got ${result.top_matches[0].overall_match_score}`
    );
  });

  it("does not include weak backup matches below quality threshold", () => {
    const strong = mockOperator({
      operator_id: "strong-sales",
      wallet_address: "rStrong",
      summary: "B2B sales systems operator",
      capabilities: ["Run B2B outreach campaigns with targeted lead generation and outbound sequences."],
      expert_knowledge: [
        { domain: "Sales outreach strategy", confidence: null },
        { domain: "Lead generation systems", confidence: null },
      ],
      weekly_tasks: 10,
    });
    const weak = mockOperator({
      operator_id: "weak-unrelated",
      wallet_address: "rWeak",
      summary: "General full-stack web developer",
      capabilities: ["Build dashboards and APIs."],
      expert_knowledge: [{ domain: "Frontend development", confidence: null }],
      weekly_tasks: 30,
    });
    const snapshot = mockSnapshot([strong, weak]);
    const result = runMemberMatchWithDataset(
      {
        request_text:
          "Need B2B sales outreach support with outbound messaging and lead generation.",
        tags: ["b2b outreach", "sales outreach", "lead generation"],
      },
      snapshot
    );
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.top_matches.length, 1, "weak backup should be filtered out");
    assert.strictEqual(result.top_matches[0].operator_id, "strong-sales");
  });

  it("requires at least one tag overlap when tags are provided", () => {
    const unrelated = mockOperator({
      operator_id: "unrelated",
      wallet_address: "rUnrelated",
      summary: "General infrastructure engineer",
      capabilities: ["Build Kubernetes pipelines and CI/CD automation."],
      expert_knowledge: [{ domain: "Cloud infrastructure", confidence: null }],
    });
    const snapshot = mockSnapshot([unrelated]);
    const result = runMemberMatchWithDataset(
      {
        request_text: "Need B2B outreach support for sales pipeline",
        tags: ["b2b outreach", "sales outreach", "lead generation"],
      },
      snapshot
    );
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.top_matches.length, 0, "no overlap means no matches");
  });
});
