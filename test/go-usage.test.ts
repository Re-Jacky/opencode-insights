import { readFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";
import {
  GoUsageError,
  createGoUsageRefresher,
  fetchGoUsage,
  formatReset,
  goUsageRows,
  goUsageSectionVisible,
  parseGoUsageHtml
} from "../src/go-usage.js";
import type { InsightsConfig } from "../src/capture.js";

const FIXTURE = await readFile(new URL("./fixtures/go-usage-page.html", import.meta.url), "utf8");

const ENABLED_CONFIG: InsightsConfig = {
  promptRightMetrics: ["tps"],
  goUsage: { enabled: true, cookie: "cookie", workspaceID: "wrk_1", refreshMs: 300_000 }
};

describe("goUsageSectionVisible", () => {
  test("requires the go provider, opt-in flag, cookie and workspace id", () => {
    expect(goUsageSectionVisible(ENABLED_CONFIG, true)).toBe(true);
    expect(goUsageSectionVisible(ENABLED_CONFIG, false)).toBe(false);
    expect(goUsageSectionVisible({ ...ENABLED_CONFIG, goUsage: { ...ENABLED_CONFIG.goUsage, enabled: false } }, true)).toBe(false);
    expect(goUsageSectionVisible({ ...ENABLED_CONFIG, goUsage: { ...ENABLED_CONFIG.goUsage, cookie: "" } }, true)).toBe(false);
    expect(goUsageSectionVisible({ ...ENABLED_CONFIG, goUsage: { ...ENABLED_CONFIG.goUsage, workspaceID: "" } }, true)).toBe(false);
  });
});

describe("goUsageRows", () => {
  test("returns undefined without fetched usage", () => {
    expect(goUsageRows({}, 1_000)).toBeUndefined();
  });

  test("renders a row per limit with percent and countdown reset", () => {
    const state = { data: parseGoUsageHtml(FIXTURE), lastFetchAt: 10_000 };
    expect(goUsageRows(state, 10_000)).toEqual([
      { label: "Rolling", usagePercent: 12, reset: "2h33m" },
      { label: "Weekly", usagePercent: 11, reset: "5d15h" },
      { label: "Monthly", usagePercent: 27, reset: "1d17h" }
    ]);
  });

  test("counts the reset down as time passes since the fetch", () => {
    const state = { data: parseGoUsageHtml(FIXTURE), lastFetchAt: 10_000 };
    const rows = goUsageRows(state, 10_000 + 60_000);
    expect(rows?.[0]?.reset).toBe("2h32m");
    expect(rows?.[0]?.usagePercent).toBe(12);
  });
});

describe("createGoUsageRefresher", () => {
  test("fetches usage, stores it and clears any error", async () => {
    let calls = 0;
    const refresher = createGoUsageRefresher(ENABLED_CONFIG.goUsage, async () => {
      calls += 1;
      return new Response(FIXTURE, { status: 200 });
    });

    await refresher.refresh(1_000);

    expect(calls).toBe(1);
    expect(refresher.state.data).toEqual(parseGoUsageHtml(FIXTURE));
    expect(refresher.state.error).toBeUndefined();
    expect(refresher.state.lastFetchAt).toBe(1_000);
  });

  test("skips refetching while the cached usage is still fresh", async () => {
    let calls = 0;
    const refresher = createGoUsageRefresher(
      { ...ENABLED_CONFIG.goUsage, refreshMs: 100 },
      async () => {
        calls += 1;
        return new Response(FIXTURE, { status: 200 });
      }
    );

    await refresher.refresh(1_000);
    await refresher.refresh(1_050);
    expect(calls).toBe(1);

    await refresher.refresh(1_100);
    expect(calls).toBe(2);
  });

  test("reports whether the refresh actually fetched", async () => {
    let calls = 0;
    const refresher = createGoUsageRefresher(
      { ...ENABLED_CONFIG.goUsage, refreshMs: 100 },
      async () => {
        calls += 1;
        return new Response(FIXTURE, { status: 200 });
      }
    );

    expect(await refresher.refresh(1_000)).toBe(true);
    expect(await refresher.refresh(1_050)).toBe(false);
    expect(await refresher.refresh(1_100)).toBe(true);
    expect(calls).toBe(2);
  });

  test("reports an attempted fetch as true even when it failed", async () => {
    const refresher = createGoUsageRefresher(
      { ...ENABLED_CONFIG.goUsage, refreshMs: 100 },
      async () => {
        throw new Error("network down");
      }
    );

    expect(await refresher.refresh(1_000)).toBe(true);
    expect(refresher.state.error).toBeDefined();
  });

  test("a notify-refresh listener cycle terminates once data is fresh", async () => {
    let calls = 0;
    const refresher = createGoUsageRefresher(
      { ...ENABLED_CONFIG.goUsage, refreshMs: 100 },
      async () => {
        calls += 1;
        return new Response(FIXTURE, { status: 200 });
      }
    );

    let syncs = 0;
    const cycle = async () => {
      syncs += 1;
      if (await refresher.refresh(1_000)) await cycle();
    };
    await cycle();

    expect(syncs).toBe(2);
    expect(calls).toBe(1);
  });

  test("refetches after an error once the refresh interval has passed", async () => {
    let calls = 0;
    const refresher = createGoUsageRefresher(
      { ...ENABLED_CONFIG.goUsage, refreshMs: 100 },
      async () => {
        calls += 1;
        if (calls === 1) return new Response(null, { status: 500 });
        return new Response(FIXTURE, { status: 200 });
      }
    );

    await refresher.refresh(1_000);
    expect(refresher.state.error).toBeDefined();
    expect(refresher.state.data).toBeUndefined();

    await refresher.refresh(1_100);
    expect(calls).toBe(2);
    expect(refresher.state.error).toBeUndefined();
    expect(refresher.state.data).toBeDefined();
  });

  test("deduplicates concurrent refresh calls", async () => {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const refresher = createGoUsageRefresher(
      { ...ENABLED_CONFIG.goUsage, refreshMs: 100 },
      async () => {
        calls += 1;
        await gate;
        return new Response(FIXTURE, { status: 200 });
      }
    );

    const first = refresher.refresh(1_000);
    const second = refresher.refresh(1_000);
    release();
    await Promise.all([first, second]);

    expect(calls).toBe(1);
  });
});

describe("parseGoUsageHtml", () => {
  test("parses rolling, weekly and monthly usage from a real console page", () => {
    expect(parseGoUsageHtml(FIXTURE)).toEqual({
      rollingUsage: { status: "ok", resetInSec: 9238, usagePercent: 12 },
      weeklyUsage: { status: "ok", resetInSec: 487215, usagePercent: 11 },
      monthlyUsage: { status: "ok", resetInSec: 149336, usagePercent: 27 }
    });
  });

  test("returns undefined when the page does not contain usage payloads", () => {
    expect(parseGoUsageHtml("<!doctype html><html>no usage here</html>")).toBeUndefined();
  });

  test("returns undefined when one of the three usage payloads is missing", () => {
    const partial = FIXTURE.replace(/monthlyUsage:\$R\[\d+\]=\{[^}]*\}/, "");
    expect(parseGoUsageHtml(partial)).toBeUndefined();
  });
});

