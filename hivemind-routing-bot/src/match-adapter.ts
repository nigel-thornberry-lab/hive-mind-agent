/**
 * Stateless semantic match_members logic:
 * 1) embed operator profiles + request
 * 2) vector similarity retrieval (candidate pool)
 * 3) multi-skill rerank
 * 4) top-k return
 */

import { randomUUID } from "node:crypto";
import type { MemberIndexSnapshot } from "./member-index-cache.js";
import type { OperatorProfile } from "./tasknode-client.js";

function toString(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value);
}

function toNumber(value: unknown, fallback: number | null): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

const SYBIL_RISK_RANK: Record<string, number> = {
  "low risk": 1,
  moderate: 2,
  elevated: 3,
  "high risk": 4,
};

const STOPWORDS = new Set([
  "a", "an", "and", "the", "to", "of", "for", "in", "on", "with", "into", "from", "by",
  "or", "at", "is", "are", "be", "as", "using", "use", "build", "create", "design", "implement",
]);

const CRITICAL_2CHAR = new Set(["ai", "ui", "ux"]);

const EMBEDDING_DIMS = 256;
const MIN_RETRIEVAL_SCORE = 0.15;
const MIN_FINAL_SCORE = 0.18;
const MIN_RELATIVE_TOP_SCORE_GAP = 0.12;
const MAX_EXACT_DOMAIN_BOOST = 0.14;
const MAX_EXACT_CAPABILITY_BOOST = 0.14;
const NEAR_PERFECT_MATCH_BONUS = 0.12;
const STRONG_MATCH_CALIBRATION_MAX_BOOST = 0.55;
const SCORING_WEIGHTS = {
  semantic: 0.22,
  directOverlap: 0.2,
  multiSkill: 0.24,
  domainExpertise: 0.16,
  capabilityFit: 0.12,
  alignment: 0.04,
  sybil: 0.02,
  activity: 0.01,
};

const SEMANTIC_ALIASES: Record<string, string[]> = {
  nft: ["token", "mint", "collection", "marketplace", "ipfs", "metadata", "erc721", "erc1155"],
  marketplace: ["exchange", "listing", "trading", "storefront", "catalog"],
  escrow: ["settlement", "custody", "locking", "release", "multisig"],
  payments: ["billing", "payouts", "settlement", "invoicing", "stripe"],
  blockchain: ["onchain", "ledger", "smartcontract", "crypto", "web3", "decentralized", "dapp"],
  smartcontract: ["solidity", "contract", "evm", "hardhat", "foundry"],
  wallet: ["address", "xrpl", "solana", "eth", "metamask", "keypair"],
  typescript: ["ts", "node", "javascript", "deno"],
  react: ["frontend", "ui", "hooks", "state", "nextjs", "component"],
  backend: ["api", "server", "service", "database", "microservice", "rest", "graphql"],
  observability: ["monitoring", "telemetry", "alerting", "logging", "metrics", "tracing", "prometheus", "grafana"],
  auth: ["authentication", "authorization", "oauth", "jwt", "session", "identity", "sso"],
  websocket: ["realtime", "wss", "socket", "streaming", "pubsub"],
  discord: ["bot", "slash", "webhook"],
  llm: ["gpt", "claude", "openai", "prompt", "embedding", "rag", "agent"],
  dashboard: ["analytics", "visualization", "charts", "reporting"],
  schema: ["mapping", "transform", "migration", "orm", "datamodel"],
  routing: ["dispatch", "assignment", "matching", "scheduling"],
  security: ["audit", "penetration", "vulnerability", "hardening"],
  devops: ["pipeline", "deploy", "docker", "kubernetes", "infrastructure"],
  python: ["django", "flask", "fastapi", "pandas", "numpy"],
  rust: ["cargo", "wasm", "systems"],
  mobile: ["ios", "android", "flutter", "reactnative"],
  testing: ["test", "automation", "cypress", "playwright"],
  design: ["ux", "figma", "wireframe", "prototype"],
  marketing: ["seo", "growth", "campaign", "content"],
  data: ["etl", "warehouse", "bigquery", "snowflake", "ingestion"],
  integration: ["connector", "sync", "middleware"],
  performance: ["optimization", "caching", "latency", "throughput", "profiling"],
  forensics: ["reverse", "decompilation", "memory", "binary"],
  ai: ["machine", "learning", "neural", "model", "training", "inference"],
};

