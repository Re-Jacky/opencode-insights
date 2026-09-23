import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "vitest";
import {
  readInsightsConfig,
  resolveCopilotToken,
  type CopilotUsageConfig
} from "../src/config.js";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("insights config", () => {
  test("writes a default config on first run and drops dbPath/retentionDays", async () => {
    const dir = await mkdtemp(join(tmpdir(), "opencode-insights-config-"));
    cleanup.push(dir);

    const config = await readInsightsConfig({ dataDir: dir });

    expect(config.promptRightMetrics.length).toBeGreaterThan(0);
    expect(config.goUsage.enabled).toBe(false);
    expect(config.copilotUsage.enabled).toBe(false);
    expect(config).not.toHaveProperty("dbPath");
    expect(config).not.toHaveProperty("retentionDays");
    expect(existsSync(join(dir, "config.jsonc"))).toBe(true);
  });

  test("parses promptRightMetrics, goUsage, and copilotUsage from config.jsonc", async () => {
    const dir = await mkdtemp(join(tmpdir(), "opencode-insights-config-"));
    cleanup.push(dir);
    await writeFile(
      join(dir, "config.jsonc"),
      JSON.stringify({
        promptRightMetrics: ["tps", "output"],
        goUsage: { enabled: true, cookie: "c", workspaceID: "w", refreshMs: 1000 },
        copilotUsage: { enabled: true, token: "t", refreshMs: 1000 }
      }),
      "utf8"
    );

    const config = await readInsightsConfig({ dataDir: dir });

    expect(config.promptRightMetrics).toEqual(["tps", "output"]);
    expect(config.goUsage).toEqual({ enabled: true, cookie: "c", workspaceID: "w", refreshMs: 60_000 });
    expect(config.copilotUsage.enabled).toBe(true);
    expect(config.copilotUsage.token).toBe("t");
  });

  test("accepts total and maps the legacy used metric to total", async () => {
    const dir = await mkdtemp(join(tmpdir(), "opencode-insights-config-"));
    cleanup.push(dir);
    await writeFile(join(dir, "config.jsonc"), JSON.stringify({ promptRightMetrics: ["total"] }), "utf8");

    const config = await readInsightsConfig({ dataDir: dir });
    expect(config.promptRightMetrics).toEqual(["total"]);

    await writeFile(join(dir, "config.jsonc"), JSON.stringify({ promptRightMetrics: ["used"] }), "utf8");
    const legacyConfig = await readInsightsConfig({ dataDir: dir });
    expect(legacyConfig.promptRightMetrics).toEqual(["total"]);
  });

  test("falls back to defaults on malformed jsonc", async () => {
    const dir = await mkdtemp(join(tmpdir(), "opencode-insights-config-"));
    cleanup.push(dir);
    await writeFile(join(dir, "config.jsonc"), "{ not valid", "utf8");

    const config = await readInsightsConfig({ dataDir: dir });

    expect(config.promptRightMetrics.length).toBeGreaterThan(0);
    expect(config.goUsage.enabled).toBe(false);
  });

  test("resolveCopilotToken prefers the explicit config token", () => {
    const config: CopilotUsageConfig = { enabled: true, token: "explicit", refreshMs: 300_000 };
    expect(resolveCopilotToken(config)).toBe("explicit");
  });
});
