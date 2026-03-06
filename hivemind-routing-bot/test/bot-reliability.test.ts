/**
 * Reliability tests: cursor persistence, per-sender queue (no dropped followups), tx hash dedupe.
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readCursor, writeCursor } from "../src/cursor.js";
import { SenderPendingQueues, MAX_PENDING_PER_SENDER } from "../src/sender-queue.js";
import { SeenSet, DEFAULT_MAX_SEEN } from "../src/seen-set.js";
import { FileBriefStore } from "../src/file-brief-store.js";
import { createMatchBrief } from "../src/match-brief.js";
import { Logger } from "../src/logger.js";

describe("cursor persistence", () => {
  it("readCursor returns undefined for missing file", () => {
    const out = readCursor(join(tmpdir(), "nonexistent-cursor-" + Date.now()));
    assert.strictEqual(out, undefined);
  });

  it("writeCursor persists value and readCursor reads it back", () => {
    const dir = mkdtempSync(join(tmpdir(), "cursor-test-"));
    const path = join(dir, "cursor");
    try {
      const ok = writeCursor(path, 12345);
      assert.strictEqual(ok, true);
      assert.strictEqual(readCursor(path), 12345);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("writeCursor returns false on invalid path and does not throw", () => {
    const ok = writeCursor("/nonexistent/readonly/path/cursor", 1);
    assert.strictEqual(ok, false);
  });
});

describe("SenderPendingQueues", () => {
  it("drainOnePerSender returns one message per sender and leaves rest in queue", () => {
    const dropped: string[] = [];
    const q = new SenderPendingQueues({ onDrop: (h) => dropped.push(h) });
    q.enqueue("rAlice", "tx1", "body1");
    q.enqueue("rAlice", "tx2", "body2");
    q.enqueue("rBob", "tx3", "body3");

    const batch1 = q.drainOnePerSender();
    assert.strictEqual(batch1.length, 2);
    const aliceMsg = batch1.find((m) => m.sender === "rAlice");
    const bobMsg = batch1.find((m) => m.sender === "rBob");
    assert.ok(aliceMsg && aliceMsg.tx_hash === "tx1" && aliceMsg.body === "body1");
    assert.ok(bobMsg && bobMsg.tx_hash === "tx3");

    const batch2 = q.drainOnePerSender();
    assert.strictEqual(batch2.length, 1);
    assert.strictEqual(batch2[0].sender, "rAlice");
    assert.strictEqual(batch2[0].tx_hash, "tx2");

    assert.strictEqual(q.drainOnePerSender().length, 0);
    assert.strictEqual(dropped.length, 0);
  });

  it("evicts oldest when over MAX_PENDING_PER_SENDER and calls onDrop", () => {
    const dropped: string[] = [];
    const q = new SenderPendingQueues({ onDrop: (h) => dropped.push(h) });
    for (let i = 0; i < MAX_PENDING_PER_SENDER + 2; i++) {
      q.enqueue("rUser", `tx-${i}`, `body-${i}`);
    }
    assert.strictEqual(dropped.length, 2);
    assert.ok(dropped.includes("tx-0"));
    assert.ok(dropped.includes("tx-1"));

    const batch = q.drainOnePerSender();
    assert.strictEqual(batch.length, 1);
    assert.strictEqual(batch[0].tx_hash, "tx-2");
  });

  it("hasPending returns true when queue has items", () => {
    const q = new SenderPendingQueues();
    assert.strictEqual(q.hasPending(), false);
    q.enqueue("rA", "tx1", "b1");
    assert.strictEqual(q.hasPending(), true);
    assert.strictEqual(q.hasPending("rA"), true);
    assert.strictEqual(q.hasPending("rB"), false);
    q.drainOnePerSender();
    assert.strictEqual(q.hasPending(), false);
  });
});

describe("SeenSet", () => {
  it("add and has work and evict at capacity", () => {
    const seen = new SeenSet(3);
    seen.add("a");
    seen.add("b");
    seen.add("c");
    assert.strictEqual(seen.has("a"), true);
    assert.strictEqual(seen.has("b"), true);
    assert.strictEqual(seen.has("c"), true);
    assert.strictEqual(seen.size, 3);

    seen.add("d");
    assert.strictEqual(seen.has("a"), false);
    assert.strictEqual(seen.has("d"), true);
    assert.strictEqual(seen.size, 3);
  });

  it("add is idempotent and does not evict when re-adding same hash", () => {
    const seen = new SeenSet(2);
    seen.add("a");
    seen.add("b");
    seen.add("a");
    assert.strictEqual(seen.has("a"), true);
    assert.strictEqual(seen.has("b"), true);
    assert.strictEqual(seen.size, 2);
  });

  it("onEvict is called when evicting", () => {
    const evicted: string[] = [];
    const seen = new SeenSet(2, (h) => evicted.push(h));
    seen.add("a");
    seen.add("b");
    seen.add("c");
    assert.deepStrictEqual(evicted, ["a"]);
  });

  it("DEFAULT_MAX_SEEN is 5000", () => {
    assert.strictEqual(DEFAULT_MAX_SEEN, 5000);
  });

  it("toArray and fromArray round-trip for persistence", () => {
    const seen = new SeenSet(5);
    seen.add("a");
    seen.add("b");
    seen.add("c");
    const arr = seen.toArray();
    assert.deepStrictEqual(arr, ["a", "b", "c"]);
    const restored = SeenSet.fromArray(arr, 5);
    assert.strictEqual(restored.has("a"), true);
    assert.strictEqual(restored.has("b"), true);
    assert.strictEqual(restored.has("c"), true);
    assert.strictEqual(restored.size, 3);
  });
});

describe("FileBriefStore", () => {
  it("persists and loads briefs", () => {
    const dir = mkdtempSync(join(tmpdir(), "brief-store-"));
    const path = join(dir, "briefs.json");
    try {
      const store = new FileBriefStore(path);
      const brief = createMatchBrief({
        requester_wallet: "rTest",
        conversation_id: "c1",
        initial_text: "need TypeScript help",
      });
      store.set("rTest", brief);
      assert.strictEqual(store.get("rTest")?.requester_wallet, "rTest");

      const store2 = new FileBriefStore(path);
      const loaded = store2.get("rTest");
      assert.ok(loaded !== null);
      assert.strictEqual(loaded.requester_wallet, "rTest");
      assert.strictEqual(loaded.objective, "need TypeScript help");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});

describe("Logger cursorCommit", () => {
  it("emits cursor_commit event with success and cursor", () => {
    const lines: string[] = [];
    const origWrite = process.stderr.write;
    process.stderr.write = ((chunk: string) => {
      lines.push(chunk);
      return true;
    }) as typeof process.stderr.write;

    try {
      const logger = new Logger({ level: "debug", json: true });
      logger.cursorCommit(true, 100, undefined);
      assert.strictEqual(lines.length, 1);
      const parsed = JSON.parse(lines[0]);
      assert.strictEqual(parsed.event, "cursor_commit");
      assert.strictEqual(parsed.success, true);
      assert.strictEqual(parsed.cursor, 100);
    } finally {
      process.stderr.write = origWrite;
    }
  });

  it("emits cursor_commit with success false and error on failure", () => {
    const lines: string[] = [];
    const origWrite = process.stderr.write;
    process.stderr.write = ((chunk: string) => {
      lines.push(chunk);
      return true;
    }) as typeof process.stderr.write;

    try {
      const logger = new Logger({ level: "warn", json: true });
      logger.cursorCommit(false, undefined, "write failed");
      assert.strictEqual(lines.length, 1);
      const parsed = JSON.parse(lines[0]);
      assert.strictEqual(parsed.event, "cursor_commit");
      assert.strictEqual(parsed.success, false);
      assert.strictEqual(parsed.error, "write failed");
    } finally {
      process.stderr.write = origWrite;
    }
  });
});

describe("Logger matchOutcome", () => {
  it("emits match_outcome event with outcome and optional selection", () => {
    const lines: string[] = [];
    const origWrite = process.stderr.write;
    process.stderr.write = ((chunk: string) => {
      lines.push(chunk);
      return true;
    }) as typeof process.stderr.write;

    try {
      const logger = new Logger({ level: "info", json: true });
      logger.matchOutcome("rUser", "selection", "req-1", 2);
      assert.strictEqual(lines.length, 1);
      const parsed = JSON.parse(lines[0]);
      assert.strictEqual(parsed.event, "match_outcome");
      assert.strictEqual(parsed.sender, "rUser");
      assert.strictEqual(parsed.outcome, "selection");
      assert.strictEqual(parsed.selection, 2);
    } finally {
      process.stderr.write = origWrite;
    }
  });
});
