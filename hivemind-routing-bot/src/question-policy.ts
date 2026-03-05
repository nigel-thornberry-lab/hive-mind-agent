import type { MatchBrief, MissingField } from "./match-brief.js";
import { INTAKE_IMPACT_WEIGHTS } from "./match-weights.js";

// ── Intent detection ────────────────────────────────────────────────────────

export type UserIntent =
  | "build"
  | "fix"
  | "audit"
  | "consult"
  | "integrate"
  | "design"
  | "general";

const INTENT_PATTERNS: Array<[UserIntent, RegExp]> = [
  ["fix", /\b(fix|debug|broken|bug|issue|error|crash|failing|regression|troubleshoot)\w*\b/i],
  ["audit", /\b(audit|review|assess|evaluate|pentest|vulnerability|security review)\w*\b/i],
  ["integrate", /\b(integrat|connect|migrat|webhook|api\s*hook|bridge|sync)\w*\b/i],
  ["design", /\b(design|wireframe|mockup|figma|prototype|layout|information architecture)\w*\b|\b(ui|ux)\b/i],
  ["consult", /\b(consult|advi[cs]e|guidance|strategy|help me understand|second opinion|mentor)\w*\b/i],
  ["build", /\b(build|creat|develop|mak|launch|ship|implement|new\s+\w+|from scratch|greenfield)\w*\b/i],
];

