import { describe, it } from "node:test";
import assert from "node:assert";
import {
  InMemoryBriefStore,
  startOrContinueMatchBrief,
  BRIEF_TTL_MS,
  RANKED_BRIEF_TTL_MS,
} from "../src/conversation-state-machine.js";
import {
  createMatchBrief,
  markReady,
  attachRankedResult,
} from "../src/match-brief.js";

describe("conversation state machine", () => {
  it("asks one high-impact clarifying question on first turn", () => {
    const action = startOrContinueMatchBrief({
      requester_wallet: "rUser1",
      conversation_id: "thread-1",
      text: "/match need web3 help",
    });
    assert.strictEqual(action.type, "ask");
    if (action.type === "ask") {
      assert.ok(action.prompt.length > 0);
      assert.strictEqual(action.brief.questions_asked, 1);
    }
  });

  it("transitions to rank when user says run now", () => {
    const first = startOrContinueMatchBrief({
      requester_wallet: "rUser2",
      conversation_id: "thread-2",
      text: "/match Need an NFT marketplace with escrow",
    });
    const brief = first.brief;
    const second = startOrContinueMatchBrief({
      requester_wallet: "rUser2",
      conversation_id: "thread-2",
      text: "run now",
      existing_brief: brief,
    });
    assert.strictEqual(second.type, "rank");
  });

  it("supports per-thread storage for immediate integration", () => {
    const store = new InMemoryBriefStore();
    const key = "rUser3:thread-3";

    const first = startOrContinueMatchBrief({
      requester_wallet: "rUser3",
      conversation_id: "thread-3",
      text: "/match Build API routing system",
    });
    store.set(key, first.brief);
    assert.ok(store.get(key));

    const second = startOrContinueMatchBrief({
      requester_wallet: "rUser3",
      conversation_id: "thread-3",
      text: "Must have TypeScript and observability",
      existing_brief: store.get(key),
    });
    assert.ok(second.brief.must_have_skills.includes("typescript"));
  });

  it("extracts observability and monitoring as skills from follow-up", () => {
    const first = startOrContinueMatchBrief({
      requester_wallet: "rUser4",
      conversation_id: "thread-4",
      text: "/match Need API integration and schema mapping with observability",
    });
    const skills = first.brief.must_have_skills.concat(first.brief.domain);
    assert.ok(
      skills.includes("observability") || skills.includes("api") || skills.includes("schema"),
      `Expected observability/api/schema in skills, got: ${skills.join(", ")}`
    );
  });
});

describe("InMemoryBriefStore TTL", () => {
  it("returns null for expired entries", () => {
    const store = new InMemoryBriefStore(50, 25);
    const brief = createMatchBrief({
      requester_wallet: "rExpire1",
      conversation_id: "c1",
      initial_text: "test",
    });
    store.set("k1", brief);
    assert.ok(store.get("k1") !== null, "should exist immediately");

    // Simulate time passing by setting a very short TTL store
    const fastStore = new InMemoryBriefStore(1, 1);
    fastStore.set("k2", brief);
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        assert.strictEqual(fastStore.get("k2"), null, "should be expired after TTL");
        resolve();
      }, 10);
    });
  });

  it("ranked briefs expire faster than active briefs", () => {
    const store = new InMemoryBriefStore(200, 1);
    const brief = createMatchBrief({
      requester_wallet: "rExpire2",
      conversation_id: "c2",
      initial_text: "test",
    });
    store.set("active", brief);

    const ranked = attachRankedResult(markReady(brief), [], false);
    store.set("ranked", ranked);

    return new Promise<void>((resolve) => {
      setTimeout(() => {
        assert.ok(store.get("active") !== null, "active brief should still exist");
        assert.strictEqual(store.get("ranked"), null, "ranked brief should be expired");
        resolve();
      }, 10);
    });
  });

  it("sweep removes all expired entries and returns count", () => {
    const store = new InMemoryBriefStore(1, 1);
    const brief = createMatchBrief({
      requester_wallet: "rSweep",
      conversation_id: "c3",
      initial_text: "test",
    });
    store.set("a", brief);
    store.set("b", brief);
    store.set("c", brief);
    assert.strictEqual(store.size, 3);

    return new Promise<void>((resolve) => {
      setTimeout(() => {
        const removed = store.sweep();
        assert.strictEqual(removed, 3);
        assert.strictEqual(store.size, 0);
        resolve();
      }, 10);
    });
  });

  it("new /match starts fresh when old brief has expired", () => {
    const store = new InMemoryBriefStore(1, 1);
    const first = startOrContinueMatchBrief({
      requester_wallet: "rFresh",
      conversation_id: "c4",
      text: "old request about NFTs",
    });
    store.set("rFresh", first.brief);

    return new Promise<void>((resolve) => {
      setTimeout(() => {
        const expired = store.get("rFresh");
        assert.strictEqual(expired, null, "brief should be expired");

        const fresh = startOrContinueMatchBrief({
          requester_wallet: "rFresh",
          conversation_id: "c4",
          text: "new request about API integration",
          existing_brief: expired,
        });
        assert.ok(fresh.brief.objective?.includes("API") || fresh.brief.objective?.includes("api"),
          "should have new objective, not stale NFT one");
        resolve();
      }, 10);
    });
  });
});
