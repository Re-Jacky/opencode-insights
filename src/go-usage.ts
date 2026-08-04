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
  if (days > 0) return hours > 0 ? `${days}d${hours}h` : `${days}d`;
  if (hours > 0) return minutes > 0 ? `${hours}h${minutes}m` : `${hours}h`;
  return `${minutes}m`;
}

export function goUsageSectionVisible(config: InsightsConfig, usesGoProvider: boolean): boolean {
  return (
    usesGoProvider &&
    config.goUsage.enabled &&
    config.goUsage.cookie.length > 0 &&
    config.goUsage.workspaceID.length > 0
  );
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

  async function refresh(now = Date.now()): Promise<void> {
    if (inflight) {
      await inflight;
      return;
    }
    if (state.lastFetchAt !== undefined && now - state.lastFetchAt < config.refreshMs) return;
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
  }

  return { state, refresh };
}
