import { randomUUID } from "node:crypto";

export type LogLevel = "debug" | "info" | "warn" | "error";

interface BaseEvent {
  ts: string;
  level: LogLevel;
  event: string;
  request_id?: string;
}

export interface MatchRequestEvent extends BaseEvent {
  event: "match_request";
  sender: string;
  action: "match" | "followup" | "help";
  text_length: number;
  brief_stage: string;
  brief_confidence: number;
}

export interface MatchResultEvent extends BaseEvent {
  event: "match_result";
  sender: string;
  match_count: number;
  top_score: number;
  top_confidence: number;
  provisional: boolean;
  latency_ms: number;
  cache_status: "hit" | "miss" | "stale";
  request_text_length?: number;
  tag_count?: number;
  user_message_count?: number;
}

export interface ClarificationEvent extends BaseEvent {
  event: "clarification_asked" | "clarification_answered" | "clarification_skipped";
  sender: string;
  question_id: string;
  questions_asked: number;
  brief_confidence: number;
}

export interface CacheEvent extends BaseEvent {
  event: "cache_refresh" | "cache_hit" | "cache_stale_serve" | "cache_error";
  operator_count?: number;
  latency_ms?: number;
  stale_age_ms?: number;
  error?: string;
}

export interface BriefLifecycleEvent extends BaseEvent {
  event: "brief_created" | "brief_ranked" | "brief_expired" | "brief_closed";
  sender: string;
  questions_answered: number;
  brief_confidence: number;
}

export interface ErrorLogEvent extends BaseEvent {
  event: "bot_error";
  error: string;
  context?: string;
}

export interface CursorCommitEvent extends BaseEvent {
  event: "cursor_commit";
  success: boolean;
  cursor?: number;
  error?: string;
}

export interface MatchOutcomeEvent extends BaseEvent {
  event: "match_outcome";
  sender: string;
  outcome: "selection" | "rerun" | "followup" | "unknown";
  /** 1-based match index when outcome is selection */
  selection?: number;
}

export type LogEvent =
  | MatchRequestEvent
  | MatchResultEvent
  | ClarificationEvent
  | CacheEvent
  | BriefLifecycleEvent
  | ErrorLogEvent
  | CursorCommitEvent
  | MatchOutcomeEvent;

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

export class Logger {
  private minLevel: number;
  private json: boolean;

  constructor(options: { level?: LogLevel; json?: boolean } = {}) {
    this.minLevel = LOG_LEVELS[options.level ?? "info"];
    this.json = options.json ?? (process.env.NODE_ENV === "production");
  }

  emit(event: LogEvent): void {
    const level = LOG_LEVELS[event.level];
    if (level < this.minLevel) return;
    if (this.json) {
      process.stderr.write(JSON.stringify(event) + "\n");
    } else {
      const { ts, level: lvl, event: evt, ...rest } = event;
      const fields = Object.entries(rest)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
        .join(" ");
      process.stderr.write(`${ts} [${lvl}] ${evt} ${fields}\n`);
    }
  }

  matchRequest(fields: Omit<MatchRequestEvent, "ts" | "level" | "event">): void {
    this.emit({ ts: now(), level: "info", event: "match_request", ...fields });
  }

  matchResult(fields: Omit<MatchResultEvent, "ts" | "level" | "event">): void {
    this.emit({ ts: now(), level: "info", event: "match_result", ...fields });
  }

  clarification(
    type: ClarificationEvent["event"],
    fields: Omit<ClarificationEvent, "ts" | "level" | "event">
  ): void {
    this.emit({ ts: now(), level: "info", event: type, ...fields });
  }

  cache(
    type: CacheEvent["event"],
    fields: Omit<CacheEvent, "ts" | "level" | "event"> = {}
  ): void {
    const level: LogLevel = type === "cache_error" ? "warn" : "debug";
    this.emit({ ts: now(), level, event: type, ...fields });
  }

  briefLifecycle(
    type: BriefLifecycleEvent["event"],
    fields: Omit<BriefLifecycleEvent, "ts" | "level" | "event">
  ): void {
    this.emit({ ts: now(), level: "info", event: type, ...fields });
  }

  error(error: string, context?: string, request_id?: string): void {
    this.emit({ ts: now(), level: "error", event: "bot_error", error, context, request_id });
  }

  cursorCommit(success: boolean, cursor?: number, error?: string): void {
    const level: LogLevel = success ? "debug" : "warn";
    this.emit({ ts: now(), level, event: "cursor_commit", success, cursor, error });
  }

  matchOutcome(
    sender: string,
    outcome: MatchOutcomeEvent["outcome"],
    requestId?: string,
    selection?: number
  ): void {
    this.emit({
      ts: now(),
      level: "info",
      event: "match_outcome",
      sender,
      outcome,
      request_id: requestId,
      selection,
    });
  }

  info(message: string): void {
    if (this.minLevel > LOG_LEVELS.info) return;
    process.stderr.write(`${now()} [info] ${message}\n`);
  }

  warn(message: string): void {
    if (this.minLevel > LOG_LEVELS.warn) return;
    process.stderr.write(`${now()} [warn] ${message}\n`);
  }
}

function now(): string {
  return new Date().toISOString();
}

export function generateRequestId(): string {
  return randomUUID().slice(0, 8);
}

export const defaultLogger = new Logger({
  level: (process.env.PFT_LOG_LEVEL as LogLevel) || "info",
  json: process.env.PFT_LOG_FORMAT === "json" || process.env.NODE_ENV === "production",
});
