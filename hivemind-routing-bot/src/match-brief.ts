import { randomUUID } from "node:crypto";
import { INTAKE_IMPACT_WEIGHTS } from "./match-weights.js";

export type BriefStage = "new" | "clarifying" | "ready" | "ranked" | "closed";
export type Urgency = "today" | "this_week" | "this_month" | "flexible" | "unknown";
export type BudgetBand = "lt_1k" | "1k_5k" | "5k_20k" | "20k_plus" | "unknown";

export type MissingField =
  | "objective_or_deliverable"
  | "must_have_skills"
  | "timeline_or_urgency"
  | "budget"
  | "constraints";

export interface RankedCandidate {
  rank: number;
  operator_id: string;
  wallet_address: string;
  score: number;
  confidence: number;
  factors: Record<string, number>;
  why: string;
  risk_flags: string[];
  open_chat_link: string;
}

export interface MatchBrief {
  brief_id: string;
  requester_wallet: string;
  conversation_id: string;
  stage: BriefStage;
  created_at: string;
  updated_at: string;

  objective: string | null;
  deliverable: string | null;
  domain: string[];
  stack: string[];
  must_have_skills: string[];
  nice_to_have_skills: string[];

  urgency: Urgency;
  timeline_due_at: string | null;
  budget_band: BudgetBand;
  budget_pft: number | null;
  timezone_pref: string | null;
  min_trust_score: number | null;
  exclude_wallets: string[];

  missing_fields: MissingField[];
  brief_confidence: number;
  ambiguity_score: number;
  questions_asked: number;
  max_questions: number;

  last_question_id: string | null;
  asked_question_ids: string[];
  user_messages: Array<{ ts: string; text: string }>;
  system_notes: string[];

  ranked_result: null | {
    generated_at: string;
    top_matches: RankedCandidate[];
    provisional: boolean;
  };
}

export interface CreateMatchBriefInput {
  requester_wallet: string;
  conversation_id: string;
  initial_text?: string;
  max_questions?: number;
}

function uniq(values: string[]): string[] {
  return [...new Set(values.map((v) => v.trim()).filter(Boolean))];
}

function normalizeLowerWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .map((w) => w.trim())
    .filter((w) => w.length > 1);
}

function detectUrgency(text: string): Urgency {
  const t = text.toLowerCase();
  if (/today|asap|urgent|right now|immediately/.test(t)) return "today";
  if (/this week|within a week|7 days|next few days|ship.*week/.test(t)) return "this_week";
  if (/this month|within a month|30 days|next few weeks|couple weeks/.test(t)) return "this_month";
  if (/flexible|no deadline|no rush|whenever|no hurry/.test(t)) return "flexible";
  return "unknown";
}

function detectBudgetBand(text: string): BudgetBand {
  const t = text.toLowerCase();
  if (/under\s*1000|<\s*1000/.test(t)) return "lt_1k";
  if (/1000|1k|2000|2k|3000|3k|4000|4k|5000|5k/.test(t)) return "1k_5k";
  if (/10000|10k|15000|15k|20000|20k/.test(t)) return "5k_20k";
  if (/25000|25k|50000|50k|enterprise|unlimited/.test(t)) return "20k_plus";
  return "unknown";
}

const SKILL_VOCABULARY = new Set([
  // Languages & runtimes
  "typescript", "javascript", "react", "node", "python", "solidity", "rust",
  "go", "java", "swift", "kotlin", "ruby", "php", "sql",
  // Domains
  "escrow", "nft", "marketplace", "backend", "frontend", "api", "schema",
  "routing", "observability", "websocket", "auth", "discord", "llm",
  "blockchain", "web3", "defi", "dao", "tokenomics",
  "dashboard", "devops", "security", "mobile", "testing",
  "integration", "analytics", "marketing", "database", "design",
  "monitoring", "telemetry", "alerting", "metrics", "logging",
  "infrastructure", "deployment", "docker", "kubernetes",
  "forensics", "reverse", "decompilation",
  // Specific tech
  "nextjs", "graphql", "postgresql", "mongodb", "redis",
  "terraform", "aws", "gcp", "azure", "vercel",
  "openai", "langchain", "rag", "embedding",
  "stripe", "oauth", "jwt", "sso",
  "figma", "ux",
]);

