/**
 * Cached snapshot of operator profiles (and optional integrity context) for stateless matching.
 * Stale-while-revalidate: serves stale data immediately on soft-TTL expiry while refreshing
 * in the background. Only blocks on hard expiry (10x soft TTL) or first load.
 */

import { TaskNodeClient } from "./tasknode-client.js";
import type { BotConfig } from "./config.js";

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function parseCsv(value: string): string[] {
  return String(value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export interface IntegrityContext {
  circuit_breaker: {
    blocked_operator_ids: string[];
    blocked_wallet_addresses: string[];
  };
  unauthorized_operator_ids: string[];
}

function buildIntegrityContext(
  rawPayload: unknown,
  env: NodeJS.ProcessEnv = process.env
): IntegrityContext {
  const payload = (rawPayload || {}) as Record<string, unknown>;
  const circuit = (payload.circuit_breaker || payload.circuitBreaker || {}) as Record<string, unknown>;
  return {
    circuit_breaker: {
      blocked_operator_ids: [
        ...asArray<string>(circuit.blocked_operator_ids),
        ...asArray<string>(circuit.blockedOperatorIds),
        ...parseCsv(env.PFT_INTEGRITY_BLOCKED_OPERATOR_IDS ?? ""),
      ],
      blocked_wallet_addresses: [
        ...asArray<string>(circuit.blocked_wallet_addresses),
        ...asArray<string>(circuit.blockedWalletAddresses),
        ...parseCsv(env.PFT_INTEGRITY_BLOCKED_WALLETS ?? ""),
      ],
    },
    unauthorized_operator_ids: [
      ...asArray<string>(payload.unauthorized_operator_ids),
      ...asArray<string>(payload.unauthorizedOperatorIds),
      ...parseCsv(env.PFT_INTEGRITY_UNAUTHORIZED_OPERATOR_IDS ?? ""),
    ],
  };
}

export interface MemberIndexSnapshot {
  metadata: { dataset: string; generated_at: string };
  operator_profiles: import("./tasknode-client.js").OperatorProfile[];
  integrity?: IntegrityContext;
}

export interface CacheStats {
  hits: number;
  misses: number;
  stale_serves: number;
  refreshes: number;
  errors: number;
  last_refresh_ms: number;
  operator_count: number;
}

export interface MemberIndexCacheOptions {
  config: BotConfig;
  /** Optional custom loader (for tests). */
  loader?: () => Promise<{ operator_profiles: import("./tasknode-client.js").OperatorProfile[]; integrity?: IntegrityContext }>;
  /** Callback fired on every cache event (for structured logging). */
  onCacheEvent?: (type: "hit" | "miss" | "stale_serve" | "refresh" | "error", detail: {
    operator_count?: number;
    latency_ms?: number;
    stale_age_ms?: number;
    error?: string;
  }) => void;
}

const HARD_TTL_MULTIPLIER = 10;

export class MemberIndexCache {
  private loader: () => Promise<{
    operator_profiles: import("./tasknode-client.js").OperatorProfile[];
    integrity?: IntegrityContext;
  }>;
  private softTtlMs: number;
  private hardTtlMs: number;
  private snapshot: MemberIndexSnapshot | null = null;
  private staleAt = 0;
  private hardExpiresAt = 0;
  private inFlight: Promise<MemberIndexSnapshot> | null = null;
  private onCacheEvent: MemberIndexCacheOptions["onCacheEvent"];

  readonly stats: CacheStats = {
    hits: 0,
    misses: 0,
    stale_serves: 0,
    refreshes: 0,
    errors: 0,
    last_refresh_ms: 0,
    operator_count: 0,
  };

  constructor({ config, loader, onCacheEvent }: MemberIndexCacheOptions) {
    this.softTtlMs = Math.max(1, config.memberIndexTtlMs);
    this.hardTtlMs = this.softTtlMs * HARD_TTL_MULTIPLIER;
    this.onCacheEvent = onCacheEvent;
    this.loader =
      loader ||
      (async () => {
        if (!config.taskNodeJwt) {
          throw new Error("PFT_TASKNODE_JWT is required to load the member index.");
        }
        const client = new TaskNodeClient({
          jwt: config.taskNodeJwt,
          baseUrl: config.taskNodeUrl,
          timeoutMs: Math.max(3000, Number(process.env.PFT_TASKNODE_HTTP_TIMEOUT_MS) || 12000),
        });
        const operatorProfiles = await client.fetchOperatorProfiles({
          limit: config.memberIndexLimit,
        });
        let integrity: IntegrityContext | undefined;
        try {
          const raw = await client.getRoutingIntegrityStatus();
          integrity = buildIntegrityContext(raw);
        } catch {
          integrity = buildIntegrityContext(null);
        }
        return { operator_profiles: operatorProfiles, integrity };
      });
  }

  async getSnapshot(options: { forceRefresh?: boolean } = {}): Promise<MemberIndexSnapshot> {
    const now = Date.now();

    if (!options.forceRefresh && this.snapshot && now < this.staleAt) {
      this.stats.hits++;
      this.onCacheEvent?.("hit", { operator_count: this.stats.operator_count });
      return this.snapshot;
    }

    if (!options.forceRefresh && this.snapshot && now < this.hardExpiresAt) {
      this.stats.stale_serves++;
      const staleAge = now - this.staleAt;
      this.onCacheEvent?.("stale_serve", { stale_age_ms: staleAge, operator_count: this.stats.operator_count });
      if (!this.inFlight) this.backgroundRefresh();
      return this.snapshot;
    }

    this.stats.misses++;
    this.onCacheEvent?.("miss", {});
    return this.blockingRefresh();
  }

  private backgroundRefresh(): void {
    this.inFlight = this.doRefresh().finally(() => { this.inFlight = null; });
  }

  private async blockingRefresh(): Promise<MemberIndexSnapshot> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.doRefresh().finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  private async doRefresh(): Promise<MemberIndexSnapshot> {
    const t0 = Date.now();
    try {
      const loaded = await this.loader();
      const elapsed = Date.now() - t0;
      this.snapshot = {
        metadata: {
          dataset: "member-index-cache",
          generated_at: new Date().toISOString(),
        },
        operator_profiles: loaded.operator_profiles ?? [],
        integrity: loaded.integrity,
      };
      const now = Date.now();
      this.staleAt = now + this.softTtlMs;
      this.hardExpiresAt = now + this.hardTtlMs;
      this.stats.refreshes++;
      this.stats.last_refresh_ms = elapsed;
      this.stats.operator_count = this.snapshot.operator_profiles.length;
      this.onCacheEvent?.("refresh", { operator_count: this.stats.operator_count, latency_ms: elapsed });
      return this.snapshot;
    } catch (err) {
      this.stats.errors++;
      const msg = err instanceof Error ? err.message : String(err);
      this.onCacheEvent?.("error", { error: msg });
      if (this.snapshot) return this.snapshot;
      throw err;
    }
  }
}