describe("formatReset", () => {
  test("renders minutes below one hour", () => {
    expect(formatReset(0)).toBe("0m");
    expect(formatReset(59)).toBe("0m");
    expect(formatReset(3599)).toBe("59m");
  });

  test("renders hours and minutes below one day", () => {
    expect(formatReset(3600)).toBe("1h");
    expect(formatReset(11619)).toBe("3h13m");
    expect(formatReset(86399)).toBe("23h59m");
  });

  test("renders days and hours above one day", () => {
    expect(formatReset(86400)).toBe("1d");
    expect(formatReset(149336)).toBe("1d17h");
    expect(formatReset(487215)).toBe("5d15h");
  });
});

describe("fetchGoUsage", () => {
  test("fetches the console page with the auth cookie and returns parsed usage", async () => {
    let requestedURL = "";
    let requestedInit: RequestInit | undefined;
    const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
      requestedURL = String(url);
      requestedInit = init;
      return new Response(FIXTURE, { status: 200 });
    };

    const usage = await fetchGoUsage({ cookie: "secret-cookie", workspaceID: "wrk_test" }, fetchImpl);

    expect(requestedURL).toBe("https://opencode.ai/workspace/wrk_test/go");
    expect(requestedInit?.redirect).toBe("manual");
    const cookieHeader = (requestedInit?.headers as Record<string, string> | undefined)?.cookie ?? "";
    expect(cookieHeader).toContain("auth=secret-cookie");
    expect(usage).toEqual(parseGoUsageHtml(FIXTURE));
  });

  test("rejects when the console redirects to login", async () => {
    const fetchImpl = async () => new Response(null, { status: 302, headers: { location: "https://auth.opencode.ai/authorize" } });
    await expect(fetchGoUsage({ cookie: "c", workspaceID: "w" }, fetchImpl)).rejects.toBeInstanceOf(GoUsageError);
  });

  test("rejects on server errors", async () => {
    const fetchImpl = async () => new Response("boom", { status: 500 });
    await expect(fetchGoUsage({ cookie: "c", workspaceID: "w" }, fetchImpl)).rejects.toBeInstanceOf(GoUsageError);
  });

  test("rejects when the page cannot be parsed", async () => {
    const fetchImpl = async () => new Response("<html>no usage</html>", { status: 200 });
    await expect(fetchGoUsage({ cookie: "c", workspaceID: "w" }, fetchImpl)).rejects.toBeInstanceOf(GoUsageError);
  });
});
