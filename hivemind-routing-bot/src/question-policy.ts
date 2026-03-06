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
  | "q_situation"
  | "q_hard_thing"
  | "q_trust_level"
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
  // ── Q1: Situation — context-first, narrative framing ───────────────────
  {
    id: "q_situation",
    field: "objective_or_deliverable",
    impact: INTAKE_IMPACT_WEIGHTS.objective_or_deliverable,
    prompt: "What's happening and what needs to happen? Be specific — tool names, systems, and tech stack you're dealing with all help.\n\nFor example: \"We have a bonding curve contract draining gas on every trade — think it's an O(n) loop in Solidity\" or \"Building a Discord bot that reads live XRPL data and posts daily PFT summaries to our server\"",
    contextualPrompt: (brief) => {
      const intent = detectIntent(brief.objective ?? "");
      switch (intent) {
        case "fix":
          return "What's broken and what should be happening instead? Include any error messages, systems involved, or what you've already tried.\n\nFor example: \"Auth fails on mobile but works on desktop — JWT validation seems fine but sessions drop after redirect\" or \"Transactions timeout after 30s, happens with high-load batches only\"";
        case "audit":
          return "What are you trying to protect, and what keeps you up at night about it?\n\nFor example: \"Solidity contracts going to mainnet in 2 weeks — bonding curve + staking logic, haven't been externally reviewed\" or \"Smart contract holding user funds, built 6 months ago, want a second set of eyes before we scale\"";
        case "consult":
          return "What's the decision you're trying to make, and what makes it hard?\n\nFor example: \"Deciding between L2s for our DeFi protocol — weighing cost, speed, and ecosystem\" or \"Build vs. buy for our auth layer — team is small and timeline is tight\"";
        case "integrate":
          return "Which systems need to talk to each other, and what does that interaction need to look like?\n\nFor example: \"XRPL backend + Stripe billing — sync payment status with on-chain actions\" or \"Discord bot + live on-chain data — reads XRPL memos and posts formatted summaries\"";
        case "design":
          return "What experience are you designing, and who will use it?\n\nFor example: \"Dashboard for DAO contributors tracking PFT earnings — needs to feel professional, not crypto-bro\" or \"Onboarding flow for non-crypto users entering a tokenized marketplace\"";
        case "build":
          return "What are you building and what needs to be true for it to be done?\n\nFor example: \"Token dashboard for our DAO — contributors should see earnings, task history, and leaderboard\" or \"Discord bot that reads XRPL memo data and posts daily PFT summaries with charts\"";
        default:
          return "What's happening and what needs to happen? Be specific — tool names, systems, and tech stack you're dealing with all help.\n\nFor example: \"We have a bonding curve contract draining gas on every trade\" or \"Building a Discord bot that reads live XRPL data and posts daily summaries\"";
      }
    },
  },

  // ── Q2: Hard thing — surfaces primary skill, forces prioritization ──────
  {
    id: "q_hard_thing",
    field: "must_have_skills",
    impact: INTAKE_IMPACT_WEIGHTS.must_have_skills,
    prompt: "What's the single hardest part of this — the thing most people who try would get wrong?\n\nFor example: \"The hard part is gas optimization in the bonding curve, not writing Solidity\" or \"Reading XRPL ledger data in real-time without falling behind under load\"",
    contextualPrompt: (brief) => {
      const intent = detectIntent(brief.objective ?? "");
      const obj = truncate(brief.objective ?? "this");
      switch (intent) {
        case "fix":
          return `For fixing ${obj} — where exactly is it breaking? What's the most confusing or elusive part?\n\nFor example: "It works fine in isolation but fails under concurrent load — can't reproduce reliably" or "Error only shows on mobile Safari, logs show nothing"`;
        case "audit":
          return `For auditing ${obj} — what part of the code worries you most? The thing you'd least want a security researcher to find.\n\nFor example: "The reentrancy guard on our withdrawal function" or "The oracle price feed has no staleness check"`;
        case "consult":
          return `For ${obj} — what's the core tension nobody seems to agree on?\n\nFor example: "We need speed but can't sacrifice decentralization" or "Custom vs. off-the-shelf — our edge case breaks every existing solution"`;
        case "integrate":
          return `For integrating ${obj} — what's the most brittle point? Where could this break in production?\n\nFor example: "Race conditions when XRPL ledger and our database get out of sync" or "Stripe webhooks arriving out of order"`;
        case "build":
          return `For building ${obj} — what's the technically most complex part? The thing that will determine if this succeeds.\n\nFor example: "The real-time data pipeline under load" or "The state machine for escrow release conditions"`;
        case "design":
          return `For designing ${obj} — what's the UX problem that's hardest to solve?\n\nFor example: "Non-crypto users don't understand wallet addresses but need to see them" or "Mobile and desktop need the same data but completely different layouts"`;
        default:
          return `For ${obj} — what's the single hardest part? The thing most people who try would get wrong.\n\nFor example: "The real-time sync under load" or "The security boundary between on-chain and off-chain state"`;
      }
    },
  },

  // ── Q3: Trust level — unlocks alignment_preference (15% of match score) ─
  {
    id: "q_trust_level",
    field: "alignment_preference",
    impact: INTAKE_IMPACT_WEIGHTS.alignment_preference,
    prompt: "How much track record do you need from whoever you work with on this?\n\n• Proven — I need reliability above all (Established operators or higher)\n• Good track record preferred — but open to strong contributors\n• Open to both — show me the best skill match regardless of seniority",
  },

  // ── Q4+: Adaptive fallbacks (low priority, rarely reached) ──────────────
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
    impact: INTAKE_IMPACT_WEIGHTS.must_have_skills - 0.01,
    prompt: "What are the top 3 skills you want in the operator?\n\nFor example: \"React\", \"TypeScript\", and \"Auth debugging\"",
    contextualPrompt: (brief) => {
      const obj = truncate(brief.objective ?? "this");
      const intent = detectIntent(brief.objective ?? "");
      if (intent === "fix") {
        return `For fixing ${obj} — what are the top 3 skills you need?\n\nFor example: "React debugging", "Node API tracing", and "PostgreSQL query tuning"`;
      }
      if (intent === "audit") {
        return `For auditing ${obj} — what are the top 3 skills you want?\n\nFor example: "Solidity security", "Threat modeling", and "Static analysis"`;
      }
      if (brief.domain.length > 0) {
        const tags = brief.domain.slice(0, 2).join(" + ");
        return `I see ${tags} in your request. What are the top 3 skills you want most?\n\nFor example: "${tags}", "testing", and "performance tuning"`;
      }
      return `To match you well for ${obj} — what are the top 3 skills you want?\n\nFor example: "React", "TypeScript", and "DevOps"`;
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

  // Deprioritize budget and constraints — they contribute least to match quality.
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

/** Q1 policy: always ask for situation (context-first, narrative framing). */
export function getFirstQuestionSituation(brief: MatchBrief): QuestionTemplate {
  const q = QUESTION_BANK.find((t) => t.id === "q_situation");
  if (!q) {
    return {
      id: "q_situation",
      field: "objective_or_deliverable",
      impact: INTAKE_IMPACT_WEIGHTS.objective_or_deliverable,
      prompt: "What's happening and what needs to happen? Be specific — tool names, systems, and tech stack you're dealing with all help.",
    };
  }
  const contextual = q.contextualPrompt?.(brief);
  return { ...q, prompt: contextual ?? q.prompt };
}

/** Q2 policy: ask for the hardest part — forces skill prioritization and surfaces primary capability. */
export function getSecondQuestionHardThing(brief: MatchBrief): QuestionTemplate {
  const q = QUESTION_BANK.find((t) => t.id === "q_hard_thing");
  if (!q) {
    return {
      id: "q_hard_thing",
      field: "must_have_skills",
      impact: INTAKE_IMPACT_WEIGHTS.must_have_skills,
      prompt: "What's the single hardest part of this — the thing most people who try would get wrong?",
    };
  }
  const contextual = q.contextualPrompt?.(brief);
  return { ...q, prompt: contextual ?? q.prompt };
}

/** Q3 policy: always ask trust level — unlocks alignment_preference (15% of match score). */
export function getThirdQuestionTrustLevel(_brief: MatchBrief): QuestionTemplate {
  const q = QUESTION_BANK.find((t) => t.id === "q_trust_level");
  if (!q) {
    return {
      id: "q_trust_level",
      field: "alignment_preference",
      impact: INTAKE_IMPACT_WEIGHTS.alignment_preference,
      prompt: "How much track record do you need from whoever you work with on this?\n\n• Proven — I need reliability above all (Established operators or higher)\n• Good track record preferred — but open to strong contributors\n• Open to both — show me the best skill match regardless of seniority",
    };
  }
  return q;
}

/** High-yield fallback when we must ask one clarifier for vague low-confidence requests. */
export function getFallbackQuestionForAmbiguous(brief: MatchBrief): QuestionTemplate | null {
  const q = QUESTION_BANK.find((t) => t.id === "q_situation") ?? QUESTION_BANK.find((t) => t.id === "q_objective");
  if (!q) return null;
  const contextual = q.contextualPrompt?.(brief);
  return { ...q, prompt: contextual ?? q.prompt };
}
