import type { GoUsageConfig, InsightsConfig } from "./capture.js";

export type GoUsageLimit = {
  status: string;
  resetInSec: number;
  usagePercent: number;
};

export type GoUsage = {
  rollingUsage: GoUsageLimit;
  weeklyUsage: GoUsageLimit;
  monthlyUsage: GoUsageLimit;
};

export class GoUsageError extends Error {}

const USAGE_PATTERN = /(rollingUsage|weeklyUsage|monthlyUsage):\$R\[(\d+)\]=\{([^{}]*)\}/g;
const KEY_PATTERN = /([a-zA-Z]+):/g;

export function parseGoUsageHtml(html: string): GoUsage | undefined {
  const usage: Partial<GoUsage> = {};
  USAGE_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = USAGE_PATTERN.exec(html))) {
    const key = match[1] as keyof GoUsage;
    const literal = match[3] ?? "";
    try {
      usage[key] = JSON.parse(`{${literal.replace(KEY_PATTERN, '"$1":')}}`);
    } catch {
      return undefined;
    }
  }
  if (!usage.rollingUsage || !usage.weeklyUsage || !usage.monthlyUsage) return undefined;
  return usage as GoUsage;
}

export async function fetchGoUsage(
  input: { cookie: string; workspaceID: string },
  fetchImpl: typeof fetch = fetch
): Promise<GoUsage> {
  const response = await fetchImpl(`https://opencode.ai/workspace/${input.workspaceID}/go`, {
    headers: {
      "user-agent": "Mozilla/5.0",
      cookie: `auth=${input.cookie}`
    },
    redirect: "manual"
  });
  if (response.status >= 300 && response.status < 400) {
    throw new GoUsageError("console redirected to login; the auth cookie may be expired");
  }
  if (!response.ok) {
    throw new GoUsageError(`console request failed with status ${response.status}`);
  }
  const usage = parseGoUsageHtml(await response.text());
  if (!usage) throw new GoUsageError("could not parse go usage from the console page");
  return usage;
}

export function formatReset(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  return `${minutes}m`;
}

const BLOCK_PARTIALS = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"];

export function formatUsageBar(usagePercent: number, width = 10): string {
  const percent = Math.max(0, Math.min(100, usagePercent));
  const steps = width * 8;
  const filled = Math.min(steps, Math.max(0, Math.round((percent / 100) * steps)));
  const full = Math.floor(filled / 8);
  const remainder = filled % 8;
  const partial = BLOCK_PARTIALS[remainder] ?? "";
  const empty = Math.max(0, width - full - (partial.length > 0 ? 1 : 0));
  return "█".repeat(full) + partial + "░".repeat(empty);
}

export function formatGoUsageRow(row: GoUsageRow): string {
  const bar = formatUsageBar(row.usagePercent);
  const pct = `${Math.round(row.usagePercent)}%`;
  return `${row.label.padEnd(9)}${pct.padEnd(4)} ${bar} ${row.reset}`;
}

export function goUsageSectionVisible(config: InsightsConfig, usesGoProvider: boolean): boolean {
  return (
    usesGoProvider &&
    config.goUsage.enabled &&
    config.goUsage.cookie.length > 0 &&
    config.goUsage.workspaceID.length > 0
  );
}

export function createGoProviderTracker() {
  const providers = new Map<string, string>();
  return {
    record(sessionID: string, providerID: string | undefined) {
      if (providerID) providers.set(sessionID, providerID);
    },
    usesOpenCodeGo(sessionID: string) {
      return providers.get(sessionID) === "opencode-go";
    }
  };
}

export type GoUsageState = {
  data?: GoUsage | undefined;
  error?: string | undefined;
  lastFetchAt?: number | undefined;
};

export type GoUsageRow = {
  label: string;
  usagePercent: number;
  reset: string;
};

export function goUsageRows(state: GoUsageState, now: number): GoUsageRow[] | undefined {
  if (!state.data) return undefined;
  const elapsedSeconds = state.lastFetchAt === undefined ? 0 : Math.max(0, (now - state.lastFetchAt) / 1000);
  return [
    {
      label: "Rolling",
      usagePercent: state.data.rollingUsage.usagePercent,
      reset: formatReset(state.data.rollingUsage.resetInSec - elapsedSeconds)
    },
    {
      label: "Weekly",
      usagePercent: state.data.weeklyUsage.usagePercent,
      reset: formatReset(state.data.weeklyUsage.resetInSec - elapsedSeconds)
    },
    {
      label: "Monthly",
      usagePercent: state.data.monthlyUsage.usagePercent,
      reset: formatReset(state.data.monthlyUsage.resetInSec - elapsedSeconds)
    }
  ];
}

export function createGoUsageRefresher(config: GoUsageConfig, fetchImpl: typeof fetch = fetch) {
  const state: GoUsageState = {};
  let inflight: Promise<void> | undefined;

  async function refresh(now = Date.now()): Promise<boolean> {
    if (inflight) {
      await inflight;
      return false;
    }
    if (state.lastFetchAt !== undefined && now - state.lastFetchAt < config.refreshMs) return false;
    inflight = (async () => {
      try {
        state.data = await fetchGoUsage({ cookie: config.cookie, workspaceID: config.workspaceID }, fetchImpl);
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
