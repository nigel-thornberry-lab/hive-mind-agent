import type { MissingField } from "./match-brief.js";

/**
 * Single source of truth for intake field impact weights.
 * Used by both:
 * - question selection priority
 * - brief confidence scoring
 */
export const INTAKE_IMPACT_WEIGHTS: Record<MissingField, number> = {
  objective_or_deliverable: 0.30,
  must_have_skills: 0.20,
  alignment_preference: 0.20,
  timeline_or_urgency: 0.15,
  budget: 0.10,
  constraints: 0.05,
};
