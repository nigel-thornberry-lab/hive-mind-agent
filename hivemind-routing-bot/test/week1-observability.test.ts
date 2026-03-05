/**
 * Week 1 tests: structured logger, stale-while-revalidate cache, clarification funnel counters.
 */

import { describe, it, mock } from "node:test";
import assert from "node:assert";
import { Logger, generateRequestId } from "../src/logger.js";
import { MemberIndexCache, type CacheStats } from "../src/member-index-cache.js";
import { InMemoryBriefStore } from "../src/conversation-state-machine.js";
import {
  createMatchBrief,
  markReady,
  attachRankedResult,
  applyUserMessage,
  computeBriefConfidence,
} from "../src/match-brief.js";
import type { BotConfig } from "../src/config.js";

function minimalConfig(overrides: Partial<BotConfig> = {}): BotConfig {
  return {
    botSeedFile: null,
    botSeed: "test-seed",
    taskNodeUrl: "https://test.example.com",
    taskNodeJwt: "test-jwt",
    pftlRpcUrl: "https://rpc.test",
    pftlWssUrl: "wss://ws.test",
    keystoneGrpcUrl: "test:443",
    memberIndexTtlMs: 100,
    memberIndexLimit: 10,
    scanIntervalMs: 5000,
    cursorFilePath: null,
    persistStorePath: null,
    healthPort: 0,
    ...overrides,
  };
}

// ---------- Logger ----------

describe("Logger", () => {
  it("generateRequestId returns 8-char UUID prefix", () => {
    const id = generateRequestId();
    assert.strictEqual(id.length, 8);
    assert.ok(/^[0-9a-f]{8}$/.test(id), `Expected hex chars, got: ${id}`);
  });

  it("emits JSON lines to stderr in json mode", () => {
    const lines: string[] = [];
    const origWrite = process.stderr.write;
    process.stderr.write = ((chunk: string) => {
      lines.push(chunk);
      return true;
    }) as typeof process.stderr.write;

    try {
      const logger = new Logger({ level: "debug", json: true });
      logger.matchRequest({
        request_id: "abc12345",
        sender: "rSender1",
        action: "match",
        text_length: 42,
        brief_stage: "new",
        brief_confidence: 0.3,
      });
      assert.strictEqual(lines.length, 1);
      const parsed = JSON.parse(lines[0]);
      assert.strictEqual(parsed.event, "match_request");
      assert.strictEqual(parsed.sender, "rSender1");
      assert.strictEqual(parsed.text_length, 42);
      assert.ok(parsed.ts, "should have timestamp");
    } finally {
      process.stderr.write = origWrite;
    }
  });

  it("emits human-readable lines in non-json mode", () => {
    const lines: string[] = [];
    const origWrite = process.stderr.write;
    process.stderr.write = ((chunk: string) => {
      lines.push(chunk);
      return true;
    }) as typeof process.stderr.write;

    try {
      const logger = new Logger({ level: "info", json: false });
      logger.matchResult({
        request_id: "def67890",
        sender: "rSender2",
        match_count: 3,
        top_score: 0.82,
        top_confidence: 0.78,
        provisional: false,
        latency_ms: 150,
        cache_status: "hit",
      });
      assert.strictEqual(lines.length, 1);
      assert.ok(lines[0].includes("match_result"), "should contain event name");
      assert.ok(lines[0].includes("latency_ms=150"), "should contain latency");
    } finally {
      process.stderr.write = origWrite;
    }
  });

  it("respects minimum log level", () => {
    const lines: string[] = [];
    const origWrite = process.stderr.write;
    process.stderr.write = ((chunk: string) => {
      lines.push(chunk);
      return true;
    }) as typeof process.stderr.write;

    try {
      const logger = new Logger({ level: "warn", json: true });
      logger.cache("cache_hit", { operator_count: 10 });
      assert.strictEqual(lines.length, 0, "debug event should be suppressed at warn level");

      logger.error("something broke", "test_context");
      assert.strictEqual(lines.length, 1, "error event should pass warn level");
    } finally {
      process.stderr.write = origWrite;
    }
  });
});

// ---------- Stale-While-Revalidate Cache ----------

