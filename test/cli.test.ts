import { describe, expect, test } from "vitest";
import {
  addUniquePlugin,
  configureOpenCodeDebug,
  formatSessionSummary,
  parseOptions,
  removePlugin,
  stripJsonCommentsAndTrailingCommas,
  summarizeSessions,
  uninstallOpenCode,
  unsupportedFlagWarning
} from "../src/cli.js";
import type { HistorySession } from "../src/inspect.js";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

describe("cli helpers", () => {
  test("parses common command options", () => {
    expect(parseOptions(["--limit", "100", "--json", "--port", "9999", "-o", "/tmp/out.json"])).toEqual({
      dryRun: false,
      keepData: false,
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

  test("parses config directory dry-run options", () => {
    expect(parseOptions(["--config-dir", "/tmp/opencode", "--dry-run"])).toMatchObject({
      configDir: "/tmp/opencode",
      dryRun: true,
      keepData: false
    });
  });

  test("parses uninstall options", () => {
    expect(parseOptions(["--config-dir", "/tmp/opencode", "--keep-data", "--dry-run"])).toMatchObject({
      configDir: "/tmp/opencode",
      dryRun: true,
      keepData: true
    });
  });

  test("strips jsonc comments and trailing commas", () => {
    expect(JSON.parse(stripJsonCommentsAndTrailingCommas('{ "plugin": ["a",], // keep me parseable\n }'))).toEqual({
      plugin: ["a"]
    });
  });

  test("warns that removed storage flags are no longer supported", () => {
    expect(unsupportedFlagWarning("--db")).toBe("warning: --db is no longer supported; set dbPath in ~/.opencode-insights/config.jsonc");
    expect(unsupportedFlagWarning("--data-dir")).toBe("warning: --data-dir is no longer supported; the CLI reads the configured database path from ~/.opencode-insights/config.jsonc");
    expect(unsupportedFlagWarning("--retention-days")).toBe("warning: --retention-days is no longer supported; set retentionDays in ~/.opencode-insights/config.jsonc");
    expect(unsupportedFlagWarning("--limit")).toBeUndefined();
  });

  test("adds plugin entries once", () => {
    const config: Record<string, unknown> = { plugin: ["existing"] };
    expect(addUniquePlugin(config, "next")).toBe(true);
    expect(addUniquePlugin(config, "next")).toBe(false);
    expect(config.plugin).toEqual(["existing", "next"]);
  });

  test("removes string and tuple plugin entries", () => {
    const config: Record<string, unknown> = {
      plugin: ["existing", "@rejacky/opencode-insights", ["@rejacky/opencode-insights", { dbPath: "/tmp/db.sqlite" }]]
    };
    expect(removePlugin(config, "@rejacky/opencode-insights")).toBe(true);
    expect(config.plugin).toEqual(["existing"]);
    expect(removePlugin(config, "@rejacky/opencode-insights")).toBe(false);
  });

  test("uninstalls plugin config entries and local data files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "opencode-insights-test-"));
    const dataDir = await mkdtemp(join(tmpdir(), "opencode-insights-data-"));
    try {
      await writeFile(
        join(dir, "opencode.jsonc"),
        '{\n  // Preserve this comment during uninstall.\n  "plugin": ["existing", ["@rejacky/opencode-insights", { "dbPath": "/tmp/db.sqlite" }]]\n}\n',
        "utf8"
      );
      await writeFile(
        join(dir, "tui.json"),
        '{\n  // Preserve this TUI comment during uninstall.\n  "plugin": ["@rejacky/opencode-insights", "@rejacky/opencode-insights/tui", "other-tui"]\n}\n',
        "utf8"
      );
      await writeFile(join(dataDir, "insights.sqlite"), "sqlite", "utf8");
      await writeFile(join(dataDir, "insights.sqlite.jsonl"), "jsonl", "utf8");

      const output = await uninstallOpenCode({
        configDir: dir,
        dbPath: join(dataDir, "insights.sqlite"),
        limit: 20,
        limitProvided: false,
        json: false,
        dryRun: false,
        keepData: false
      });

      const opencodeText = await readFile(join(dir, "opencode.jsonc"), "utf8");
      const tuiText = await readFile(join(dir, "tui.json"), "utf8");
      const opencode = JSON.parse(stripJsonCommentsAndTrailingCommas(opencodeText)) as { plugin: string[] };
      const tui = JSON.parse(stripJsonCommentsAndTrailingCommas(tuiText)) as { plugin: string[] };
      expect(output).toContain("Uninstall cleanup complete");
      expect(opencodeText).toContain("Preserve this comment");
      expect(tuiText).toContain("Preserve this TUI comment");
      expect(opencode.plugin).toEqual(["existing"]);
      expect(tui.plugin).toEqual(["other-tui"]);
      await expect(readFile(join(dataDir, "insights.sqlite"), "utf8")).rejects.toThrow();
      await expect(readFile(join(dataDir, "insights.sqlite.jsonl"), "utf8")).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  test("uninstall dry run leaves files unchanged", async () => {
    const dir = await mkdtemp(join(tmpdir(), "opencode-insights-test-"));
    const dataDir = await mkdtemp(join(tmpdir(), "opencode-insights-data-"));
    try {
      await writeFile(join(dir, "opencode.json"), JSON.stringify({ plugin: ["@rejacky/opencode-insights"] }), "utf8");
      await writeFile(join(dir, "tui.json"), JSON.stringify({ plugin: ["@rejacky/opencode-insights"] }), "utf8");
      await writeFile(join(dataDir, "insights.sqlite"), "sqlite", "utf8");

      const output = await uninstallOpenCode({
        configDir: dir,
        dataDir,
        limit: 20,
        limitProvided: false,
        json: false,
        dryRun: true,
        keepData: false
      });

      expect(output).toContain("would remove");
      expect(output).toContain("Dry run: no files changed");
      expect(await readFile(join(dir, "opencode.json"), "utf8")).toContain("@rejacky/opencode-insights");
      expect(await readFile(join(dataDir, "insights.sqlite"), "utf8")).toBe("sqlite");
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  test("debug command points opencode and tui configs at local build output", async () => {
    const dir = await mkdtemp(join(tmpdir(), "opencode-insights-test-"));
    const projectDir = await mkdtemp(join(tmpdir(), "opencode-insights-project-"));
    const dataDir = await mkdtemp(join(tmpdir(), "opencode-insights-data-"));
    const originalCwd = process.cwd();
    try {
      await mkdir(join(projectDir, "dist"), { recursive: true });
      await writeFile(join(projectDir, "dist", "index.js"), "", "utf8");
      await writeFile(join(projectDir, "dist", "tui.js"), "", "utf8");
      await writeFile(
        join(dir, "opencode.jsonc"),
        '{\n  // Keep this comment when debug updates the plugin.\n  "name": "project",\n  "plugin": ["existing", "@rejacky/opencode-insights",],\n}\n',
        "utf8"
      );
      await writeFile(
        join(dir, "tui.json"),
        '{\n  // Keep this TUI comment too.\n  "plugin": ["@rejacky/opencode-insights/tui", "other-tui"]\n}\n',
        "utf8"
      );

      process.chdir(projectDir);
      const output = await configureOpenCodeDebug({
        configDir: dir,
        dataDir,
        limit: 20,
        limitProvided: false,
        json: false,
        dryRun: false,
        keepData: false
      });

      const localServerEntry = resolve("dist/index.js");
      const localTuiEntry = resolve("dist/tui.js");
      const opencodeText = await readFile(join(dir, "opencode.jsonc"), "utf8");
      const tuiText = await readFile(join(dir, "tui.json"), "utf8");
      const opencode = JSON.parse(stripJsonCommentsAndTrailingCommas(opencodeText)) as { plugin: unknown[] };
      const tui = JSON.parse(stripJsonCommentsAndTrailingCommas(tuiText)) as { plugin: string[] };
      expect(output).toContain(localServerEntry);
      expect(output).toContain(localTuiEntry);
      expect(opencodeText).toContain("Keep this comment");
      expect(tuiText).toContain("Keep this TUI comment");
      expect(opencode.plugin).toEqual(["existing", localServerEntry]);
      expect(tui.plugin).toEqual(["other-tui", localTuiEntry]);
      const configJsonc = await readFile(join(dataDir, "config.jsonc"), "utf8");
      expect(configJsonc).toContain('"retentionDays": 1');
      expect(configJsonc).toContain('// "dbPath"');
    } finally {
      process.chdir(originalCwd);
      await rm(dir, { recursive: true, force: true });
      await rm(projectDir, { recursive: true, force: true });
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  test("debug replaces a version-suffixed official spec without duplicating", async () => {
    const dir = await mkdtemp(join(tmpdir(), "opencode-insights-test-"));
    const projectDir = await mkdtemp(join(tmpdir(), "opencode-insights-project-"));
    const dataDir = await mkdtemp(join(tmpdir(), "opencode-insights-data-"));
    const originalCwd = process.cwd();
    try {
      await mkdir(join(projectDir, "dist"), { recursive: true });
      await writeFile(join(projectDir, "dist", "index.js"), "", "utf8");
      await writeFile(join(projectDir, "dist", "tui.js"), "", "utf8");
      await writeFile(
        join(dir, "opencode.jsonc"),
        '{\n  "plugin": ["existing", "@rejacky/opencode-insights@latest"]\n}\n',
        "utf8"
      );
      await writeFile(join(dir, "tui.json"), '{"plugin": ["@rejacky/opencode-insights@latest"]}\n', "utf8");

      process.chdir(projectDir);
      await configureOpenCodeDebug({
        configDir: dir,
        dataDir,
        limit: 20,
        limitProvided: false,
        json: false,
        dryRun: false,
        keepData: false
      });

      const localServerEntry = resolve("dist/index.js");
      const localTuiEntry = resolve("dist/tui.js");
      const opencode = JSON.parse(stripJsonCommentsAndTrailingCommas(await readFile(join(dir, "opencode.jsonc"), "utf8"))) as {
        plugin: unknown[];
      };
      const tui = JSON.parse(stripJsonCommentsAndTrailingCommas(await readFile(join(dir, "tui.json"), "utf8"))) as {
        plugin: unknown[];
      };
      expect(opencode.plugin).toEqual(["existing", localServerEntry]);
      expect(tui.plugin).toEqual([localTuiEntry]);
    } finally {
      process.chdir(originalCwd);
      await rm(dir, { recursive: true, force: true });
      await rm(projectDir, { recursive: true, force: true });
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  test("debug replaces npm:-prefixed and pinned official specs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "opencode-insights-test-"));
    const projectDir = await mkdtemp(join(tmpdir(), "opencode-insights-project-"));
    const dataDir = await mkdtemp(join(tmpdir(), "opencode-insights-data-"));
    const originalCwd = process.cwd();
    try {
      await mkdir(join(projectDir, "dist"), { recursive: true });
      await writeFile(join(projectDir, "dist", "index.js"), "", "utf8");
      await writeFile(join(projectDir, "dist", "tui.js"), "", "utf8");
      await writeFile(
        join(dir, "opencode.jsonc"),
        '{\n  "plugin": ["npm:@rejacky/opencode-insights", "@rejacky/opencode-insights@0.2.0"]\n}\n',
        "utf8"
      );
      await writeFile(join(dir, "tui.json"), '{"plugin": []}\n', "utf8");

      process.chdir(projectDir);
      await configureOpenCodeDebug({
        configDir: dir,
        dataDir,
        limit: 20,
        limitProvided: false,
        json: false,
        dryRun: false,
        keepData: false
      });

      const localServerEntry = resolve("dist/index.js");
      const opencode = JSON.parse(stripJsonCommentsAndTrailingCommas(await readFile(join(dir, "opencode.jsonc"), "utf8"))) as {
        plugin: unknown[];
      };
      expect(opencode.plugin).toEqual([localServerEntry]);
    } finally {
      process.chdir(originalCwd);
      await rm(dir, { recursive: true, force: true });
      await rm(projectDir, { recursive: true, force: true });
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  test("debug run twice keeps a single local build entry", async () => {
    const dir = await mkdtemp(join(tmpdir(), "opencode-insights-test-"));
    const projectDir = await mkdtemp(join(tmpdir(), "opencode-insights-project-"));
    const dataDir = await mkdtemp(join(tmpdir(), "opencode-insights-data-"));
    const originalCwd = process.cwd();
    try {
      await mkdir(join(projectDir, "dist"), { recursive: true });
      await writeFile(join(projectDir, "dist", "index.js"), "", "utf8");
      await writeFile(join(projectDir, "dist", "tui.js"), "", "utf8");
      await writeFile(join(dir, "opencode.jsonc"), '{\n  "plugin": []\n}\n', "utf8");
      await writeFile(join(dir, "tui.json"), '{"plugin": []}\n', "utf8");

      process.chdir(projectDir);
      const options = {
        configDir: dir,
        dataDir,
        limit: 20,
        limitProvided: false,
        json: false,
        dryRun: false,
        keepData: false
      };
      await configureOpenCodeDebug(options);
      await configureOpenCodeDebug(options);

      const localServerEntry = resolve("dist/index.js");
      const localTuiEntry = resolve("dist/tui.js");
      const opencode = JSON.parse(stripJsonCommentsAndTrailingCommas(await readFile(join(dir, "opencode.jsonc"), "utf8"))) as {
        plugin: unknown[];
      };
      const tui = JSON.parse(stripJsonCommentsAndTrailingCommas(await readFile(join(dir, "tui.json"), "utf8"))) as {
        plugin: unknown[];
      };
      expect(opencode.plugin).toEqual([localServerEntry]);
      expect(tui.plugin).toEqual([localTuiEntry]);
    } finally {
      process.chdir(originalCwd);
      await rm(dir, { recursive: true, force: true });
      await rm(projectDir, { recursive: true, force: true });
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  test("debug leaves an existing config.jsonc untouched", async () => {
    const dir = await mkdtemp(join(tmpdir(), "opencode-insights-test-"));
    const projectDir = await mkdtemp(join(tmpdir(), "opencode-insights-project-"));
    const dataDir = await mkdtemp(join(tmpdir(), "opencode-insights-data-"));
    const originalCwd = process.cwd();
    try {
      await mkdir(join(projectDir, "dist"), { recursive: true });
      await writeFile(join(projectDir, "dist", "index.js"), "", "utf8");
      await writeFile(join(projectDir, "dist", "tui.js"), "", "utf8");
      await writeFile(join(dataDir, "config.jsonc"), '{\n  "retentionDays": 7, // my setting\n}\n', "utf8");
      await writeFile(join(dir, "opencode.jsonc"), '{"plugin": []}\n', "utf8");
      await writeFile(join(dir, "tui.json"), '{"plugin": []}\n', "utf8");

      process.chdir(projectDir);
      const output = await configureOpenCodeDebug({
        configDir: dir,
        dataDir,
        limit: 20,
        limitProvided: false,
        json: false,
        dryRun: false,
        keepData: false
      });

      expect(output).toContain("Insights config:");
      await expect(readFile(join(dataDir, "config.jsonc"), "utf8")).resolves.toContain('"retentionDays": 7, // my setting');
    } finally {
      process.chdir(originalCwd);
      await rm(dir, { recursive: true, force: true });
      await rm(projectDir, { recursive: true, force: true });
      await rm(dataDir, { recursive: true, force: true });
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