export function detectIntent(text: string): UserIntent {
  for (const [intent, pattern] of INTENT_PATTERNS) {
    if (pattern.test(text)) return intent;
  }
  return "general";
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function truncate(text: string, max = 60): string {
  if (text.length <= max) return text;
  return text.slice(0, max).replace(/\s+\S*$/, "") + "…";
}

function domainLabel(brief: MatchBrief): string {
  const tags = brief.domain.length > 0
    ? brief.domain.slice(0, 3)
    : brief.stack.length > 0
      ? brief.stack.slice(0, 3)
      : [];
  return tags.join(" + ");
}

// ── Question types ──────────────────────────────────────────────────────────

export type QuestionId =
  | "q_objective"
  | "q_deliverable"
  | "q_must_have"
  | "q_timeline"
  | "q_budget"
  | "q_constraints"
  | "q_confirm";

export interface QuestionTemplate {
  id: QuestionId;
  field: MissingField;
  impact: number;
  prompt: string;
  contextualPrompt?: (brief: MatchBrief) => string;
}

// ── Confirmation question for high-confidence briefs ────────────────────────

export function buildConfirmationQuestion(brief: MatchBrief): QuestionTemplate {
  const obj = truncate(brief.objective ?? "your request");
  const domain = domainLabel(brief);
  const intent = detectIntent(brief.objective ?? "");

  const parts = [`Got it — ${obj}`];

  if (domain) {
    parts.push(`I'll prioritize operators with ${domain} experience.`);
  }

  const closers: Record<UserIntent, string> = {
    build: "Anything else I should know before matching — like a deadline or deliverable format?",
    fix: "Anything else I should know — like what you've already tried or where it's breaking?",
    audit: "Anything else I should know — like what you're most worried about?",
    consult: "Anything else I should know — like the decision you're trying to make?",
    integrate: "Anything else I should know — like which systems need to connect?",
    design: "Anything else I should know — like target platform or existing brand guidelines?",
    general: "Anything else I should know before I find the best match?",
  };

  parts.push(closers[intent]);
  parts.push("");
  parts.push('For example: "needs to be done this week" or "nothing else, match me"');

  return {
    id: "q_confirm",
    field: "constraints",
    impact: 0,
    prompt: parts.join("\n"),
  };
}

// ── Question bank ───────────────────────────────────────────────────────────

const QUESTION_BANK: QuestionTemplate[] = [
  {
    id: "q_objective",
    field: "objective_or_deliverable",
    impact: INTAKE_IMPACT_WEIGHTS.objective_or_deliverable,
    prompt: "What are you looking to get done? A sentence or two is perfect.\n\nFor example: \"Build a token dashboard for my DAO\" or \"Audit my smart contracts before launch\"",
  },
  {
    id: "q_deliverable",
    field: "objective_or_deliverable",
    impact: INTAKE_IMPACT_WEIGHTS.objective_or_deliverable - 0.01,
    prompt: "What should the end result look like?",
    contextualPrompt: (brief) => {
      const intent = detectIntent(brief.objective ?? "");
      const obj = truncate(brief.objective ?? "your project");

      if (intent === "build") {
        return `Got it — ${obj}\n\nWhat should the end result look like?\n\nFor example: "working MVP I can demo", "production API with docs", or "technical spec"`;
      }
      if (intent === "fix") {
        return `Got it — ${obj}\n\nWhat's happening vs. what you expected?\n\nFor example: "auth fails on mobile but works on desktop" or "transactions timeout after 30s"`;
      }
      if (intent === "audit") {
        return `Got it — ${obj}\n\nWhat's your main concern?\n\nFor example: "security before mainnet", "code quality for investors", or "performance bottlenecks"`;
      }
      if (intent === "consult") {
        return `Got it — ${obj}\n\nWhat decision are you trying to make?\n\nFor example: "which L2 to deploy on", "build custom vs. use existing tooling", or "architecture for scaling"`;
      }
      if (intent === "integrate") {
        return `Got it — ${obj}\n\nWhat systems need to connect?\n\nFor example: "Stripe + our XRPL backend", "Discord bot + on-chain data", or "migrate from Firebase to Supabase"`;
      }
      const domain = domainLabel(brief);
      const domainNote = domain ? ` for your ${domain} work` : "";
      return `Got it — ${obj}\n\nWhat should be delivered${domainNote}?\n\nFor example: "working MVP", "integration + tests", or "audit report"`;
    },
  },
  {
    id: "q_must_have",
    field: "must_have_skills",
    impact: INTAKE_IMPACT_WEIGHTS.must_have_skills,
    prompt: "What's the key skill area?\n\nFor example: \"React + TypeScript\", \"Solidity smart contracts\", or \"Python data pipeline\"",
    contextualPrompt: (brief) => {
      const obj = truncate(brief.objective ?? "this");
      const intent = detectIntent(brief.objective ?? "");

      if (intent === "fix") {
        return `For fixing ${obj} — what tech stack is involved?\n\nFor example: "React frontend", "Node + PostgreSQL backend", or "Solidity contract"`;
      }
      if (intent === "audit") {
        return `For auditing ${obj} — what's the primary language or framework?\n\nFor example: "Solidity", "Rust + Anchor", or "TypeScript + Node"`;
      }
      if (brief.domain.length > 0) {
        const tags = brief.domain.slice(0, 2).join(" + ");
        return `I see ${tags} in your request. Is that the key skill, or is there something more specific?\n\nFor example: "${tags} + testing", or "actually, the main thing is [something else]"`;
      }
      return `To match you well — what's the key skill area for ${obj}?\n\nFor example: "React + TypeScript", "Solidity", "Python ML", or "DevOps"`;
    },
  },
  {
    id: "q_timeline",
    field: "timeline_or_urgency",
    impact: INTAKE_IMPACT_WEIGHTS.timeline_or_urgency,
    prompt: "How soon do you need someone?\n\n• ASAP\n• this week\n• this month\n• no rush",
    contextualPrompt: (brief) => {
      const obj = truncate(brief.objective ?? "this");
      return `How soon do you need help with ${obj}? Just pick one:\n\n• ASAP\n• this week\n• this month\n• no rush`;
    },
  },
  {
    id: "q_budget",
    field: "budget",
    impact: INTAKE_IMPACT_WEIGHTS.budget,
    prompt: "Any budget range in mind? Totally fine to skip.\n\nFor example: \"under 1k PFT\", \"around 5k\", or \"flexible\"",
  },
  {
    id: "q_constraints",
    field: "constraints",
    impact: INTAKE_IMPACT_WEIGHTS.constraints,
    prompt: "Anything else that matters for picking the right person?\n\nFor example: \"US timezone\", \"completed 5+ network tasks\", or \"nothing specific\"",
  },
];

// ── Public API ──────────────────────────────────────────────────────────────

export function getQuestionPromptById(id: string | null): string | null {
  if (!id) return null;
  if (id === "q_confirm") return null;
  const found = QUESTION_BANK.find((q) => q.id === id);
  return found?.prompt ?? null;
}

export function chooseNextQuestion(brief: MatchBrief): QuestionTemplate | null {
  const missing = new Set(brief.missing_fields);
  const asked = new Set(brief.asked_question_ids);

  // Deprioritize budget and constraints — they cause the most abandonment
  // and contribute the least to match quality.
  const candidates = QUESTION_BANK
    .filter((q) => missing.has(q.field))
    .filter((q) => !asked.has(q.id))
    .filter((q) => q.id !== "q_budget" && q.id !== "q_constraints")
    .sort((a, b) => b.impact - a.impact);

  const chosen = candidates[0] ?? null;
  if (!chosen) return null;

  const contextual = chosen.contextualPrompt?.(brief);
  if (contextual) {
    return { ...chosen, prompt: contextual };
  }
  return chosen;
}

/** High-yield fallback when we must ask one clarifier for vague low-confidence requests. */
export function getFallbackQuestionForAmbiguous(brief: MatchBrief): QuestionTemplate | null {
  const q = QUESTION_BANK.find((t) => t.id === "q_must_have") ?? QUESTION_BANK.find((t) => t.id === "q_objective");
  if (!q) return null;
  const contextual = q.contextualPrompt?.(brief);
  return { ...q, prompt: contextual ?? q.prompt };
}