describe("MemberIndexCache SWR", () => {
  it("returns cached data on fresh hit without calling loader", async () => {
    let loadCount = 0;
    const cache = new MemberIndexCache({
      config: minimalConfig({ memberIndexTtlMs: 5000 }),
      loader: async () => {
        loadCount++;
        return { operator_profiles: [{ operator_id: `op-${loadCount}` } as never] };
      },
    });

    const first = await cache.getSnapshot();
    assert.strictEqual(loadCount, 1);
    assert.strictEqual(first.operator_profiles.length, 1);

    const second = await cache.getSnapshot();
    assert.strictEqual(loadCount, 1, "should not reload on fresh hit");
    assert.strictEqual(second, first, "should return same reference");
    assert.strictEqual(cache.stats.hits, 1);
    assert.strictEqual(cache.stats.misses, 1);
  });

  it("serves stale data and triggers background refresh after soft TTL", async () => {
    let loadCount = 0;
    const gate = { resolve: null as (() => void) | null };

    const cache = new MemberIndexCache({
      config: minimalConfig({ memberIndexTtlMs: 10 }),
      loader: async () => {
        loadCount++;
        if (loadCount === 2) {
          await new Promise<void>((r) => { gate.resolve = r; });
        }
        return { operator_profiles: [{ operator_id: `op-${loadCount}` } as never] };
      },
    });

    await cache.getSnapshot();
    assert.strictEqual(loadCount, 1);

    await new Promise((r) => setTimeout(r, 20));

    const staleResult = await cache.getSnapshot();
    assert.strictEqual(staleResult.operator_profiles[0].operator_id, "op-1", "should return stale data immediately");
    assert.strictEqual(cache.stats.stale_serves, 1);

    gate.resolve?.();
    await new Promise((r) => setTimeout(r, 10));
    assert.strictEqual(loadCount, 2, "background refresh should have fired");
  });

  it("blocks on hard expiry (no stale data to serve)", async () => {
    let loadCount = 0;
    const cache = new MemberIndexCache({
      config: minimalConfig({ memberIndexTtlMs: 1 }),
      loader: async () => {
        loadCount++;
        return { operator_profiles: [{ operator_id: `op-${loadCount}` } as never] };
      },
    });

    await cache.getSnapshot();

    await new Promise((r) => setTimeout(r, 20));
    const result = await cache.getSnapshot();
    assert.strictEqual(loadCount, 2, "should have reloaded after hard expiry");
    assert.strictEqual(result.operator_profiles[0].operator_id, "op-2");
  });

  it("returns stale data on loader error when snapshot exists", async () => {
    let loadCount = 0;
    const cache = new MemberIndexCache({
      config: minimalConfig({ memberIndexTtlMs: 10 }),
      loader: async () => {
        loadCount++;
        if (loadCount >= 2) throw new Error("network failure");
        return { operator_profiles: [{ operator_id: "op-1" } as never] };
      },
    });

    const first = await cache.getSnapshot();
    assert.strictEqual(first.operator_profiles[0].operator_id, "op-1");

    await new Promise((r) => setTimeout(r, 20));

    const result = await cache.getSnapshot({ forceRefresh: true });
    assert.strictEqual(result.operator_profiles[0].operator_id, "op-1", "should return stale on error");
    assert.strictEqual(cache.stats.errors, 1);
  });

  it("fires onCacheEvent callback with correct types", async () => {
    const events: string[] = [];
    const cache = new MemberIndexCache({
      config: minimalConfig({ memberIndexTtlMs: 10 }),
      loader: async () => ({ operator_profiles: [] }),
      onCacheEvent: (type) => { events.push(type); },
    });

    await cache.getSnapshot();
    assert.ok(events.includes("miss"), "first load should fire miss");
    assert.ok(events.includes("refresh"), "first load should fire refresh");

    await cache.getSnapshot();
    assert.ok(events.includes("hit"), "second load should fire hit");

    await new Promise((r) => setTimeout(r, 20));
    await cache.getSnapshot();
    assert.ok(events.includes("stale_serve"), "stale load should fire stale_serve");
  });

  it("tracks stats correctly", async () => {
    const cache = new MemberIndexCache({
      config: minimalConfig({ memberIndexTtlMs: 5000 }),
      loader: async () => ({ operator_profiles: [{ operator_id: "op" } as never] }),
    });

    await cache.getSnapshot();
    assert.strictEqual(cache.stats.misses, 1);
    assert.strictEqual(cache.stats.refreshes, 1);
    assert.ok(cache.stats.last_refresh_ms >= 0);
    assert.strictEqual(cache.stats.operator_count, 1);

    await cache.getSnapshot();
    assert.strictEqual(cache.stats.hits, 1);
  });
});

// ---------- Clarification Funnel Counters ----------

