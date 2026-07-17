import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "vitest";
import { OpenCodeInsights } from "../src/index.js";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("plugin startup", () => {
  test("initializes local storage on load", async () => {
    const dir = await mkdtemp(join(tmpdir(), "opencode-insights-plugin-"));
    cleanup.push(dir);
    const dbPath = join(dir, "insights.sqlite");

    await OpenCodeInsights({} as never, { dbPath, cliShim: false });

    expect(existsSync(dbPath) || existsSync(`${dbPath}.jsonl`)).toBe(true);
  });

  test("exposes request-context hooks by default", async () => {
    const dir = await mkdtemp(join(tmpdir(), "opencode-insights-plugin-"));
    cleanup.push(dir);
    const plugin = await OpenCodeInsights({} as never, { dbPath: join(dir, "insights.sqlite"), cliShim: false });

    expect(plugin).toHaveProperty("chat.headers");
    expect(plugin).toHaveProperty("experimental.chat.messages.transform");
    expect(plugin).toHaveProperty("experimental.chat.system.transform");
  });
});
