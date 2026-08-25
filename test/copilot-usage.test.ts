import { readFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";
import {
  CopilotUsageError,
  copilotUsageRow,
  copilotUsageSectionVisible,
  createCopilotProviderTracker,
  createCopilotUsageRefresher,
  fetchCopilotUsage,
  formatCopilotUsageRow,
  type CopilotUsage
} from "../src/copilot-usage.js";
import type { InsightsConfig } from "../src/capture.js";

const FIXTURE: CopilotUsage = JSON.parse(
  await readFile(new URL("./fixtures/copilot-user.json", import.meta.url), "utf8")
);

const ENABLED_CONFIG: InsightsConfig = {
  promptRightMetrics: ["tps"],
  goUsage: { enabled: false, cookie: "", workspaceID: "", refreshMs: 300_000 },
  copilotUsage: { enabled: true, token: "ghp_test", refreshMs: 300_000 }
};

describe("copilotUsageSectionVisible", () => {
  test("requires enabled flag, non-empty token, and copilot provider", () => {
    expect(copilotUsageSectionVisible(ENABLED_CONFIG, "ghp_test", true)).toBe(true);
    expect(copilotUsageSectionVisible(ENABLED_CONFIG, "ghp_test", false)).toBe(false);
    expect(copilotUsageSectionVisible({ ...ENABLED_CONFIG, copilotUsage: { ...ENABLED_CONFIG.copilotUsage, enabled: false } }, "ghp_test", true)).toBe(false);
    expect(copilotUsageSectionVisible(ENABLED_CONFIG, "", true)).toBe(false);
  });
});

describe("createCopilotProviderTracker", () => {
  test("tracks the latest provider per session", () => {
    const tracker = createCopilotProviderTracker();
    tracker.record("ses_1", "github-copilot");
    expect(tracker.usesCopilot("ses_1")).toBe(true);
    tracker.record("ses_1", "openai");
    expect(tracker.usesCopilot("ses_1")).toBe(false);
  });

  test("does not claim copilot for unknown sessions", () => {
    const tracker = createCopilotProviderTracker();
    tracker.record("ses_1", "github-copilot");
    expect(tracker.usesCopilot("ses_2")).toBe(false);
  });

  test("keeps the previous provider when an event carries none", () => {
    const tracker = createCopilotProviderTracker();
    tracker.record("ses_1", "github-copilot");
    tracker.record("ses_1", undefined);
    expect(tracker.usesCopilot("ses_1")).toBe(true);
  });
});

describe("copilotUsageRow", () => {
  test("extracts used/total/percent/days from fixture", () => {
    const resetMs = Date.parse(FIXTURE.quota_reset_date_utc);
    const row = copilotUsageRow(FIXTURE, resetMs - 7 * 86_400_000);
    expect(row).toEqual({
      used: 2942,
      total: 3500,
      percentUsed: 84.1,
      daysRemaining: 7,
      creditsUsed: 2930
    });
  });

  test("returns undefined for unlimited quotas", () => {
    const unlimited: CopilotUsage = {
      ...FIXTURE,
      quota_snapshots: {
        ...FIXTURE.quota_snapshots,
        premium_interactions: { ...FIXTURE.quota_snapshots.premium_interactions, unlimited: true }
      }
    };
    expect(copilotUsageRow(unlimited, Date.now())).toBeUndefined();
  });

  test("clamps daysRemaining to zero for past reset dates", () => {
    const past = Date.parse(FIXTURE.quota_reset_date_utc) + 86_400_000;
    const row = copilotUsageRow(FIXTURE, past);
    expect(row?.daysRemaining).toBe(0);
  });
});

describe("formatCopilotUsageRow", () => {
  test("renders main row and detail sub-row", () => {
    const output = formatCopilotUsageRow({ used: 2942, total: 3500, percentUsed: 84.1, daysRemaining: 7, creditsUsed: 2930 });
    const lines = output.split("\n");
    expect(lines[0]).toBe("Premium  84%  ████████▍░ 7d");
    expect(lines[1]).toBe("         2942 / 3500");
  });

  test("aligns for single-digit percentages", () => {
    const output = formatCopilotUsageRow({ used: 100, total: 3500, percentUsed: 2.9, daysRemaining: 20, creditsUsed: 100 });
    const lines = output.split("\n");
    expect(lines[0]).toBe("Premium  3%   ▎░░░░░░░░░ 20d");
    expect(lines[1]).toBe("          100 / 3500");
  });

  test("shows 100% when fully used", () => {
    const output = formatCopilotUsageRow({ used: 3500, total: 3500, percentUsed: 100, daysRemaining: 0, creditsUsed: 3500 });
    const lines = output.split("\n");
    expect(lines[0]).toBe("Premium  100% ██████████ 0d");
  });
});

describe("fetchCopilotUsage", () => {
  test("fetches the copilot internal user endpoint with bearer token", async () => {
    let requestedURL = "";
    let requestedInit: RequestInit | undefined;
    const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
      requestedURL = String(url);
      requestedInit = init;
      return new Response(JSON.stringify(FIXTURE), { status: 200 });
    };

    const usage = await fetchCopilotUsage("ghp_test_token", fetchImpl);

    expect(requestedURL).toBe("https://api.github.com/copilot_internal/user");
    const authHeader = (requestedInit?.headers as Record<string, string>)?.Authorization;
    expect(authHeader).toBe("Bearer ghp_test_token");
    expect(usage.copilot_plan).toBe("business");
    expect(usage.quota_snapshots.premium_interactions.entitlement).toBe(3500);
  });

  test("rejects on 401 with token expired message", async () => {
    const fetchImpl = async () => new Response(null, { status: 401 });
    await expect(fetchCopilotUsage("bad_token", fetchImpl)).rejects.toThrow("token expired or invalid");
  });

  test("rejects on 403 with token expired message", async () => {
    const fetchImpl = async () => new Response(null, { status: 403 });
    await expect(fetchCopilotUsage("bad_token", fetchImpl)).rejects.toThrow("token expired or invalid");
  });

  test("rejects on server error", async () => {
    const fetchImpl = async () => new Response("boom", { status: 500 });
    await expect(fetchCopilotUsage("ghp_test", fetchImpl)).rejects.toThrow("failed with status 500");
  });

  test("rejects on malformed JSON", async () => {
    const fetchImpl = async () => new Response("not json", { status: 200 });
    await expect(fetchCopilotUsage("ghp_test", fetchImpl)).rejects.toThrow("could not parse");
  });
});

