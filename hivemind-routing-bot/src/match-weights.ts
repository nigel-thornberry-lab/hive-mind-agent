import type { MissingField } from "./match-brief.js";

/**
 * Single source of truth for intake field impact weights.
 * Used by both:
 * - question selection priority
 * - brief confidence scoring
 */
export const INTAKE_IMPACT_WEIGHTS: Record<MissingField, number> = {
  objective_or_deliverable: 0.3,
  must_have_skills: 0.25,
  timeline_or_urgency: 0.2,
  budget: 0.15,
  constraints: 0.1,
};
