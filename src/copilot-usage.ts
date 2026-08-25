import type { CopilotUsageConfig, InsightsConfig } from "./capture.js";
import { formatUsageBar } from "./go-usage.js";

export type CopilotQuotaSnapshot = {
  quota_id: string;
  unlimited: boolean;
  has_quota: boolean;
  entitlement: number;
  remaining: number;
  quota_remaining: number;
  percent_remaining: number;
  credits_used: number;
  overage_permitted: boolean;
  overage_count: number;
};

export type CopilotUsage = {
  copilot_plan: string;
  quota_reset_date_utc: string;
  quota_snapshots: {
    premium_interactions: CopilotQuotaSnapshot;
    chat: CopilotQuotaSnapshot;
    completions: CopilotQuotaSnapshot;
    [key: string]: CopilotQuotaSnapshot;
  };
};

export type CopilotUsageRow = {
  used: number;
  total: number;
  percentUsed: number;
  daysRemaining: number;
  creditsUsed: number;
};

export type CopilotUsageState = {
  data?: CopilotUsage | undefined;
  error?: string | undefined;
  lastFetchAt?: number | undefined;
};

export class CopilotUsageError extends Error {}

export async function fetchCopilotUsage(
  token: string,
  fetchImpl: typeof fetch = fetch
): Promise<CopilotUsage> {
  const response = await fetchImpl("https://api.github.com/copilot_internal/user", {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json"
    }
  });
  if (response.status === 401 || response.status === 403) {
    throw new CopilotUsageError("token expired or invalid; update token in config or re-authenticate");
  }
  if (!response.ok) {
    throw new CopilotUsageError(`copilot API request failed with status ${response.status}`);
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new CopilotUsageError("could not parse copilot usage response");
  }
  return body as CopilotUsage;
}

export function copilotUsageRow(data: CopilotUsage, now: number): CopilotUsageRow | undefined {
  const pi = data.quota_snapshots?.premium_interactions;
  if (!pi || pi.unlimited) return undefined;
  const used = pi.entitlement - pi.remaining;
  const percentUsed = 100 - pi.percent_remaining;
  const resetDate = Date.parse(data.quota_reset_date_utc);
  const daysRemaining = Number.isFinite(resetDate)
    ? Math.max(0, Math.ceil((resetDate - now) / 86_400_000))
    : 0;
  return { used, total: pi.entitlement, percentUsed, daysRemaining, creditsUsed: pi.credits_used };
}

export function formatCopilotUsageRow(row: CopilotUsageRow): string {
  const bar = formatUsageBar(row.percentUsed);
  const pct = `${Math.round(row.percentUsed)}%`;
  const main = `${"Premium".padEnd(9)}${pct.padEnd(4)} ${bar} ${row.daysRemaining}d`;
  const detail = `${"".padEnd(9)}${String(row.used).padStart(4)} / ${row.total}`;
  return `${main}\n${detail}`;
}

export function copilotUsageSectionVisible(
  config: InsightsConfig,
  token: string,
  usesCopilot: boolean
): boolean {
  return usesCopilot && config.copilotUsage.enabled && token.length > 0;
}

export function createCopilotProviderTracker() {
  const providers = new Map<string, string>();
  return {
    record(sessionID: string, providerID: string | undefined) {
      if (providerID) providers.set(sessionID, providerID);
    },
    usesCopilot(sessionID: string) {
      return providers.get(sessionID) === "github-copilot";
    }
  };
}

export function createCopilotUsageRefresher(
  config: CopilotUsageConfig,
  token: string,
  fetchImpl: typeof fetch = fetch
) {
  const state: CopilotUsageState = {};
  let inflight: Promise<void> | undefined;

  async function refresh(now = Date.now()): Promise<boolean> {
    if (inflight) {
      await inflight;
      return false;
    }
    if (state.lastFetchAt !== undefined && now - state.lastFetchAt < config.refreshMs) return false;
    inflight = (async () => {
      try {
        state.data = await fetchCopilotUsage(token, fetchImpl);
        state.error = undefined;
      } catch (error) {
        state.error = error instanceof Error ? error.message : String(error);
      } finally {
        state.lastFetchAt = now;
        inflight = undefined;
      }
    })();
    await inflight;
    return true;
  }

  return { state, refresh };
}
