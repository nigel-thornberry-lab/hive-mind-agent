/**
 * Tests for the upgraded intake flow:
 * - Intent detection
 * - Contextual echo-back prompts with example answers
 * - Adaptive question count (confirmation for high-confidence briefs)
 * - Max 2 questions
 * - Budget/constraints deprioritized
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import { detectIntent, chooseNextQuestion, buildConfirmationQuestion, getFallbackQuestionForAmbiguous } from "../src/question-policy.js";
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

// ── Contextual prompts contain echo-back and examples ───────────────────────

describe("contextual prompt quality", () => {
  it("q_must_have echoes back domain when skills are detected", () => {
    const brief = createMatchBrief({
      requester_wallet: "r1",
      conversation_id: "c1",
      initial_text: "help with web3 security",
    });
    const q = chooseNextQuestion(brief);
    assert.ok(q, "should ask a question");
    assert.ok(
      q!.prompt.includes("web3") || q!.prompt.includes("security"),
      `prompt should reference detected domain, got: ${q!.prompt}`
    );
  });

  it("prompts include example answers", () => {
    const brief = createMatchBrief({
      requester_wallet: "r1",
      conversation_id: "c1",
      initial_text: "find me an expert",
    });
    const q = chooseNextQuestion(brief);
    assert.ok(q, "should ask a question");
    assert.ok(
      /[Ff]or example/.test(q!.prompt),
      `prompt should include examples, got: ${q!.prompt}`
    );
  });

  it("timeline question offers closed choices", () => {
    const brief = createMatchBrief({
      requester_wallet: "r1",
      conversation_id: "c1",
      initial_text: "build a React dashboard",
      max_questions: 5,
    });
    // Ask first question, then apply an answer so timeline becomes next
    const first = startOrContinueMatchBrief({
      requester_wallet: "r1",
      conversation_id: "c1",
      text: "build a React dashboard",
    });
    const withAnswer = applyUserMessage(first.brief, { message: "React and TypeScript" });
    const q = chooseNextQuestion(withAnswer);
    if (q && q.id === "q_timeline") {
      assert.ok(q.prompt.includes("ASAP"), "should include ASAP option");
      assert.ok(q.prompt.includes("this week"), "should include 'this week' option");
      assert.ok(q.prompt.includes("no rush"), "should include 'no rush' option");
    }
  });

  it("build intent gets deliverable-shaped follow-up", () => {
    const brief = createMatchBrief({
      requester_wallet: "r1",
      conversation_id: "c1",
      initial_text: "build a token dashboard",
    });
    // brief has objective + domain (dashboard), missing fields include deliverable
    const q = chooseNextQuestion(brief);
    assert.ok(q, "should choose a question");
    if (q!.id === "q_deliverable") {
      assert.ok(q!.prompt.includes("end result"), `build intent should ask about end result: ${q!.prompt}`);
      assert.ok(q!.prompt.includes("MVP") || q!.prompt.includes("production"), "should include deliverable examples");
    }
  });

  it("fix intent gets diagnostic follow-up", () => {
    const brief = createMatchBrief({
      requester_wallet: "r1",
      conversation_id: "c1",
      initial_text: "fix authentication bug",
    });
    const q = chooseNextQuestion(brief);
    assert.ok(q, "should choose a question");
    if (q!.id === "q_deliverable") {
      assert.ok(
        q!.prompt.includes("happening") || q!.prompt.includes("expected"),
        `fix intent should ask about symptoms: ${q!.prompt}`
      );
    }
  });
});

// ── Adaptive question count ─────────────────────────────────────────────────

describe("adaptive question count", () => {
  it("very high-confidence brief ranks immediately without asking", () => {
    // "build a Solidity smart contract this week" fills objective + skills + urgency (>= 0.75)
    const action = startOrContinueMatchBrief({
      requester_wallet: "r1",
      conversation_id: "c1",
      text: "build a Solidity smart contract this week",
    });
    assert.strictEqual(action.type, "rank", "high-confidence first turn should rank directly");
    if (action.type === "rank") {
      assert.strictEqual(action.provisional, false);
      assert.strictEqual(action.brief.questions_asked, 0);
    }
  });

  it("medium-confidence brief gets soft confirmation instead of field interrogation", () => {
    // "build a Solidity smart contract" (no timeline) yields confidence in [0.55, 0.75)
    const action = startOrContinueMatchBrief({
      requester_wallet: "r1",
      conversation_id: "c1",
      text: "build a Solidity smart contract",
    });
    assert.strictEqual(action.type, "ask");
    if (action.type === "ask") {
      assert.strictEqual(action.question_id, "q_confirm");
      assert.ok(action.prompt.includes("Got it"), "confirmation should echo back");
      assert.ok(
        action.prompt.includes("Anything else") || action.prompt.includes("anything else"),
        "confirmation should be open-ended"
      );
    }
  });

  it("low-confidence brief gets a targeted field question", () => {
    const action = startOrContinueMatchBrief({
      requester_wallet: "r1",
      conversation_id: "c1",
      text: "find me an expert",
    });
    assert.strictEqual(action.type, "ask");
    if (action.type === "ask") {
      assert.notStrictEqual(action.question_id, "q_confirm");
      assert.ok(action.prompt.length > 0);
    }
  });

  it("default max_questions is now 2", () => {
    const brief = createMatchBrief({
      requester_wallet: "r1",
      conversation_id: "c1",
      initial_text: "test",
    });
    assert.strictEqual(brief.max_questions, 2);
  });

  it("never asks budget or constraints as the first or second question", () => {
    const action1 = startOrContinueMatchBrief({
      requester_wallet: "r1",
      conversation_id: "c1",
      text: "find me an expert",
    });
    assert.strictEqual(action1.type, "ask");
    if (action1.type === "ask") {
      assert.notStrictEqual(action1.question_id, "q_budget");
      assert.notStrictEqual(action1.question_id, "q_constraints");
    }

    // Answer first question, check second
    const action2 = startOrContinueMatchBrief({
      requester_wallet: "r1",
      conversation_id: "c1",
      text: "typescript and react",
      existing_brief: action1.brief,
    });
    if (action2.type === "ask") {
      assert.notStrictEqual(action2.question_id, "q_budget");
      assert.notStrictEqual(action2.question_id, "q_constraints");
    }
  });

  it("ambiguity gate: fallback question exists for vague brief", () => {
    const brief = createMatchBrief({
      requester_wallet: "r1",
      conversation_id: "c1",
      initial_text: "help",
    });
    const fallback = getFallbackQuestionForAmbiguous(brief);
    assert.ok(fallback !== null);
    assert.ok(fallback.prompt.length > 0);
    assert.ok(fallback.id === "q_must_have" || fallback.id === "q_objective");
  });

  it("ranks after 2 questions even if confidence is below threshold", () => {
    // Start with a vague request
    const action1 = startOrContinueMatchBrief({
      requester_wallet: "r1",
      conversation_id: "c1",
      text: "find me someone good",
    });
    assert.strictEqual(action1.type, "ask");

    // Answer first question vaguely
    const action2 = startOrContinueMatchBrief({
      requester_wallet: "r1",
      conversation_id: "c1",
      text: "someone reliable",
      existing_brief: action1.brief,
    });

    if (action2.type === "ask") {
      // Answer second question vaguely
      const action3 = startOrContinueMatchBrief({
        requester_wallet: "r1",
        conversation_id: "c1",
        text: "whenever is fine",
        existing_brief: action2.brief,
      });
      // After 2 questions, should rank even if low confidence
      assert.strictEqual(action3.type, "rank", "should rank after max_questions reached");
    } else {
      // Already ranked after first answer (e.g., if hardReady was met)
      assert.strictEqual(action2.type, "rank");
    }
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

// ── Multi-turn flow simulation ──────────────────────────────────────────────

describe("full intake flow simulation", () => {
  it("vague request -> targeted question -> answer -> rank (2 turns)", () => {
    // Turn 1: vague request
    const t1 = startOrContinueMatchBrief({
      requester_wallet: "rSim",
      conversation_id: "sim1",
      text: "I need help with my project",
    });
    assert.strictEqual(t1.type, "ask");
    assert.ok(t1.brief.questions_asked === 1);
    assert.ok(/[Ff]or example/.test((t1 as any).prompt), "first question should have examples");

    // Turn 2: user gives skills + timeline in one answer
    const t2 = startOrContinueMatchBrief({
      requester_wallet: "rSim",
      conversation_id: "sim1",
      text: "React dashboard, need it this week",
      existing_brief: t1.brief,
    });
    // Should either ask one more or rank — not interrogate about budget
    if (t2.type === "ask") {
      assert.notStrictEqual(t2.brief.questions_asked > 2, true, "should not exceed 2 questions");
    }
  });

  it("detailed request with high confidence ranks on first turn", () => {
    // "build a Solidity audit tool, need it this week" fills objective + skills + urgency (>= 0.75)
    const t1 = startOrContinueMatchBrief({
      requester_wallet: "rSim",
      conversation_id: "sim2",
      text: "build a Solidity audit tool, need it this week",
    });
    assert.strictEqual(t1.type, "rank", "high-confidence first turn should rank directly");
    if (t1.type === "rank") {
      assert.strictEqual(t1.brief.questions_asked, 0);
    }
  });

  it("medium-confidence detailed request -> soft confirmation -> answer with timeline -> rank", () => {
    // "build a Solidity audit tool" without timeline yields confidence in [0.55, 0.75)
    const t1 = startOrContinueMatchBrief({
      requester_wallet: "rSim",
      conversation_id: "sim2b",
      text: "build a Solidity audit tool",
    });
    assert.strictEqual(t1.type, "ask");
    if (t1.type === "ask") {
      assert.strictEqual(t1.question_id, "q_confirm");
    }

    // Answer with timeline so hardReady is satisfied and we rank
    const t2 = startOrContinueMatchBrief({
      requester_wallet: "rSim",
      conversation_id: "sim2b",
      text: "this week",
      existing_brief: t1.brief,
    });
    assert.strictEqual(t2.type, "rank", "should rank after confirmation answer with timeline");
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
});