describe("createCopilotUsageRefresher", () => {
  test("fetches usage, stores it and clears any error", async () => {
    let calls = 0;
    const refresher = createCopilotUsageRefresher(
      ENABLED_CONFIG.copilotUsage,
      "ghp_test",
      async () => {
        calls += 1;
        return new Response(JSON.stringify(FIXTURE), { status: 200 });
      }
    );

    await refresher.refresh(1_000);

    expect(calls).toBe(1);
    expect(refresher.state.data).toEqual(FIXTURE);
    expect(refresher.state.error).toBeUndefined();
    expect(refresher.state.lastFetchAt).toBe(1_000);
  });

  test("skips refetching while the cached usage is still fresh", async () => {
    let calls = 0;
    const refresher = createCopilotUsageRefresher(
      { ...ENABLED_CONFIG.copilotUsage, refreshMs: 100 },
      "ghp_test",
      async () => {
        calls += 1;
        return new Response(JSON.stringify(FIXTURE), { status: 200 });
      }
    );

    await refresher.refresh(1_000);
    await refresher.refresh(1_050);
    expect(calls).toBe(1);

    await refresher.refresh(1_100);
    expect(calls).toBe(2);
  });

  test("reports an error on failed fetch", async () => {
    const refresher = createCopilotUsageRefresher(
      ENABLED_CONFIG.copilotUsage,
      "ghp_test",
      async () => {
        throw new Error("network down");
      }
    );

    await refresher.refresh(1_000);
    expect(refresher.state.error).toBe("network down");
    expect(refresher.state.data).toBeUndefined();
  });

  test("deduplicates concurrent refresh calls", async () => {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const refresher = createCopilotUsageRefresher(
      ENABLED_CONFIG.copilotUsage,
      "ghp_test",
      async () => {
        calls += 1;
        await gate;
        return new Response(JSON.stringify(FIXTURE), { status: 200 });
      }
    );

    const first = refresher.refresh(1_000);
    const second = refresher.refresh(1_000);
    release();
    await Promise.all([first, second]);

    expect(calls).toBe(1);
  });
});