const BIGRAM_SKILLS = new Set([
  "smart contract", "real time", "machine learning", "data pipeline",
  "api integration", "schema mapping", "reverse engineering",
  "memory forensics", "game engine", "discord bot",
  "react native", "ai agent", "llm api",
  "information architecture", "design system", "state management",
  "ad creative", "competitive intelligence", "prompt engineering",
]);

function extractSkills(text: string): string[] {
  const words = normalizeLowerWords(text);
  const singles = words.filter((w) => SKILL_VOCABULARY.has(w));

  const bigramMatches: string[] = [];
  for (let i = 0; i < words.length - 1; i++) {
    const bi = `${words[i]} ${words[i + 1]}`;
    if (BIGRAM_SKILLS.has(bi)) bigramMatches.push(bi);
  }
  return uniq([...singles, ...bigramMatches]);
}

export function computeMissingFields(brief: MatchBrief): MissingField[] {
  const missing: MissingField[] = [];
  if (!brief.objective && !brief.deliverable) missing.push("objective_or_deliverable");
  if (brief.must_have_skills.length === 0 && brief.domain.length === 0) missing.push("must_have_skills");
  if (!brief.timeline_due_at && brief.urgency === "unknown") missing.push("timeline_or_urgency");
  if (brief.budget_pft == null && brief.budget_band === "unknown") missing.push("budget");
  if (!brief.timezone_pref && brief.min_trust_score == null) missing.push("constraints");
  return missing;
}

export function computeBriefConfidence(brief: MatchBrief): number {
  const objective = brief.objective || brief.deliverable ? 1 : 0;
  const mustHave = brief.must_have_skills.length > 0 || brief.domain.length > 0 ? 1 : 0;
  const timeline = brief.timeline_due_at || brief.urgency !== "unknown" ? 1 : 0;
  const budget = brief.budget_pft != null || brief.budget_band !== "unknown" ? 1 : 0;
  const constraints = brief.timezone_pref || brief.min_trust_score != null ? 1 : 0;

  const fieldScore =
    INTAKE_IMPACT_WEIGHTS.objective_or_deliverable * objective +
    INTAKE_IMPACT_WEIGHTS.must_have_skills * mustHave +
    INTAKE_IMPACT_WEIGHTS.timeline_or_urgency * timeline +
    INTAKE_IMPACT_WEIGHTS.budget * budget +
    INTAKE_IMPACT_WEIGHTS.constraints * constraints;

  // User answers provide context even when keyword detectors can't extract
  // structured fields — the raw text still feeds into the ranking prompt.
  // Credit up to 0.15 for answered questions (0.1 per answer, capped).
  const answeredCount = Math.max(0, brief.user_messages.length - 1);
  const interactionBonus = Math.min(0.15, answeredCount * 0.1);

  return Number(Math.min(1, fieldScore + interactionBonus).toFixed(4));
}

export function computeAmbiguityScore(brief: MatchBrief): number {
  const text = `${brief.objective ?? ""} ${brief.deliverable ?? ""}`.trim();
  const tokenCount = normalizeLowerWords(text).length;
  const vague = /(help|project|something|web3|build)/i.test(text) ? 1 : 0;
  const sparsePenalty = tokenCount < 5 ? 0.3 : 0;
  const skillPenalty = brief.must_have_skills.length === 0 ? 0.2 : 0;
  return Number(Math.max(0, Math.min(1, vague * 0.4 + sparsePenalty + skillPenalty)).toFixed(4));
}

export function recomputeDerived(brief: MatchBrief): MatchBrief {
  const missing = computeMissingFields(brief);
  const confidence = computeBriefConfidence(brief);
  const ambiguity = computeAmbiguityScore(brief);
  return {
    ...brief,
    missing_fields: missing,
    brief_confidence: confidence,
    ambiguity_score: ambiguity,
    updated_at: new Date().toISOString(),
  };
}

