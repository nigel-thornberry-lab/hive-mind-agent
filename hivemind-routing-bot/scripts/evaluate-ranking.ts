#!/usr/bin/env node
/**
 * Offline evaluation harness: run ranking on fixed scenarios and report top-k quality.
 * Use before/after weight or alias changes to compare outcomes.
 *
 * Usage (from repo root):
 *   npx tsx scripts/evaluate-ranking.ts [path/to/scenarios.json]
 *   node dist/scripts/evaluate-ranking.js [path/to/scenarios.json]
 *
 * Scenarios JSON: array of { id, request_text, tags?, expected_operator_id_in_top3?, expected_domain_in_top3? }
 * Dataset: uses inline mock operators (or extend to load from file).
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { runMemberMatchWithDataset } from "../src/match-adapter.js";
import type { MemberIndexSnapshot } from "../src/member-index-cache.js";
import type { OperatorProfile } from "../src/tasknode-client.js";

function mockOperator(overrides: Partial<OperatorProfile> = {}): OperatorProfile {
  return {
    operator_id: "op-default",
    wallet_address: "rDefault",
    wallet_label: null,
    summary: null,
    capabilities: [],
    expert_knowledge: [],
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

function defaultDataset(): MemberIndexSnapshot {
  return {
    metadata: { dataset: "evaluate", generated_at: new Date().toISOString() },
    operator_profiles: [
      mockOperator({
        operator_id: "a",
        wallet_address: "rA",
        expert_knowledge: [{ domain: "typescript", confidence: null }, { domain: "node", confidence: null }],
        alignment_score: 90,
      }),
      mockOperator({
        operator_id: "b",
        wallet_address: "rB",
        expert_knowledge: [{ domain: "node", confidence: null }],
        alignment_score: 80,
      }),
      mockOperator({
        operator_id: "obs-1",
        wallet_address: "rObs",
        summary: "Observability and SRE",
        expert_knowledge: [{ domain: "observability", confidence: null }, { domain: "prometheus", confidence: null }],
      }),
      mockOperator({
        operator_id: "7f129508-935a-42e2-95d0-85907c552c6c",
        wallet_address: "rYuri",
        summary: "React TypeScript auth specialist",
        expert_knowledge: [
          { domain: "React", confidence: null },
          { domain: "TypeScript", confidence: null },
          { domain: "authentication", confidence: null },
        ],
        alignment_score: 85,
      }),
    ],
  };
}

interface Scenario {
  id: string;
  request_text: string;
  tags?: string[];
  urgency?: string;
  expected_operator_id_in_top3?: string[];
  expected_domain_in_top3?: string[];
}

function loadScenarios(path: string): Scenario[] {
  const raw = readFileSync(path, "utf8");
  return JSON.parse(raw) as Scenario[];
}

function runScenario(
  scenario: Scenario,
  dataset: MemberIndexSnapshot
): { pass: boolean; topIds: string[]; topDomains: string[]; message: string } {
  const result = runMemberMatchWithDataset(
    {
      request_text: scenario.request_text,
      tags: scenario.tags,
      urgency: (scenario.urgency as "today" | "this_week" | "this_month" | "unknown") ?? undefined,
    },
    dataset
  );
  const topIds = result.top_matches.map((m) => m.operator_id);
  const topDomains = result.top_matches.flatMap((m) => m.matched_expert_domains ?? []);

  let pass = true;
  const messages: string[] = [];

  if (scenario.expected_operator_id_in_top3?.length) {
    const found = scenario.expected_operator_id_in_top3.some((id) => topIds.includes(id));
    if (!found) {
      pass = false;
      messages.push(`Expected one of [${scenario.expected_operator_id_in_top3.join(", ")}] in top-3, got [${topIds.join(", ")}]`);
    }
  }
  if (scenario.expected_domain_in_top3?.length) {
    const found = scenario.expected_domain_in_top3.some((d) =>
      topDomains.some((x) => x.toLowerCase().includes(d.toLowerCase()))
    );
    if (!found) {
      pass = false;
      messages.push(`Expected domain in top-3 to include one of [${scenario.expected_domain_in_top3.join(", ")}], got [${[...new Set(topDomains)].join(", ")}]`);
    }
  }

  return {
    pass,
    topIds,
    topDomains: [...new Set(topDomains)],
    message: messages.join("; ") || "ok",
  };
}

function main(): void {
  const scenariosPath = process.argv[2]
    ?? resolve(process.cwd(), "scripts", "ranking-scenarios.json");
  if (!existsSync(scenariosPath)) {
    console.error("Scenarios file not found:", scenariosPath);
    process.exit(1);
  }

  const scenarios = loadScenarios(scenariosPath);
  const dataset = defaultDataset();

  console.log("Offline ranking evaluation");
  console.log("Scenarios:", scenarios.length);
  console.log("");

  let passed = 0;
  for (const scenario of scenarios) {
    const { pass, topIds, message } = runScenario(scenario, dataset);
    if (pass) passed++;
    console.log(`${scenario.id}: ${pass ? "PASS" : "FAIL"} ${message}`);
    console.log(`  top-3: ${topIds.join(", ")}`);
  }

  console.log("");
  console.log(`Result: ${passed}/${scenarios.length} passed`);
  process.exit(passed === scenarios.length ? 0 : 1);
}

main();
