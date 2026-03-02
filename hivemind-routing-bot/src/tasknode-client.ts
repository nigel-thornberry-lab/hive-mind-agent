/**
 * Minimal Task Node API client for fetching leaderboard and operator profiles.
 * Used by the member index cache only; no wallet operations.
 */

const DEFAULT_BASE_URL = "https://tasknode.postfiat.org";

function toNumberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

export interface OperatorProfile {
  operator_id: string | null;
  wallet_address: string | null;
  wallet_label: string | null;
  summary: string | null;
  capabilities: unknown[];
  expert_knowledge: { domain: string | null; confidence: string | null }[];
  sybil_score: number | null;
  sybil_risk: string | null;
  linked_accounts: unknown[];
  alignment_score: number | null;
  alignment_tier: string | null;
  weekly_tasks: number;
  monthly_tasks: number;
  weekly_rewards: number;
  monthly_rewards: number;
  leaderboard_score_week: number | null;
  leaderboard_score_month: number | null;
  is_public: boolean;
  is_published: boolean;
  published_at: string | null;
  nft_image_url: string | null;
  avatar_image_url: string | null;
}

export interface TaskNodeClientOptions {
  jwt: string;
  baseUrl?: string;
  timeoutMs?: number;
}

export class TaskNodeClient {
  private jwt: string;
  private baseUrl: string;
  private timeoutMs: number;

  constructor({ jwt, baseUrl = DEFAULT_BASE_URL, timeoutMs = 30_000 }: TaskNodeClientOptions) {
    if (!jwt) throw new Error("TaskNodeClient requires jwt (PFT_TASKNODE_JWT).");
    this.jwt = jwt;
    this.baseUrl = new URL(baseUrl).toString().replace(/\/$/, "");
    this.timeoutMs = timeoutMs;
  }

  private async request(
    path: string,
    options: { method?: string; body?: unknown } = {}
  ): Promise<{ status: number; json: unknown }> {
    const url = `${this.baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(url, {
        method: options.method || "GET",
        headers: {
          Authorization: `Bearer ${this.jwt}`,
          Accept: "application/json",
          ...(options.body ? { "Content-Type": "application/json" } : {}),
        },
        body: options.body ? JSON.stringify(options.body) : undefined,
        signal: controller.signal,
      });
      const text = await res.text();
      let json: unknown = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = null;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
      return { status: res.status, json };
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async getLeaderboard(): Promise<{ rows?: unknown[] }> {
    const { json } = await this.request("/api/leaderboard");
    return (json as { rows?: unknown[] }) || {};
  }

  async getProfilePublic(walletAddress: string): Promise<unknown> {
    const { json } = await this.request(`/api/profile/public/${encodeURIComponent(walletAddress)}`);
    return json;
  }

  private mapLeaderboardToOperatorProfile(row: Record<string, unknown>): OperatorProfile {
    return {
      operator_id: (row.user_id as string) ?? null,
      wallet_address: (row.wallet_address as string) ?? null,
      wallet_label: null,
      summary: (row.summary as string) ?? null,
      capabilities: asArray(row.capabilities),
      expert_knowledge: asArray(row.expert_knowledge).map((entry: unknown) => {
        const e = entry as Record<string, unknown>;
        return {
          domain: e?.domain != null ? String(e.domain) : null,
          confidence: null,
        };
      }),
      sybil_score: toNumberOrNull(row.sybil_score),
      sybil_risk: (row.sybil_risk as string) ?? null,
      linked_accounts: [],
      alignment_score: toNumberOrNull(row.alignment_score),
      alignment_tier: (row.alignment_tier as string) ?? null,
      weekly_tasks: toNumberOrNull(row.weekly_tasks) ?? 0,
      monthly_tasks: toNumberOrNull(row.monthly_tasks) ?? 0,
      weekly_rewards: toNumberOrNull(row.weekly_rewards) ?? 0,
      monthly_rewards: toNumberOrNull(row.monthly_rewards) ?? 0,
      leaderboard_score_week: toNumberOrNull(row.leaderboard_score_week),
      leaderboard_score_month: toNumberOrNull(row.leaderboard_score_month),
      is_public: Boolean(row.is_public),
      is_published: Boolean(row.is_published),
      published_at: (row.published_at as string) ?? null,
      nft_image_url: (row.nft_image_url as string) ?? null,
      avatar_image_url: null,
    };
  }

  private mergePublicProfile(
    operator: OperatorProfile,
    profilePayload: unknown
  ): OperatorProfile {
    const profile = (profilePayload as Record<string, unknown>)?.profile as Record<string, unknown> | undefined;
    if (!profile) return operator;
    const expertKnowledge = asArray(profile.expert_knowledge).map((entry: unknown) => {
      const e = entry as Record<string, unknown>;
      return {
        domain: e?.domain != null ? String(e.domain) : null,
        confidence: e?.confidence != null ? String(e.confidence) : null,
      };
    });
    return {
      ...operator,
      summary: (profile.summary as string) ?? operator.summary,
      expert_knowledge: expertKnowledge.length > 0 ? expertKnowledge : operator.expert_knowledge,
      alignment_score: toNumberOrNull((profile.alignment as Record<string, unknown>)?.alignment_score) ?? operator.alignment_score,
      alignment_tier: ((profile.alignment as Record<string, unknown>)?.alignment_tier as string) ?? operator.alignment_tier,
      sybil_score: toNumberOrNull((profile.sybil_score as Record<string, unknown>)?.sybil_score) ?? operator.sybil_score,
      sybil_risk: ((profile.sybil_score as Record<string, unknown>)?.sybil_risk as string) ?? operator.sybil_risk,
      is_published: Boolean(profile?.is_published ?? operator.is_published),
    };
  }

  async fetchOperatorProfiles({ limit = 50 }: { limit?: number }): Promise<OperatorProfile[]> {
    const { rows = [] } = await this.getLeaderboard();
    const slice = (rows as Record<string, unknown>[]).slice(0, Math.max(1, limit));
    const profiles: OperatorProfile[] = [];
    const concurrency = Math.max(
      1,
      Math.min(20, Number(process.env.PFT_PROFILE_FETCH_CONCURRENCY) || 8)
    );
    for (let i = 0; i < slice.length; i += concurrency) {
      const batch = slice.slice(i, i + concurrency);
      const resolved = await Promise.all(
        batch.map(async (row) => {
          const base = this.mapLeaderboardToOperatorProfile(row);
          try {
            const wallet = base.wallet_address;
            if (wallet) {
              const publicProfile = await this.getProfilePublic(wallet);
              return this.mergePublicProfile(base, publicProfile);
            }
            return base;
          } catch {
            return base;
          }
        })
      );
      profiles.push(...resolved);
    }
    return profiles;
  }

  async getRoutingIntegrityStatus(): Promise<unknown> {
    const path = process.env.PFT_TASKNODE_INTEGRITY_PATH || "/api/routing/integrity";
    const { json } = await this.request(path);
    return json;
  }
}