export function createMatchBrief(input: CreateMatchBriefInput): MatchBrief {
  const now = new Date().toISOString();
  const text = (input.initial_text ?? "").trim();
  const skills = extractSkills(text);

  const base: MatchBrief = {
    brief_id: randomUUID(),
    requester_wallet: input.requester_wallet,
    conversation_id: input.conversation_id,
    stage: "new",
    created_at: now,
    updated_at: now,

    objective: text || null,
    deliverable: null,
    domain: skills,
    stack: skills.filter((s) => ["typescript", "javascript", "react", "node", "python", "solidity", "rust"].includes(s)),
    must_have_skills: [],
    nice_to_have_skills: [],

    urgency: detectUrgency(text),
    timeline_due_at: null,
    budget_band: detectBudgetBand(text),
    budget_pft: null,
    timezone_pref: null,
    min_trust_score: null,
    exclude_wallets: [],

    missing_fields: [],
    brief_confidence: 0,
    ambiguity_score: 1,
    questions_asked: 0,
    max_questions: Math.max(1, Math.min(5, input.max_questions ?? 3)),

    last_question_id: null,
    asked_question_ids: [],
    user_messages: text ? [{ ts: now, text }] : [],
    system_notes: [],

    ranked_result: null,
  };
  return recomputeDerived(base);
}

export interface ApplyUserMessageOptions {
  message: string;
  timestamp?: string;
}

export function applyUserMessage(brief: MatchBrief, options: ApplyUserMessageOptions): MatchBrief {
  const ts = options.timestamp ?? new Date().toISOString();
  const text = options.message.trim();
  const lower = text.toLowerCase();

  const next: MatchBrief = {
    ...brief,
    user_messages: [...brief.user_messages, { ts, text }],
  };

  if (!next.objective && text.length > 0) next.objective = text;
  if (/(mvp|prototype|dashboard|api|integration|audit|docs|launch)/i.test(text) && !next.deliverable) {
    next.deliverable = text;
  }

  const skills = extractSkills(text);
  if (skills.length > 0) {
    next.must_have_skills = uniq([...next.must_have_skills, ...skills]);
    next.domain = uniq([...next.domain, ...skills]);
    next.stack = uniq([
      ...next.stack,
      ...skills.filter((s) => ["typescript", "javascript", "react", "node", "python", "solidity", "rust"].includes(s)),
    ]);
  }

  if (next.urgency === "unknown") next.urgency = detectUrgency(lower);
  if (next.budget_band === "unknown") next.budget_band = detectBudgetBand(lower);

  const budgetMatch = lower.match(/(\d{2,6})\s*pft/);
  if (budgetMatch) {
    const n = Number(budgetMatch[1]);
    if (Number.isFinite(n)) next.budget_pft = n;
  }

  return recomputeDerived(next);
}

export function shouldStopClarifying(brief: MatchBrief, force = false): boolean {
  if (force) return true;
  if (brief.brief_confidence >= 0.75) return true;
  if (brief.questions_asked >= brief.max_questions) return true;
  const hardReady =
    (brief.objective || brief.deliverable) &&
    (brief.must_have_skills.length > 0 || brief.domain.length > 0) &&
    (brief.timeline_due_at || brief.urgency !== "unknown");
  return Boolean(hardReady);
}

export function markQuestionAsked(brief: MatchBrief, questionId: string): MatchBrief {
  return {
    ...brief,
    stage: "clarifying",
    questions_asked: brief.questions_asked + 1,
    last_question_id: questionId,
    asked_question_ids: uniq([...brief.asked_question_ids, questionId]),
    updated_at: new Date().toISOString(),
  };
}

export function markReady(brief: MatchBrief): MatchBrief {
  return {
    ...brief,
    stage: "ready",
    updated_at: new Date().toISOString(),
  };
}

export function attachRankedResult(
  brief: MatchBrief,
  topMatches: RankedCandidate[],
  provisional: boolean
): MatchBrief {
  return {
    ...brief,
    stage: "ranked",
    ranked_result: {
      generated_at: new Date().toISOString(),
      top_matches: topMatches,
      provisional,
    },
    updated_at: new Date().toISOString(),
  };
}

export function closeBrief(brief: MatchBrief, note?: string): MatchBrief {
  return {
    ...brief,
    stage: "closed",
    system_notes: note ? [...brief.system_notes, note] : brief.system_notes,
    updated_at: new Date().toISOString(),
  };
}