describe("InMemoryBriefStore funnel counters", () => {
  it("starts with zeroed counters", () => {
    const store = new InMemoryBriefStore();
    const f = store.funnel;
    assert.strictEqual(f.briefs_started, 0);
    assert.strictEqual(f.questions_asked, 0);
    assert.strictEqual(f.questions_answered, 0);
    assert.strictEqual(f.run_now_skips, 0);
    assert.strictEqual(f.ranked_total, 0);
    assert.strictEqual(f.ranked_provisional, 0);
    assert.strictEqual(f.abandoned_expired, 0);
    assert.strictEqual(f.closed_by_user, 0);
  });

  it("increments counters correctly through a full lifecycle", () => {
    const store = new InMemoryBriefStore();

    store.recordBriefStarted();
    assert.strictEqual(store.funnel.briefs_started, 1);

    store.recordQuestionAsked();
    store.recordQuestionAsked();
    assert.strictEqual(store.funnel.questions_asked, 2);

    store.recordQuestionAnswered();
    assert.strictEqual(store.funnel.questions_answered, 1);

    store.recordRanked(false);
    assert.strictEqual(store.funnel.ranked_total, 1);
    assert.strictEqual(store.funnel.ranked_provisional, 0);

    store.recordRanked(true);
    assert.strictEqual(store.funnel.ranked_total, 2);
    assert.strictEqual(store.funnel.ranked_provisional, 1);
  });

  it("counts run_now_skips and closures", () => {
    const store = new InMemoryBriefStore();
    store.recordRunNowSkip();
    store.recordRunNowSkip();
    store.recordClosed();
    assert.strictEqual(store.funnel.run_now_skips, 2);
    assert.strictEqual(store.funnel.closed_by_user, 1);
  });

  it("counts abandoned_expired when get() finds stale entries", () => {
    const store = new InMemoryBriefStore(1, 1);
    const brief = createMatchBrief({
      requester_wallet: "rFunnel",
      conversation_id: "c1",
      initial_text: "test",
    });
    store.set("k1", brief);

    return new Promise<void>((resolve) => {
      setTimeout(() => {
        const result = store.get("k1");
        assert.strictEqual(result, null);
        assert.strictEqual(store.funnel.abandoned_expired, 1);
        resolve();
      }, 10);
    });
  });

  it("counts abandoned_expired via sweep()", () => {
    const store = new InMemoryBriefStore(1, 1);
    const brief = createMatchBrief({
      requester_wallet: "rSweepFunnel",
      conversation_id: "c2",
      initial_text: "test",
    });
    store.set("a", brief);
    store.set("b", brief);

    return new Promise<void>((resolve) => {
      setTimeout(() => {
        store.sweep();
        assert.strictEqual(store.funnel.abandoned_expired, 2);
        resolve();
      }, 10);
    });
  });
});

// ─── brief_confidence interaction bonus ────────────────────────────────────────

describe("computeBriefConfidence interaction bonus", () => {
  it("initial brief with no skill keywords has only objective weight (0.3)", () => {
    const brief = createMatchBrief({
      requester_wallet: "rTest",
      conversation_id: "c-conf",
      initial_text: "find me an expert",
    });
    assert.strictEqual(brief.brief_confidence, 0.3);
  });

  it("answering one question adds 0.1 interaction bonus", () => {
    let brief = createMatchBrief({
      requester_wallet: "rTest",
      conversation_id: "c-conf",
      initial_text: "find me an expert",
    });
    assert.strictEqual(brief.brief_confidence, 0.3);

    brief = applyUserMessage(brief, { message: "someone reliable" });
    assert.strictEqual(brief.brief_confidence, 0.4);
    assert.strictEqual(brief.user_messages.length, 2);
  });

  it("answering two questions caps interaction bonus at 0.15", () => {
    let brief = createMatchBrief({
      requester_wallet: "rTest",
      conversation_id: "c-conf",
      initial_text: "find me an expert",
    });

    brief = applyUserMessage(brief, { message: "someone reliable" });
    brief = applyUserMessage(brief, { message: "good communication matters" });
    // objective(0.3) + interaction(min(0.15, 2*0.1)=0.15) = 0.45
    assert.strictEqual(brief.brief_confidence, 0.45);
    assert.strictEqual(brief.user_messages.length, 3);
  });

  it("interaction bonus stacks with field-based scoring", () => {
    let brief = createMatchBrief({
      requester_wallet: "rTest",
      conversation_id: "c-conf",
      initial_text: "find me an expert",
    });
    assert.strictEqual(brief.brief_confidence, 0.3);

    brief = applyUserMessage(brief, { message: "must know typescript" });
    // objective(0.3) + mustHave(0.25) + interaction(0.1) = 0.65
    assert.strictEqual(brief.brief_confidence, 0.65);

    brief = applyUserMessage(brief, { message: "this week" });
    // objective(0.3) + mustHave(0.25) + timeline(0.2) + interaction(0.15) = 0.9
    assert.strictEqual(brief.brief_confidence, 0.9);
  });

  it("passes 0.3 threshold after single answer even without keyword match", () => {
    let brief = createMatchBrief({
      requester_wallet: "rTest",
      conversation_id: "c-conf",
      initial_text: "find me an expert",
    });

    brief = applyUserMessage(brief, { message: "yes" });
    assert.ok(brief.brief_confidence > 0.3, `expected > 0.3 but got ${brief.brief_confidence}`);
  });
});
