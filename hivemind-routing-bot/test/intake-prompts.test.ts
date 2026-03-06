/**
 * Tests for the 3-question intake flow:
 * - Q1: situation (context-first narrative)
 * - Q2: hardest part (primary skill, prioritization)
 * - Q3: trust level (alignment_preference → 15% of match score)
 * - Intent detection
 * - Adaptive question count with max 3 mandatory questions
 * - Budget/constraints deprioritized
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import {
  detectIntent,
  chooseNextQuestion,
  buildConfirmationQuestion,
  getFallbackQuestionForAmbiguous,
} from "../src/question-policy.js";
import { startOrContinueMatchBrief } from "../src/conversation-state-machine.js";
import { createMatchBrief, applyUserMessage } from "../src/match-brief.js";

// ── Intent detection ────────────────────────────────────────────────────────

describe("detectIntent", () => {
  it("detects build intent", () => {
    assert.strictEqual(detectIntent("build a token dashboard for my DAO"), "build");
    assert.strictEqual(detectIntent("create a new trading bot"), "build");
    assert.strictEqual(detectIntent("I want to launch a marketplace"), "build");
  });

  it("detects fix intent", () => {
    assert.strictEqual(detectIntent("fix the auth bug on mobile"), "fix");
    assert.strictEqual(detectIntent("my transactions are failing, need to debug"), "fix");
    assert.strictEqual(detectIntent("troubleshoot the broken webhook"), "fix");
  });

  it("detects audit intent", () => {
    assert.strictEqual(detectIntent("audit my smart contracts before launch"), "audit");
    assert.strictEqual(detectIntent("security review of our DeFi protocol"), "audit");
  });

  it("detects consult intent", () => {
    assert.strictEqual(detectIntent("I need advice on which L2 to deploy on"), "consult");
    assert.strictEqual(detectIntent("looking for a strategy consultation"), "consult");
  });

  it("detects integrate intent", () => {
    assert.strictEqual(detectIntent("integrate Stripe with our XRPL backend"), "integrate");
    assert.strictEqual(detectIntent("need to connect Discord bot to on-chain data"), "integrate");
    assert.strictEqual(detectIntent("migrate from Firebase to Supabase"), "integrate");
  });

  it("detects design intent", () => {
    assert.strictEqual(detectIntent("design a dashboard UI for our analytics"), "design");
    assert.strictEqual(detectIntent("need wireframes for the mobile app"), "design");
  });

  it("falls back to general for ambiguous text", () => {
    assert.strictEqual(detectIntent("find me an expert"), "general");
    assert.strictEqual(detectIntent("I need help"), "general");
  });
});

// ── Q1 situation question ───────────────────────────────────────────────────

describe("Q1 situation question", () => {
  it("first question is always q_situation", () => {
    const action = startOrContinueMatchBrief({
      requester_wallet: "r1",
      conversation_id: "c1",
      text: "build a Solidity smart contract this week",
    });
    assert.strictEqual(action.type, "ask");
    if (action.type === "ask") {
      assert.strictEqual(action.question_id, "q_situation");
    }
  });

  it("q_situation prompt includes example answers", () => {
    const action = startOrContinueMatchBrief({
      requester_wallet: "r1",
      conversation_id: "c1",
      text: "find me an expert",
    });
    assert.strictEqual(action.type, "ask");
    if (action.type === "ask") {
      assert.ok(
        /[Ff]or example/.test(action.prompt),
        `q_situation should include examples, got: ${action.prompt}`
      );
    }
  });

  it("fix intent gets diagnostic framing on q_situation", () => {
    const action = startOrContinueMatchBrief({
      requester_wallet: "r1",
      conversation_id: "c1",
      text: "fix authentication bug",
    });
    assert.strictEqual(action.type, "ask");
    if (action.type === "ask") {
      assert.strictEqual(action.question_id, "q_situation");
      assert.ok(
        /broken|already tried|error|happening/i.test(action.prompt),
        `fix intent q_situation should reference diagnostics: ${action.prompt}`
      );
    }
  });

  it("build intent gets build-context framing on q_situation", () => {
    const action = startOrContinueMatchBrief({
      requester_wallet: "r1",
      conversation_id: "c1",
      text: "build a token dashboard",
    });
    assert.strictEqual(action.type, "ask");
    if (action.type === "ask") {
      assert.strictEqual(action.question_id, "q_situation");
      assert.ok(
        /building|building|needs to be true|end result/i.test(action.prompt),
        `build intent q_situation should reference build context: ${action.prompt}`
      );
    }
  });

  it("vague request still gets q_situation first", () => {
    const action = startOrContinueMatchBrief({
      requester_wallet: "r1",
      conversation_id: "c1",
      text: "I need help",
    });
    assert.strictEqual(action.type, "ask");
    if (action.type === "ask") {
      assert.strictEqual(action.question_id, "q_situation");
    }
  });
});

// ── Q2 hard thing question ──────────────────────────────────────────────────

describe("Q2 hard thing question", () => {
  it("second question is always q_hard_thing", () => {
    const t1 = startOrContinueMatchBrief({
      requester_wallet: "r1",
      conversation_id: "c1",
      text: "build a Solidity audit tool",
    });
    assert.strictEqual(t1.type, "ask");
    assert.strictEqual(t1.question_id, "q_situation");

    const t2 = startOrContinueMatchBrief({
      requester_wallet: "r1",
      conversation_id: "c1",
      text: "We have an EVM smart contract with a bonding curve, going to mainnet next week",
      existing_brief: t1.brief,
    });
    assert.strictEqual(t2.type, "ask");
    if (t2.type === "ask") {
      assert.strictEqual(t2.question_id, "q_hard_thing");
    }
  });

  it("q_hard_thing prompt includes example answers", () => {
    const t1 = startOrContinueMatchBrief({
      requester_wallet: "r1",
      conversation_id: "c1",
      text: "build a token dashboard",
    });
    const t2 = startOrContinueMatchBrief({
      requester_wallet: "r1",
      conversation_id: "c1",
      text: "React frontend + XRPL data pipeline",
      existing_brief: t1.brief,
    });
    assert.strictEqual(t2.type, "ask");
    if (t2.type === "ask") {
      assert.ok(
        /[Ff]or example/.test(t2.prompt),
        `q_hard_thing should include examples, got: ${t2.prompt}`
      );
    }
  });

  it("fix intent gets diagnostic framing on q_hard_thing", () => {
    const t1 = startOrContinueMatchBrief({
      requester_wallet: "r1",
      conversation_id: "c1",
      text: "fix authentication bug",
    });
    const t2 = startOrContinueMatchBrief({
      requester_wallet: "r1",
      conversation_id: "c1",
      text: "JWT validation fails on mobile Safari, works on desktop, no obvious errors in logs",
      existing_brief: t1.brief,
    });
    assert.strictEqual(t2.type, "ask");
    if (t2.type === "ask") {
      assert.strictEqual(t2.question_id, "q_hard_thing");
      assert.ok(
        /breaking|elusive|confusing/i.test(t2.prompt),
        `fix intent q_hard_thing should reference debugging: ${t2.prompt}`
      );
    }
  });

  it("audit intent gets security-focused framing on q_hard_thing", () => {
    const t1 = startOrContinueMatchBrief({
      requester_wallet: "r1",
      conversation_id: "c1",
      text: "audit our Solidity smart contracts",
    });
    const t2 = startOrContinueMatchBrief({
      requester_wallet: "r1",
      conversation_id: "c1",
      text: "bonding curve + staking logic, going to mainnet in 2 weeks",
      existing_brief: t1.brief,
    });
    assert.strictEqual(t2.type, "ask");
    if (t2.type === "ask") {
      assert.strictEqual(t2.question_id, "q_hard_thing");
      assert.ok(
        /worri|security researcher|least want/i.test(t2.prompt),
        `audit intent q_hard_thing should reference security concern: ${t2.prompt}`
      );
    }
  });
});

// ── Q3 trust level question ─────────────────────────────────────────────────

describe("Q3 trust level question", () => {
  it("third question is always q_trust_level", () => {
    const t1 = startOrContinueMatchBrief({
      requester_wallet: "r1",
      conversation_id: "c1",
      text: "build a token dashboard",
    });
    const t2 = startOrContinueMatchBrief({
      requester_wallet: "r1",
      conversation_id: "c1",
      text: "React + XRPL data pipeline with real-time updates",
      existing_brief: t1.brief,
    });
    const t3 = startOrContinueMatchBrief({
      requester_wallet: "r1",
      conversation_id: "c1",
      text: "the real-time data pipeline under load is the hard part",
      existing_brief: t2.brief,
    });
    assert.strictEqual(t3.type, "ask");
    if (t3.type === "ask") {
      assert.strictEqual(t3.question_id, "q_trust_level");
    }
  });

  it("q_trust_level prompt offers proven / preferred / open options", () => {
    const t1 = startOrContinueMatchBrief({ requester_wallet: "r1", conversation_id: "c1", text: "build something" });
    const t2 = startOrContinueMatchBrief({ requester_wallet: "r1", conversation_id: "c1", text: "answer q1", existing_brief: t1.brief });
    const t3 = startOrContinueMatchBrief({ requester_wallet: "r1", conversation_id: "c1", text: "answer q2", existing_brief: t2.brief });
    if (t3.type === "ask") {
      assert.ok(t3.prompt.includes("Proven"), `should offer Proven option: ${t3.prompt}`);
      assert.ok(t3.prompt.includes("Open to both"), `should offer Open option: ${t3.prompt}`);
      assert.ok(t3.prompt.includes("track record"), `should mention track record: ${t3.prompt}`);
    }
  });

  it("'proven' answer sets min_trust_score to 70 and alignment_preference", () => {
    const brief = createMatchBrief({ requester_wallet: "r1", conversation_id: "c1" });
    const updated = applyUserMessage(brief, { message: "Proven — I need reliability" });
    assert.strictEqual(updated.alignment_preference, "proven");
    assert.strictEqual(updated.min_trust_score, 70);
  });

  it("'preferred' answer sets min_trust_score to 40", () => {
    const brief = createMatchBrief({ requester_wallet: "r1", conversation_id: "c1" });
    const updated = applyUserMessage(brief, { message: "Good track record preferred" });
    assert.strictEqual(updated.alignment_preference, "preferred");
    assert.strictEqual(updated.min_trust_score, 40);
  });

  it("'open' answer sets alignment_preference but leaves min_trust_score null", () => {
    const brief = createMatchBrief({ requester_wallet: "r1", conversation_id: "c1" });
    const updated = applyUserMessage(brief, { message: "Open to both" });
    assert.strictEqual(updated.alignment_preference, "open");
    assert.strictEqual(updated.min_trust_score, null);
  });
});

// ── Adaptive question count ─────────────────────────────────────────────────

describe("adaptive question count", () => {
  it("default max_questions is now 3", () => {
    const brief = createMatchBrief({
      requester_wallet: "r1",
      conversation_id: "c1",
      initial_text: "test",
    });
    assert.strictEqual(brief.max_questions, 3);
  });

  it("never asks budget or constraints in the first 3 questions", () => {
    const t1 = startOrContinueMatchBrief({ requester_wallet: "r1", conversation_id: "c1", text: "find me an expert" });
    assert.strictEqual(t1.type, "ask");
    if (t1.type === "ask") {
      assert.notStrictEqual(t1.question_id, "q_budget");
      assert.notStrictEqual(t1.question_id, "q_constraints");
    }

    const t2 = startOrContinueMatchBrief({ requester_wallet: "r1", conversation_id: "c1", text: "typescript and react", existing_brief: t1.brief });
    if (t2.type === "ask") {
      assert.notStrictEqual(t2.question_id, "q_budget");
      assert.notStrictEqual(t2.question_id, "q_constraints");
    }

    const t3 = startOrContinueMatchBrief({ requester_wallet: "r1", conversation_id: "c1", text: "the hard part is state management", existing_brief: t2.brief });
    if (t3.type === "ask") {
      assert.notStrictEqual(t3.question_id, "q_budget");
      assert.notStrictEqual(t3.question_id, "q_constraints");
    }
  });

  it("ranks after 3 questions even if confidence is below threshold", () => {
    const t1 = startOrContinueMatchBrief({ requester_wallet: "r1", conversation_id: "c1", text: "find me someone good" });
    assert.strictEqual(t1.type, "ask");

    const t2 = startOrContinueMatchBrief({ requester_wallet: "r1", conversation_id: "c1", text: "something reliable", existing_brief: t1.brief });
    assert.strictEqual(t2.type, "ask");

    const t3 = startOrContinueMatchBrief({ requester_wallet: "r1", conversation_id: "c1", text: "not sure, something hard", existing_brief: t2.brief });
    assert.strictEqual(t3.type, "ask");
    assert.strictEqual(t3.question_id, "q_trust_level");

    const t4 = startOrContinueMatchBrief({ requester_wallet: "r1", conversation_id: "c1", text: "open to both", existing_brief: t3.brief });
    assert.strictEqual(t4.type, "rank", "should rank after max_questions reached");
  });

  it("ambiguity gate: fallback question for vague brief is q_situation or q_objective", () => {
    const brief = createMatchBrief({ requester_wallet: "r1", conversation_id: "c1", initial_text: "help" });
    const fallback = getFallbackQuestionForAmbiguous(brief);
    assert.ok(fallback !== null);
    assert.ok(fallback.prompt.length > 0);
    assert.ok(fallback.id === "q_situation" || fallback.id === "q_objective");
  });
});

// ── alignment_preference feeds brief confidence ─────────────────────────────

describe("alignment_preference in brief confidence", () => {
  it("brief confidence increases when alignment_preference is set", () => {
    const before = createMatchBrief({ requester_wallet: "r1", conversation_id: "c1", initial_text: "build a dashboard" });
    const after = applyUserMessage(before, { message: "proven track record" });
    assert.ok(
      after.brief_confidence > before.brief_confidence,
      `confidence should increase after alignment answer: ${before.brief_confidence} → ${after.brief_confidence}`
    );
  });

  it("alignment_preference is in missing_fields until answered", () => {
    const brief = createMatchBrief({ requester_wallet: "r1", conversation_id: "c1", initial_text: "build a React dashboard" });
    assert.ok(brief.missing_fields.includes("alignment_preference"), "alignment_preference should start as missing");
    const answered = applyUserMessage(brief, { message: "open to both" });
    assert.ok(!answered.missing_fields.includes("alignment_preference"), "alignment_preference should be filled after answer");
  });
});

// ── Confirmation question content ───────────────────────────────────────────

describe("buildConfirmationQuestion", () => {
  it("includes Got it echo-back and example", () => {
    const brief = createMatchBrief({
      requester_wallet: "r1",
      conversation_id: "c1",
      initial_text: "build a React dashboard with TypeScript",
    });
    const q = buildConfirmationQuestion(brief);
    assert.strictEqual(q.id, "q_confirm");
    assert.ok(q.prompt.includes("Got it"), "should echo back");
    assert.ok(q.prompt.includes("For example"), "should include example answers");
  });

  it("adapts closing question to build intent", () => {
    const brief = createMatchBrief({
      requester_wallet: "r1",
      conversation_id: "c1",
      initial_text: "build a new trading bot",
    });
    const q = buildConfirmationQuestion(brief);
    assert.ok(
      q.prompt.includes("deadline") || q.prompt.includes("deliverable"),
      `build intent should ask about deadline/deliverable: ${q.prompt}`
    );
  });

  it("adapts closing question to fix intent", () => {
    const brief = createMatchBrief({
      requester_wallet: "r1",
      conversation_id: "c1",
      initial_text: "fix the broken authentication flow",
    });
    const q = buildConfirmationQuestion(brief);
    assert.ok(
      q.prompt.includes("tried") || q.prompt.includes("breaking"),
      `fix intent should ask about what's been tried: ${q.prompt}`
    );
  });

  it("adapts closing question to audit intent", () => {
    const brief = createMatchBrief({
      requester_wallet: "r1",
      conversation_id: "c1",
      initial_text: "audit our Solidity smart contracts",
    });
    const q = buildConfirmationQuestion(brief);
    assert.ok(
      q.prompt.includes("worried"),
      `audit intent should ask about concerns: ${q.prompt}`
    );
  });

  it("mentions detected domain in the prompt", () => {
    const brief = createMatchBrief({
      requester_wallet: "r1",
      conversation_id: "c1",
      initial_text: "build something with react and typescript",
    });
    const q = buildConfirmationQuestion(brief);
    assert.ok(
      q.prompt.includes("react") || q.prompt.includes("typescript"),
      `should mention detected skills: ${q.prompt}`
    );
  });
});

// ── Timeline question still offered closed choices ──────────────────────────

describe("q_timeline still available as adaptive question", () => {
  it("timeline question offers closed choices when reached adaptively", () => {
    // Build a brief where all 3 mandatory questions are answered but timeline still missing
    const brief = createMatchBrief({
      requester_wallet: "r1",
      conversation_id: "c1",
      initial_text: "build a React dashboard",
      max_questions: 5,
    });
    const withSituation = applyUserMessage(brief, { message: "React frontend + XRPL data pipeline with websocket" });
    const withHardThing = applyUserMessage(withSituation, { message: "the real-time sync under load is the hard part" });
    const withTrust = applyUserMessage(withHardThing, { message: "open to both" });
    const q = chooseNextQuestion({
      ...withTrust,
      asked_question_ids: ["q_situation", "q_hard_thing", "q_trust_level"],
    });
    if (q && q.id === "q_timeline") {
      assert.ok(q.prompt.includes("ASAP"), "should include ASAP option");
      assert.ok(q.prompt.includes("this week"), "should include 'this week' option");
      assert.ok(q.prompt.includes("no rush"), "should include 'no rush' option");
    }
  });
});

// ── Multi-turn flow simulation ──────────────────────────────────────────────

describe("full intake flow simulation", () => {
  it("3-turn mandatory flow: situation → hard thing → trust level → rank", () => {
    const t1 = startOrContinueMatchBrief({
      requester_wallet: "rSim",
      conversation_id: "sim1",
      text: "I need help with my project",
    });
    assert.strictEqual(t1.type, "ask");
    assert.strictEqual(t1.question_id, "q_situation");
    assert.ok(t1.brief.questions_asked === 1);

    const t2 = startOrContinueMatchBrief({
      requester_wallet: "rSim",
      conversation_id: "sim1",
      text: "Building a Discord bot that reads XRPL transaction data and posts daily PFT summaries",
      existing_brief: t1.brief,
    });
    assert.strictEqual(t2.type, "ask");
    assert.strictEqual(t2.question_id, "q_hard_thing");

    const t3 = startOrContinueMatchBrief({
      requester_wallet: "rSim",
      conversation_id: "sim1",
      text: "The hardest part is reading XRPL ledger data in real-time without falling behind",
      existing_brief: t2.brief,
    });
    assert.strictEqual(t3.type, "ask");
    assert.strictEqual(t3.question_id, "q_trust_level");

    const t4 = startOrContinueMatchBrief({
      requester_wallet: "rSim",
      conversation_id: "sim1",
      text: "Good track record preferred",
      existing_brief: t3.brief,
    });
    assert.strictEqual(t4.type, "rank", "should rank after all 3 mandatory questions answered");
  });

  it("run now on first turn skips all questions", () => {
    const t1 = startOrContinueMatchBrief({
      requester_wallet: "rSim",
      conversation_id: "sim3",
      text: "find a React dev run now",
    });
    assert.strictEqual(t1.type, "rank");
    assert.strictEqual(t1.brief.questions_asked, 0);
  });

  it("trust level answer populates alignment_preference and affects brief confidence", () => {
    const t1 = startOrContinueMatchBrief({ requester_wallet: "rSim", conversation_id: "sim4", text: "build a Solidity contract" });
    const t2 = startOrContinueMatchBrief({ requester_wallet: "rSim", conversation_id: "sim4", text: "EVM contract with bonding curve logic", existing_brief: t1.brief });
    const t3 = startOrContinueMatchBrief({ requester_wallet: "rSim", conversation_id: "sim4", text: "the reentrancy guard on withdrawal is the scary part", existing_brief: t2.brief });
    const t4 = startOrContinueMatchBrief({ requester_wallet: "rSim", conversation_id: "sim4", text: "Proven — I need reliability above all", existing_brief: t3.brief });

    assert.strictEqual(t4.type, "rank");
    assert.strictEqual(t4.brief.alignment_preference, "proven");
    assert.strictEqual(t4.brief.min_trust_score, 70);
    assert.ok(t4.brief.brief_confidence > 0, "confidence should be above 0 after 3 rich answers");
  });
});