const REVERSE_ALIASES: Record<string, string[]> = (() => {
  const rev: Record<string, string[]> = {};
  for (const [canonical, aliases] of Object.entries(SEMANTIC_ALIASES)) {
    for (const a of aliases) {
      if (!rev[a]) rev[a] = [];
      rev[a].push(canonical);
    }
  }
  return rev;
})();

function normalizeText(value: string): string {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(value: string): string[] {
  return normalizeText(value)
    .split(" ")
    .filter((t) => (t.length > 2 || CRITICAL_2CHAR.has(t)) && !STOPWORDS.has(t));
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function expandSemanticTokens(tokens: string[]): string[] {
  const out = [...tokens];
  for (const token of tokens) {
    const aliases = SEMANTIC_ALIASES[token];
    if (aliases) out.push(...aliases);
    const canonicals = REVERSE_ALIASES[token];
    if (canonicals) out.push(...canonicals);
  }
  return unique(out);
}

function hashToken(token: string): number {
  let h = 2166136261;
  for (let i = 0; i < token.length; i++) {
    h ^= token.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function l2Normalize(vec: Float64Array): Float64Array {
  let sum = 0;
  for (let i = 0; i < vec.length; i++) sum += vec[i] * vec[i];
  const norm = Math.sqrt(sum) || 1;
  for (let i = 0; i < vec.length; i++) vec[i] /= norm;
  return vec;
}

function embedText(text: string): Float64Array {
  const vec = new Float64Array(EMBEDDING_DIMS);
  const baseTokens = tokenize(text);
  const tokens = expandSemanticTokens(baseTokens);

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const idx = hashToken(token) % EMBEDDING_DIMS;
    vec[idx] += 1.0;

    if (i < tokens.length - 1) {
      const bigram = `${token}_${tokens[i + 1]}`;
      const biIdx = hashToken(bigram) % EMBEDDING_DIMS;
      vec[biIdx] += 0.75;
    }
  }
  return l2Normalize(vec);
}

function cosine(a: Float64Array, b: Float64Array): number {
  let dot = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) dot += a[i] * b[i];
  return clamp01(dot);
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

export function getSybilPenaltyMultiplier(sybilRisk: string | null, sybilScore: number | null): number {
  const risk = toString(sybilRisk).toLowerCase();
  if (risk === "high risk") return 0.35;
  if (risk === "elevated") return 0.6;
  if (risk === "moderate") return 0.85;
  if (risk === "low risk") return 1.0;
  const score = toNumber(sybilScore, null);
  if (score === null) return 0.9;
  if (score < 40) return 0.45;
  if (score < 60) return 0.7;
  if (score < 75) return 0.85;
  return 1.0;
}

export type UrgencyLevel = "today" | "this_week" | "this_month" | "flexible" | "unknown";

export interface MatchInput {
  request_text?: string;
  user_request_text?: string;
  tags?: string[];
  required_skills?: string[];
  request_id?: string;
  top_k?: number;
  urgency?: UrgencyLevel;
  constraints?: {
    max_sybil_risk?: string;
    min_alignment_score?: number;
    public_only?: boolean;
    exclude_operator_ids?: string[];
  };
}

export interface NormalizedMatchInput {
  request_id: string;
  user_request_text: string;
  required_skills: string[];
  urgency: UrgencyLevel;
  constraints: {
    max_sybil_risk: string | null;
    min_alignment_score: number | null;
    public_only: boolean;
    exclude_operator_ids: string[];
  };
  top_k: number;
}

const VALID_URGENCY = new Set<UrgencyLevel>(["today", "this_week", "this_month", "flexible", "unknown"]);

export function normalizeMemberMatchPayload(payload: MatchInput): NormalizedMatchInput {
  const constraints = payload?.constraints && typeof payload.constraints === "object" ? payload.constraints : {};
  const rawUrgency = (payload?.urgency ?? "unknown").toLowerCase().replace(/\s+/g, "_") as UrgencyLevel;
  const urgency = VALID_URGENCY.has(rawUrgency) ? rawUrgency : "unknown";
  const rawMinAlignment = constraints.min_alignment_score;
  const minAlignmentScore = rawMinAlignment === null || rawMinAlignment === undefined
    ? null
    : toNumber(rawMinAlignment, null);
  return {
    request_id: toString(payload?.request_id || randomUUID()),
    user_request_text: toString(payload?.request_text ?? payload?.user_request_text ?? "").trim(),
    required_skills: asArray<string>(payload?.tags ?? payload?.required_skills)
      .map((s) => toString(s).trim())
      .filter(Boolean),
    urgency,
    constraints: {
      max_sybil_risk: toString(constraints.max_sybil_risk || "").trim() || null,
      min_alignment_score: minAlignmentScore,
      public_only: Boolean(constraints.public_only),
      exclude_operator_ids: asArray<string>(constraints.exclude_operator_ids)
        .map((s) => toString(s).trim())
        .filter(Boolean),
    },
    top_k: Math.max(1, Math.min(3, toNumber(payload?.top_k, 3) ?? 3)),
  };
}

export interface MatchConstraints {
  max_sybil_risk: string | null;
  min_alignment_score: number | null;
  public_only: boolean;
  exclude_operator_ids: string[];
}

function applyOperatorConstraints(
  operators: OperatorProfile[],
  constraints: MatchConstraints
): OperatorProfile[] {
  const excluded = new Set(constraints.exclude_operator_ids);
  const maxRiskRank = constraints.max_sybil_risk
    ? SYBIL_RISK_RANK[constraints.max_sybil_risk.toLowerCase()]
    : null;

  return operators.filter((op) => {
    const id = op.operator_id ?? op.wallet_address;
    if (id && excluded.has(id)) return false;
    if (constraints.public_only && !(op.is_public && op.is_published)) return false;
    if (
      constraints.min_alignment_score !== null &&
      Number(op.alignment_score ?? 0) < constraints.min_alignment_score
    )
      return false;
    if (maxRiskRank != null) {
      const rank = SYBIL_RISK_RANK[toString(op.sybil_risk).toLowerCase()] ?? 99;
      if (rank > maxRiskRank) return false;
    }
    return true;
  });
}

function buildIntegrityIndexes(snapshot: MemberIndexSnapshot): {
  blockedOperatorIds: Set<string>;
  blockedWalletAddresses: Set<string>;
  unauthorizedOperatorIds: Set<string>;
} {
  const integrity = snapshot?.integrity;
  if (!integrity) {
    return {
      blockedOperatorIds: new Set(),
      blockedWalletAddresses: new Set(),
      unauthorizedOperatorIds: new Set(),
    };
  }
  const cb = integrity.circuit_breaker || {};
  return {
    blockedOperatorIds: new Set(asArray<string>(cb.blocked_operator_ids)),
    blockedWalletAddresses: new Set(asArray<string>(cb.blocked_wallet_addresses)),
    unauthorizedOperatorIds: new Set(asArray<string>(integrity.unauthorized_operator_ids)),
  };
}

interface TaskLike {
  task_id: string;
  title: string;
  requirements: string;
}

function buildTaskFromQuery(normalized: NormalizedMatchInput): TaskLike {
  const parts = [normalized.user_request_text];
  if (normalized.required_skills.length)
    parts.push(`Required skills: ${normalized.required_skills.join(", ")}`);
  return {
    task_id: `query-${normalized.request_id}`,
    title: normalized.user_request_text.slice(0, 120),
    requirements: parts.join("\n"),
  };
}

function operatorSemanticText(op: OperatorProfile): string {
  const capabilities = asArray<string>(op.capabilities).join(" ");
  const domains = asArray<{ domain?: string }>(op.expert_knowledge).map((d) => d.domain ?? "").join(" ");
  return [
    op.summary ?? "",
    op.wallet_label ?? "",
    capabilities,
    domains,
    `${op.alignment_tier ?? ""} ${op.sybil_risk ?? ""}`,
  ].join(" ");
}

function splitIntentFacets(taskText: string, requiredSkills: string[]): string[] {
  const fromSkills = requiredSkills.map((s) => normalizeText(s)).filter(Boolean);
  const base = normalizeText(taskText)
    .replace(/\s+\+\s+/g, "|")
    .replace(/\s+(and|with|plus)\s+/g, "|")
    .replace(/[\/,;]/g, "|")
    .split("|")
    .map((s) => s.trim())
    .filter((s) => s.length >= 3);
  return unique([...fromSkills, ...base]).slice(0, 8);
}

function extractQueryPhrases(taskText: string, requiredSkills: string[]): string[] {
  const skillPhrases = requiredSkills
    .map((s) => normalizeText(s))
    .filter((s) => s.length >= 4);
  const sentencePhrases = normalizeText(taskText)
    .split(/\b(and|with|plus|for)\b|[|,;:.!?()]/g)
    .map((s) => normalizeText(s))
    .filter(Boolean)
    .filter((s) => s.length >= 10 || s.split(" ").length >= 2);
  return unique([...skillPhrases, ...sentencePhrases]).slice(0, 14);
}

function extractStrongSkillPhrases(requiredSkills: string[]): string[] {
  return unique(
    requiredSkills
      .map((s) => normalizeText(s))
      .filter(Boolean)
      .filter((s) => s.length >= 3)
  ).slice(0, 10);
}

function computeActivityScore(op: OperatorProfile): number {
  const weekly = Number(op.weekly_tasks ?? 0);
  const monthly = Number(op.monthly_tasks ?? 0);
  const blended = weekly + monthly / 4;
  return clamp01(blended / 20);
}

function activityLevel(op: OperatorProfile): string {
  const weekly = Number(op.weekly_tasks ?? 0);
  if (weekly >= 20) return "very active this week";
  if (weekly >= 5) return "active this week";
  if (weekly >= 1) return "recently active";
  const monthly = Number(op.monthly_tasks ?? 0);
  if (monthly >= 10) return "active this month";
  return "low recent activity";
}

function directTokenOverlap(queryTokens: string[], operatorTokens: string[]): number {
  if (queryTokens.length === 0) return 0;
  const opSet = new Set(operatorTokens);
  let matches = 0;
  for (const token of queryTokens) {
    if (opSet.has(token)) matches++;
  }
  return matches / queryTokens.length;
}

function hasAnyTokenOverlap(queryTokens: string[], operatorTokens: string[]): boolean {
  if (queryTokens.length === 0 || operatorTokens.length === 0) return false;
  const opSet = new Set(operatorTokens);
  for (const token of queryTokens) {
    if (opSet.has(token)) return true;
  }
  return false;
}

function operatorExpandedTokens(op: OperatorProfile): string[] {
  const text = operatorSemanticText(op);
  return expandSemanticTokens(tokenize(text));
}

function domainExpertiseFitScore(
  queryEmbedding: Float64Array,
  queryTokens: string[],
  op: OperatorProfile
): number {
  const domains = asArray<{ domain?: string }>(op.expert_knowledge)
    .map((d) => (d?.domain ?? "").trim())
    .filter(Boolean);
  if (domains.length === 0) return 0;

  const scored = domains
    .map((domain) => {
      const semantic = cosine(queryEmbedding, embedText(domain));
      const overlap = directTokenOverlap(queryTokens, expandSemanticTokens(tokenize(domain)));
      return 0.75 * semantic + 0.25 * overlap;
    })
    .sort((a, b) => b - a);

  const take = scored.slice(0, Math.min(3, scored.length));
  return take.reduce((sum, s) => sum + s, 0) / take.length;
}

function capabilityFitScore(
  queryEmbedding: Float64Array,
  queryTokens: string[],
  op: OperatorProfile
): number {
  const caps = asArray<string>(op.capabilities)
    .map((c) => c.trim())
    .filter(Boolean);
  if (caps.length === 0) return 0;

  const scored = caps
    .map((capability) => {
      const semantic = cosine(queryEmbedding, embedText(capability));
      const overlap = directTokenOverlap(queryTokens, expandSemanticTokens(tokenize(capability)));
      return 0.65 * semantic + 0.35 * overlap;
    })
    .sort((a, b) => b - a);
  const top1 = scored[0] ?? 0;
  const top2 = scored[1] ?? top1;
  const top3 = scored[2] ?? top2;
  return clamp01(0.7 * top1 + 0.2 * top2 + 0.1 * top3);
}

function phraseHitRate(phrases: string[], candidateTexts: string[]): number {
  if (phrases.length === 0 || candidateTexts.length === 0) return 0;
  let hits = 0;
  for (const phrase of phrases) {
    const hit = candidateTexts.some((c) => c.includes(phrase) || phrase.includes(c));
    if (hit) hits++;
  }
  return clamp01(hits / phrases.length);
}

function exactMatchBoost(
  queryPhrases: string[],
  strongSkillPhrases: string[],
  op: OperatorProfile
): {
  domainBoost: number;
  capabilityBoost: number;
  domainHitRate: number;
  capabilityHitRate: number;
} {
  if (queryPhrases.length === 0) {
    return { domainBoost: 0, capabilityBoost: 0, domainHitRate: 0, capabilityHitRate: 0 };
  }
  const domainTexts = asArray<{ domain?: string }>(op.expert_knowledge)
    .map((d) => normalizeText(d?.domain ?? ""))
    .filter(Boolean);
  const capabilityTexts = asArray<string>(op.capabilities)
    .map((c) => normalizeText(c))
    .filter(Boolean);

  const broadDomainHitRate = phraseHitRate(queryPhrases, domainTexts);
  const broadCapabilityHitRate = phraseHitRate(queryPhrases, capabilityTexts);
  const strongDomainHitRate = phraseHitRate(strongSkillPhrases, domainTexts);
  const strongCapabilityHitRate = phraseHitRate(strongSkillPhrases, capabilityTexts);
  const domainHitRate = clamp01(0.35 * broadDomainHitRate + 0.65 * strongDomainHitRate);
  const capabilityHitRate = clamp01(0.35 * broadCapabilityHitRate + 0.65 * strongCapabilityHitRate);
  return {
    domainBoost: MAX_EXACT_DOMAIN_BOOST * domainHitRate,
    capabilityBoost: MAX_EXACT_CAPABILITY_BOOST * capabilityHitRate,
    domainHitRate,
    capabilityHitRate,
  };
}

function hasMinimumTagOverlap(
  strongSkillPhrases: string[],
  strongSkillTokens: string[],
  op: OperatorProfile,
  operatorTokens: string[]
): boolean {
  if (strongSkillPhrases.length === 0) return true;
  const domainTexts = asArray<{ domain?: string }>(op.expert_knowledge)
    .map((d) => normalizeText(d?.domain ?? ""))
    .filter(Boolean);
  const capabilityTexts = asArray<string>(op.capabilities)
    .map((c) => normalizeText(c))
    .filter(Boolean);
  const phraseOverlap = phraseHitRate(strongSkillPhrases, [...domainTexts, ...capabilityTexts]) > 0;
  const tokenOverlap = hasAnyTokenOverlap(strongSkillTokens, operatorTokens);
  return phraseOverlap || tokenOverlap;
}

function nearPerfectMatchBonus(
  exact: { domainHitRate: number; capabilityHitRate: number },
  domainFit: number,
  capabilityFit: number
): number {
  const combinedHit = (exact.domainHitRate + exact.capabilityHitRate) / 2;
  const combinedFit = (domainFit + capabilityFit) / 2;
  const thresholdPassed =
    exact.domainHitRate >= 0.5 &&
    exact.capabilityHitRate >= 0.35 &&
    domainFit >= 0.45 &&
    capabilityFit >= 0.4;
  if (!thresholdPassed) return 0;
  // Scale the tier bonus by how strong the exact+semantic agreement is.
  return NEAR_PERFECT_MATCH_BONUS * clamp01(0.55 * combinedHit + 0.45 * combinedFit);
}

function calibrateStrongMatchScore(
  baseScore: number,
  exact: { domainHitRate: number; capabilityHitRate: number },
  domainFit: number,
  capabilityFit: number,
  multiSkillCoverage: number
): number {
  const exactAgreement = (exact.domainHitRate + exact.capabilityHitRate) / 2;
  const semanticAgreement = (domainFit + capabilityFit + multiSkillCoverage) / 3;
  const fitStrength = clamp01(0.55 * exactAgreement + 0.45 * semanticAgreement);
  if (fitStrength < 0.35) return baseScore;
  const boosted = baseScore + STRONG_MATCH_CALIBRATION_MAX_BOOST * ((fitStrength - 0.35) / 0.65);
  return clamp01(boosted);
}

function generateContextualReasoning(
  op: OperatorProfile,
  matchedDomains: string[],
  semanticScore: number,
  actLevel: string
): string {
  const parts: string[] = [];
  if (op.summary) parts.push(op.summary.replace(/\.$/, ""));
  if (matchedDomains.length > 0) {
    parts.push(`proven expertise in ${matchedDomains.join(", ")}`);
  }
  if (actLevel.includes("active")) parts.push(actLevel);
  if (op.alignment_tier && !["Ramping", "New"].includes(op.alignment_tier)) {
    parts.push(`${op.alignment_tier} on the network`);
  }
  return parts.length > 0 ? parts.join("; ") + "." : "Profile matches request signals.";
}

function topMatchedDomains(
  queryEmbedding: Float64Array,
  op: OperatorProfile,
  topN = 3
): string[] {
  const domains = asArray<{ domain?: string }>(op.expert_knowledge)
    .map((d) => (d?.domain ?? "").trim())
    .filter(Boolean);
  const scored = domains.map((d) => ({
    domain: d,
    score: cosine(queryEmbedding, embedText(d)),
  }));
  scored.sort((a, b) => b.score - a.score);
  const strong = scored.filter((s) => s.score >= 0.1).slice(0, topN).map((s) => s.domain);
  if (strong.length > 0) return strong;
  return scored.slice(0, 1).map((s) => s.domain);
}

const URGENCY_ACTIVITY_BONUS: Record<UrgencyLevel, number> = {
  today: 0.008,
  this_week: 0.005,
  this_month: 0.002,
  flexible: 0,
  unknown: 0,
};

function rankOperatorsForTask(
  snapshot: MemberIndexSnapshot,
  operators: OperatorProfile[],
  task: TaskLike,
  requiredSkills: string[],
  urgency: UrgencyLevel = "unknown"
): { ranked_results: RankedEntry[] } {
  const integrity = buildIntegrityIndexes(snapshot);
  const sourceText = `${task.title} ${task.requirements}`.trim();
  const queryEmbedding = embedText(sourceText);
  const queryTokens = expandSemanticTokens(tokenize(sourceText));
  const intentFacets = splitIntentFacets(sourceText, requiredSkills);
  const queryPhrases = extractQueryPhrases(sourceText, requiredSkills);
  const strongSkillPhrases = extractStrongSkillPhrases(requiredSkills);
  const strongSkillTokens = expandSemanticTokens(tokenize(strongSkillPhrases.join(" ")));
  const facetEmbeddings = intentFacets.map((f) => embedText(f));

  const retrieved = operators
    .map((operator) => {
      const opEmbedding = embedText(operatorSemanticText(operator));
      const semanticScore = cosine(queryEmbedding, opEmbedding);
      const opTokens = operatorExpandedTokens(operator);
      const overlapScore = directTokenOverlap(queryTokens, opTokens);
      const retrievalScore = Math.max(semanticScore, overlapScore);
      return { operator, opEmbedding, semanticScore, opTokens, overlapScore, retrievalScore };
    })
    .filter((r) => r.retrievalScore >= MIN_RETRIEVAL_SCORE)
    .sort((a, b) => b.retrievalScore - a.retrievalScore)
    .slice(0, Math.max(12, Math.min(30, operators.length)));

  const reranked: RankedEntry[] = [];
  const fallbackPool: RankedEntry[] = [];

  for (const candidate of retrieved) {
    const operator = candidate.operator;
    if (!hasMinimumTagOverlap(strongSkillPhrases, strongSkillTokens, operator, candidate.opTokens)) {
      continue;
    }
    const opId = operator.operator_id ?? "";
    const wallet = operator.wallet_address ?? "";
    const isHardBlocked =
      integrity.blockedOperatorIds.has(opId) ||
      integrity.blockedWalletAddresses.has(wallet) ||
      integrity.unauthorizedOperatorIds.has(opId);
    if (isHardBlocked) continue;

    const facetCoverageScores = facetEmbeddings.map((facetEmbedding) =>
      cosine(facetEmbedding, candidate.opEmbedding)
    );
    const multiSkillCoverage =
      facetCoverageScores.length > 0
        ? facetCoverageScores.reduce((a, b) => a + b, 0) / facetCoverageScores.length
        : candidate.semanticScore;

    const alignmentScoreNorm = clamp01(Number(operator.alignment_score ?? 0) / 100);
    const sybilScoreNorm = clamp01(Number(operator.sybil_score ?? 0) / 100);
    const sybilPenalty = getSybilPenaltyMultiplier(operator.sybil_risk, operator.sybil_score);
    const actScore = computeActivityScore(operator);
    const domainFit = domainExpertiseFitScore(queryEmbedding, queryTokens, operator);
    const capabilityFit = capabilityFitScore(queryEmbedding, queryTokens, operator);
    const exactBoost = exactMatchBoost(queryPhrases, strongSkillPhrases, operator);
    const perfectBoost = nearPerfectMatchBonus(exactBoost, domainFit, capabilityFit);

    const urgencyBonus =
      URGENCY_ACTIVITY_BONUS[urgency] * Math.min(1, actScore * 2);

    const weightedRaw =
      SCORING_WEIGHTS.semantic * candidate.semanticScore +
      SCORING_WEIGHTS.directOverlap * candidate.overlapScore +
      SCORING_WEIGHTS.multiSkill * multiSkillCoverage +
      SCORING_WEIGHTS.domainExpertise * domainFit +
      SCORING_WEIGHTS.capabilityFit * capabilityFit +
      SCORING_WEIGHTS.alignment * alignmentScoreNorm +
      SCORING_WEIGHTS.sybil * sybilScoreNorm +
      SCORING_WEIGHTS.activity * actScore +
      exactBoost.domainBoost +
      exactBoost.capabilityBoost +
      perfectBoost +
      urgencyBonus;
    const rawScore = clamp01(weightedRaw * sybilPenalty);
    const overallMatchScore = calibrateStrongMatchScore(
      rawScore,
      exactBoost,
      domainFit,
      capabilityFit,
      multiSkillCoverage
    );
    if (overallMatchScore < MIN_FINAL_SCORE) continue;

    const matchedDomains = topMatchedDomains(queryEmbedding, operator, 3);
    const confidence = clamp01(
      overallMatchScore +
        (multiSkillCoverage >= 0.55 ? 0.03 : 0) +
        (candidate.overlapScore >= 0.4 ? 0.02 : 0)
    );

    const actLevel = activityLevel(operator);
    const capHighlights = asArray<string>(operator.capabilities)
      .filter(Boolean)
      .slice(0, 2);

    const entry: RankedEntry = {
      rank: 0,
      operator_id: opId || wallet,
      wallet_address: wallet,
      confidence: Number(confidence.toFixed(4)),
      overall_match_score: Number(overallMatchScore.toFixed(4)),
      matched_expert_domains: matchedDomains,
      alignment_score: operator.alignment_score ?? null,
      sybil_risk: operator.sybil_risk ?? null,
      reasoning: generateContextualReasoning(operator, matchedDomains, candidate.semanticScore, actLevel),
      summary: operator.summary ?? null,
      capability_highlights: capHighlights,
      activity_level: actLevel,
    };
    fallbackPool.push(entry);
    if (overallMatchScore >= MIN_FINAL_SCORE) reranked.push(entry);
  }

  reranked.sort((a, b) => b.overall_match_score - a.overall_match_score);
  let qualityFloor = MIN_FINAL_SCORE;
  if (reranked.length > 1) {
    const topScore = reranked[0].overall_match_score;
    qualityFloor = Math.max(MIN_FINAL_SCORE, topScore - MIN_RELATIVE_TOP_SCORE_GAP);
    const qualityFiltered = reranked.filter(
      (item, idx) => idx === 0 || item.overall_match_score >= qualityFloor
    );
    reranked.length = 0;
    reranked.push(...qualityFiltered);
  }
  reranked.forEach((item, i) => {
    item.rank = i + 1;
  });

  // Ensure at least 2 options when we have at least one strong match and additional candidates.
  if (reranked.length === 1 && fallbackPool.length > 1) {
    const seen = new Set(reranked.map((r) => r.operator_id));
    const backup = [...fallbackPool]
      .sort((a, b) => b.overall_match_score - a.overall_match_score)
      .find((c) => !seen.has(c.operator_id) && c.overall_match_score >= qualityFloor);
    if (backup && backup.overall_match_score >= qualityFloor) {
      reranked.push({
        ...backup,
        rank: 2,
        confidence: Number(Math.max(0.05, backup.confidence * 0.9).toFixed(4)),
        reasoning: `${backup.reasoning} (secondary option)`,
      });
    }
  }

  return { ranked_results: reranked };
}

export interface RankedEntry {
  rank: number;
  operator_id: string;
  wallet_address: string;
  confidence: number;
  overall_match_score: number;
  matched_expert_domains: string[];
  alignment_score: number | null;
  sybil_risk: string | null;
  reasoning: string;
  summary: string | null;
  capability_highlights: string[];
  activity_level: string;
}

export interface MatchResult {
  ok: boolean;
  request_id: string;
  request_text: string;
  tags: string[];
  top_matches: RankedEntry[];
}

export function runMemberMatchWithDataset(
  payload: MatchInput,
  dataset: MemberIndexSnapshot
): MatchResult {
  const normalized = normalizeMemberMatchPayload(payload);
  if (!normalized.user_request_text && normalized.required_skills.length === 0) {
    return {
      ok: false,
      request_id: normalized.request_id,
      request_text: normalized.user_request_text,
      tags: normalized.required_skills,
      top_matches: [],
    };
  }
  const constrained = applyOperatorConstraints(
    dataset.operator_profiles ?? [],
    normalized.constraints
  );
  const task = buildTaskFromQuery(normalized);
  const { ranked_results } = rankOperatorsForTask(
    dataset,
    constrained,
    task,
    normalized.required_skills,
    normalized.urgency
  );
  const top = ranked_results.slice(0, normalized.top_k);

  return {
    ok: true,
    request_id: normalized.request_id,
    request_text: normalized.user_request_text,
    tags: normalized.required_skills,
    top_matches: top,
  };
}
