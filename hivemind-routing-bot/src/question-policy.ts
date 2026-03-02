import type { MatchBrief, MissingField } from "./match-brief.js";
import { INTAKE_IMPACT_WEIGHTS } from "./match-weights.js";

export type QuestionId =
  | "q_objective"
  | "q_deliverable"
  | "q_must_have"
  | "q_timeline"
  | "q_budget"
  | "q_constraints";

export interface QuestionTemplate {
  id: QuestionId;
  field: MissingField;
  impact: number;
  prompt: string;
  contextualPrompt?: (brief: MatchBrief) => string;
}

const QUESTION_BANK: QuestionTemplate[] = [
  {
    id: "q_objective",
    field: "objective_or_deliverable",
    impact: INTAKE_IMPACT_WEIGHTS.objective_or_deliverable,
    prompt: "What exact outcome do you want in 1 sentence?",
  },
  {
    id: "q_deliverable",
    field: "objective_or_deliverable",
    impact: INTAKE_IMPACT_WEIGHTS.objective_or_deliverable - 0.01,
    prompt: "What should be delivered (MVP, integration, audit, or docs)?",
    contextualPrompt: (brief) => {
      if (brief.domain.length > 0) {
        return `For your ${brief.domain.slice(0, 2).join(" + ")} work, what's the deliverable (MVP, integration, audit, or docs)?`;
      }
      return "What should be delivered (MVP, integration, audit, or docs)?";
    },
  },
  {
    id: "q_must_have",
    field: "must_have_skills",
    impact: INTAKE_IMPACT_WEIGHTS.must_have_skills,
    prompt: "What's the one must-have skill or technology for this?",
    contextualPrompt: (brief) => {
      if (brief.objective) {
        return "What's the one must-have skill or technology for this?";
      }
      return "What specific skills or technologies are non-negotiable?";
    },
  },
  {
    id: "q_timeline",
    field: "timeline_or_urgency",
    impact: INTAKE_IMPACT_WEIGHTS.timeline_or_urgency,
    prompt: "When do you need this done (today, this week, this month, or flexible)?",
  },
  {
    id: "q_budget",
    field: "budget",
    impact: INTAKE_IMPACT_WEIGHTS.budget,
    prompt: "What's your rough PFT budget range?",
  },
  {
    id: "q_constraints",
    field: "constraints",
    impact: INTAKE_IMPACT_WEIGHTS.constraints,
    prompt: "Any constraints (timezone, trust level, or stack preference)?",
  },
];

export function getQuestionPromptById(id: string | null): string | null {
  if (!id) return null;
  const found = QUESTION_BANK.find((q) => q.id === id);
  return found?.prompt ?? null;
}

export function chooseNextQuestion(brief: MatchBrief): QuestionTemplate | null {
  const missing = new Set(brief.missing_fields);
  const asked = new Set(brief.asked_question_ids);

  const candidates = QUESTION_BANK
    .filter((q) => missing.has(q.field))
    .filter((q) => !asked.has(q.id))
    .sort((a, b) => b.impact - a.impact);

  const chosen = candidates[0] ?? null;
  if (!chosen) return null;

  const contextual = chosen.contextualPrompt?.(brief);
  if (contextual) {
    return { ...chosen, prompt: contextual };
  }
  return chosen;
}
