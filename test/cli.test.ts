import { describe, expect, test } from "vitest";
import {
  addUniquePlugin,
  configureOpenCode,
  formatSessionSummary,
  parseOptions,
  stripJsonCommentsAndTrailingCommas,
  summarizeSessions
} from "../src/cli.js";
import type { HistorySession } from "../src/inspect.js";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("cli helpers", () => {
  test("parses common command options", () => {
    expect(parseOptions(["--db", "/tmp/insights.sqlite", "--limit", "100", "--json", "--port", "9999", "-o", "/tmp/out.json"])).toEqual({
      dbPath: "/tmp/insights.sqlite",
      dryRun: false,
      limit: 100,
      limitProvided: true,
      json: true,
      port: 9999,
      output: "/tmp/out.json"
    });
  });

  test("falls back to safe defaults for invalid numeric options", () => {
    expect(parseOptions(["--limit", "nope", "--port", "0"])).toMatchObject({
      limit: 20,
      limitProvided: true,
      json: false,
      dryRun: false,
      port: 8765
    });
  });

  test("parses configure options", () => {
    expect(parseOptions(["--config-dir", "/tmp/opencode", "--dry-run"])).toMatchObject({
      configDir: "/tmp/opencode",
      dryRun: true
    });
  });

  test("strips jsonc comments and trailing commas", () => {
    expect(JSON.parse(stripJsonCommentsAndTrailingCommas('{ "plugin": ["a",], // keep me parseable\n }'))).toEqual({
      plugin: ["a"]
    });
  });

  test("adds plugin entries once", () => {
    const config: Record<string, unknown> = { plugin: ["existing"] };
    expect(addUniquePlugin(config, "next")).toBe(true);
    expect(addUniquePlugin(config, "next")).toBe(false);
    expect(config.plugin).toEqual(["existing", "next"]);
  });

  test("configures opencode and tui plugin files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "opencode-insights-test-"));
    try {
      await writeFile(join(dir, "opencode.jsonc"), '{\n  // existing settings\n  "plugin": ["existing"],\n}\n', "utf8");

      const output = await configureOpenCode({
        configDir: dir,
        limit: 20,
        limitProvided: false,
        json: false,
        dryRun: false
      });

      const opencode = JSON.parse(await readFile(join(dir, "opencode.jsonc"), "utf8")) as { plugin: string[] };
      const tui = JSON.parse(await readFile(join(dir, "tui.json"), "utf8")) as { plugin: string[] };
      expect(output).toContain("Configuration written");
      expect(opencode.plugin).toEqual(["existing", "@rejacky/opencode-insights"]);
      expect(tui.plugin).toEqual(["@rejacky/opencode-insights/tui"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("uses tui json because OpenCode does not load tui jsonc", async () => {
    const dir = await mkdtemp(join(tmpdir(), "opencode-insights-test-"));
    try {
      await writeFile(join(dir, "tui.jsonc"), '{\n  // keep comments parseable\n  "plugin": ["existing-tui"],\n}\n', "utf8");

      await configureOpenCode({
        configDir: dir,
        limit: 20,
        limitProvided: false,
        json: false,
        dryRun: false
      });

      const tui = JSON.parse(await readFile(join(dir, "tui.json"), "utf8")) as { plugin: string[] };
      const jsonc = await readFile(join(dir, "tui.jsonc"), "utf8");
      expect(tui.plugin).toEqual(["@rejacky/opencode-insights/tui"]);
      expect(jsonc).toContain("existing-tui");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("summarizes reconstructed sessions for terminal output", () => {
    const rows = summarizeSessions([
      {
        id: "ses_1",
        title: "Greeting",
        updatedAt: 1_700_000_000_000,
        messages: [
          {
            id: "msg_1",
            sessionID: "ses_1",
            role: "user",
            text: "Hi",
            requests: [],
            response: {
              id: "msg_2",
              sessionID: "ses_1",
              role: "assistant",
              text: "Hello",
              reasoning: "",
              events: []
            }
          }
        ],
        requests: [
          {
            id: "req_1",
            sessionID: "ses_1",
            messageID: "msg_1",
            timestamp: 1_700_000_000_100,
            purpose: "Generate the assistant response for the user message.",
            summary: "Hi",
            payload: {}
          }
        ]
      } satisfies HistorySession
    ]);

    expect(rows).toEqual([
      {
        id: "ses_1",
        title: "Greeting",
        updatedAt: 1_700_000_000_000,
        messages: 1,
        hooks: 1,
        responses: 1
      }
    ]);
    expect(formatSessionSummary(rows)).toContain("Greeting");
    expect(formatSessionSummary(rows)).toContain("ses_1");
  });
});
