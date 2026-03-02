import {
  applyUserMessage,
  attachRankedResult,
  closeBrief,
  createMatchBrief,
  markQuestionAsked,
  markReady,
  recomputeDerived,
  shouldStopClarifying,
  type MatchBrief,
  type RankedCandidate,
} from "./match-brief.js";
import { chooseNextQuestion } from "./question-policy.js";

export type ConversationAction =
  | { type: "ask"; question_id: string; prompt: string; brief: MatchBrief }
  | { type: "rank"; provisional: boolean; brief: MatchBrief }
  | { type: "close"; reason: string; brief: MatchBrief }
  | { type: "noop"; brief: MatchBrief };

export interface StateMachineInput {
  requester_wallet: string;
  conversation_id: string;
  text: string;
  existing_brief?: MatchBrief | null;
}

export function startOrContinueMatchBrief(input: StateMachineInput): ConversationAction {
  const raw = input.text.trim();
  const lower = raw.toLowerCase();
  const forceRun = /\brun now\b/.test(lower);
  const reset = /\bnew request\b/.test(lower);
  const close = /\b(cancel|close|stop)\b/.test(lower);

  let brief = input.existing_brief ?? null;
  if (!brief || reset || brief.stage === "closed") {
    brief = createMatchBrief({
      requester_wallet: input.requester_wallet,
      conversation_id: input.conversation_id,
      initial_text: raw,
    });
  } else {
    brief = applyUserMessage(brief, { message: raw });
  }

  if (close) {
    return { type: "close", reason: "user_closed", brief: closeBrief(brief, "Closed by user") };
  }

  brief = recomputeDerived(brief);
  // Require at least one clarifying question unless user explicitly forces ranking.
  if (!forceRun && brief.questions_asked === 0) {
    const q0 = chooseNextQuestion(brief);
    if (q0) {
      const asked0 = markQuestionAsked(brief, q0.id);
      return {
        type: "ask",
        question_id: q0.id,
        prompt: q0.prompt,
        brief: asked0,
      };
    }
  }
  if (shouldStopClarifying(brief, forceRun)) {
    return { type: "rank", provisional: brief.brief_confidence < 0.75, brief: markReady(brief) };
  }

  const q = chooseNextQuestion(brief);
  if (!q) {
    return { type: "rank", provisional: brief.brief_confidence < 0.75, brief: markReady(brief) };
  }

  const asked = markQuestionAsked(brief, q.id);
  return {
    type: "ask",
    question_id: q.id,
    prompt: q.prompt,
    brief: asked,
  };
}

export function finalizeRankedBrief(
  brief: MatchBrief,
  topMatches: RankedCandidate[],
  provisional: boolean
): MatchBrief {
  return attachRankedResult(brief, topMatches, provisional);
}

export interface BriefStore {
  get(key: string): MatchBrief | null;
  set(key: string, brief: MatchBrief): void;
  delete(key: string): void;
}

export interface ClarificationFunnelStats {
  briefs_started: number;
  questions_asked: number;
  questions_answered: number;
  run_now_skips: number;
  ranked_total: number;
  ranked_provisional: number;
  abandoned_expired: number;
  closed_by_user: number;
}

export const BRIEF_TTL_MS = 15 * 60 * 1000;
export const RANKED_BRIEF_TTL_MS = 5 * 60 * 1000;
const MAX_STORE_SIZE = 2000;

export class InMemoryBriefStore implements BriefStore {
  private readonly store = new Map<string, { brief: MatchBrief; expiresAt: number }>();
  private readonly ttlMs: number;
  private readonly rankedTtlMs: number;

  readonly funnel: ClarificationFunnelStats = {
    briefs_started: 0,
    questions_asked: 0,
    questions_answered: 0,
    run_now_skips: 0,
    ranked_total: 0,
    ranked_provisional: 0,
    abandoned_expired: 0,
    closed_by_user: 0,
  };

  constructor(ttlMs = BRIEF_TTL_MS, rankedTtlMs = RANKED_BRIEF_TTL_MS) {
    this.ttlMs = ttlMs;
    this.rankedTtlMs = rankedTtlMs;
  }

  get(key: string): MatchBrief | null {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      this.funnel.abandoned_expired++;
      return null;
    }
    return entry.brief;
  }

  set(key: string, brief: MatchBrief): void {
    const ttl =
      brief.stage === "ranked" || brief.stage === "closed"
        ? this.rankedTtlMs
        : this.ttlMs;
    this.store.set(key, { brief, expiresAt: Date.now() + ttl });
    if (this.store.size > MAX_STORE_SIZE) this.sweep();
  }

  delete(key: string): void {
    this.store.delete(key);
  }

  recordBriefStarted(): void { this.funnel.briefs_started++; }
  recordQuestionAsked(): void { this.funnel.questions_asked++; }
  recordQuestionAnswered(): void { this.funnel.questions_answered++; }
  recordRunNowSkip(): void { this.funnel.run_now_skips++; }
  recordRanked(provisional: boolean): void {
    this.funnel.ranked_total++;
    if (provisional) this.funnel.ranked_provisional++;
  }
  recordClosed(): void { this.funnel.closed_by_user++; }

  sweep(): number {
    const now = Date.now();
    let removed = 0;
    for (const [key, entry] of this.store) {
      if (now > entry.expiresAt) {
        this.store.delete(key);
        removed++;
      }
    }
    this.funnel.abandoned_expired += removed;
    return removed;
  }

  get size(): number {
    return this.store.size;
  }
}
