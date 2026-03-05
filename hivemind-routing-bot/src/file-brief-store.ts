/**
 * File-backed BriefStore for persistence across restarts.
 * Writes JSON to disk on set/delete; loads from file on first get/set if needed.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import type { MatchBrief } from "./match-brief.js";
import type { BriefStore } from "./conversation-state-machine.js";
import type { ClarificationFunnelStats } from "./conversation-state-machine.js";

const BRIEF_TTL_MS = 15 * 60 * 1000;
const RANKED_BRIEF_TTL_MS = 5 * 60 * 1000;

interface StoredEntry {
  brief: MatchBrief;
  expiresAt: number;
}

export class FileBriefStore implements BriefStore {
  private readonly path: string;
  private readonly ttlMs: number;
  private readonly rankedTtlMs: number;
  private cache: Map<string, StoredEntry> = new Map();
  private loaded = false;

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

  constructor(filePath: string, ttlMs = BRIEF_TTL_MS, rankedTtlMs = RANKED_BRIEF_TTL_MS) {
    this.path = filePath;
    this.ttlMs = ttlMs;
    this.rankedTtlMs = rankedTtlMs;
  }

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      if (!existsSync(this.path)) return;
      const raw = readFileSync(this.path, "utf8");
      const data = JSON.parse(raw) as Record<string, { brief: MatchBrief; expiresAt: number }>;
      const now = Date.now();
      for (const [key, entry] of Object.entries(data)) {
        if (entry.expiresAt > now) this.cache.set(key, entry);
      }
    } catch {
      this.cache = new Map();
    }
  }

  private save(): void {
    try {
      const obj: Record<string, StoredEntry> = {};
      const now = Date.now();
      for (const [key, entry] of this.cache) {
        if (entry.expiresAt > now) obj[key] = entry;
      }
      writeFileSync(this.path, JSON.stringify(obj), "utf8");
    } catch {
      // ignore write errors
    }
  }

  get(key: string): MatchBrief | null {
    this.load();
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      this.funnel.abandoned_expired++;
      this.save();
      return null;
    }
    return entry.brief;
  }

  set(key: string, brief: MatchBrief): void {
    this.load();
    const ttl =
      brief.stage === "ranked" || brief.stage === "closed" ? this.rankedTtlMs : this.ttlMs;
    this.cache.set(key, { brief, expiresAt: Date.now() + ttl });
    this.save();
  }

  delete(key: string): void {
    this.load();
    this.cache.delete(key);
    this.save();
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
    this.load();
    const now = Date.now();
    let removed = 0;
    for (const [key, entry] of this.cache) {
      if (now > entry.expiresAt) {
        this.cache.delete(key);
        removed++;
      }
    }
    this.funnel.abandoned_expired += removed;
    if (removed) this.save();
    return removed;
  }

  get size(): number {
    this.load();
    return this.cache.size;
  }
}
