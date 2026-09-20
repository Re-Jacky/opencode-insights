import { describe, expect, test } from "vitest";
import {
  addUniquePlugin,
  configureOpenCodeDebug,
  formatSessionSummary,
  parseOptions,
  removePlugin,
  revertOpenCodeDebug,
  setSinglePluginSpec,
  stripJsonCommentsAndTrailingCommas,
  summarizeSessions,
  uninstallOpenCode,
  unsupportedFlagWarning
} from "../src/cli.js";
import type { HistorySession } from "../src/inspect.js";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const options = (configDir: string, extra: Record<string, unknown> = {}) => ({
  configDir,
  limit: 20,
  limitProvided: false,
  json: false,
  dryRun: false,
  keepData: true,
  ...extra
});

describe("CLI v2 configuration", () => {
  test("uses plugins for unique string entries", () => {
    const config: Record<string, unknown> = { plugins: ["existing"] };
    expect(addUniquePlugin(config, "next")).toBe(true);
    expect(addUniquePlugin(config, "next")).toBe(false);
    expect(config.plugins).toEqual(["existing", "next"]);
    expect(config.plugin).toBeUndefined();
  });

  test("removes string and v2 object entries", () => {
    const config: Record<string, unknown> = {
      plugins: [
        "existing",
        "@rejacky/opencode-insights",
        { package: "@rejacky/opencode-insights", options: { dbPath: "/tmp/db.sqlite" } }
      ]
    };
    expect(removePlugin(config, "@rejacky/opencode-insights")).toBe(true);
    expect(config.plugins).toEqual(["existing"]);
    expect(removePlugin(config, "@rejacky/opencode-insights")).toBe(false);
  });

  test("removes every recognized Insights package form without unrelated plugins", async () => {
    const dir = await mkdtemp(join(tmpdir(), "opencode-insights-test-"));
    try {
      await writeFile(
        join(dir, "opencode.json"),
        JSON.stringify({
          plugins: [
            "keep",
            "@rejacky/opencode-insights@1.2.3",
            "npm:@rejacky/opencode-insights",
            "/tmp/opencode-insights/dist/index.js",
            "/tmp/cache/opencode-insights-0.4.1.tgz",
            { package: "@rejacky/opencode-insights/tui", options: { enabled: true } },
            { package: "other-plugin", options: {} }
          ]
        }),
        "utf8"
      );
      await uninstallOpenCode(options(dir));
      const config = JSON.parse(await readFile(join(dir, "opencode.json"), "utf8")) as { plugins: unknown[] };
      expect(config.plugins).toEqual(["keep", { package: "other-plugin", options: {} }]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("replaces existing Insights entries without mutating v1 plugin", () => {
    const config: Record<string, unknown> = {
      plugin: ["legacy"],
      plugins: [
        "existing",
        "@rejacky/opencode-insights@latest",
        { package: "@rejacky/opencode-insights", options: { old: true } }
      ]
    };
    setSinglePluginSpec(config, { package: "/tmp/dist/index.js", options: { debug: true } });
    expect(config.plugin).toEqual(["legacy"]);
    expect(config.plugins).toEqual(["existing", { package: "/tmp/dist/index.js", options: { debug: true } }]);
  });

  test("keeps JSONC comments and does not treat v1 plugin as supported", async () => {
    const dir = await mkdtemp(join(tmpdir(), "opencode-insights-test-"));
    try {
      const source = '{\n  // Preserve this comment.\n  "plugin": ["legacy"],\n  "plugins": ["@rejacky/opencode-insights"]\n}\n';
      await writeFile(join(dir, "opencode.jsonc"), source, "utf8");
      await uninstallOpenCode(options(dir));
      const text = await readFile(join(dir, "opencode.jsonc"), "utf8");
      expect(text).toContain("Preserve this comment");
      const config = JSON.parse(stripJsonCommentsAndTrailingCommas(text)) as { plugin: string[]; plugins: unknown[] };
      expect(config.plugin).toEqual(["legacy"]);
      expect(config.plugins).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("debug writes the combined package to main config only", async () => {
    const dir = await mkdtemp(join(tmpdir(), "opencode-insights-test-"));
    const projectDir = await mkdtemp(join(tmpdir(), "opencode-insights-project-"));
    const dataDir = await mkdtemp(join(tmpdir(), "opencode-insights-data-"));
    const originalCwd = process.cwd();
    try {
      await mkdir(join(projectDir, "dist"), { recursive: true });
      await writeFile(join(projectDir, "dist", "index.js"), "", "utf8");
      await writeFile(join(projectDir, "dist", "tui.js"), "", "utf8");
      await writeFile(join(dir, "opencode.jsonc"), '{\n  // Preserve main config.\n  "name": "project",\n  "plugins": ["existing"]\n}\n', "utf8");
      await writeFile(join(dir, "cli.json"), '{"plugins": ["cli-only"]}\n', "utf8");
      process.chdir(projectDir);
      const output = await configureOpenCodeDebug(options(dir, { dataDir, keepData: false }));
      const localEntry = resolve("dist/index.js");
      const config = JSON.parse(stripJsonCommentsAndTrailingCommas(await readFile(join(dir, "opencode.jsonc"), "utf8"))) as { plugins: unknown[] };
      const cli = JSON.parse(await readFile(join(dir, "cli.json"), "utf8")) as { plugins: unknown[] };
      expect(output).toContain(localEntry);
      expect(config.plugins).toEqual(["existing", localEntry]);
      expect(cli.plugins).toEqual(["cli-only"]);
      await expect(readFile(join(dir, "tui.json"), "utf8")).rejects.toThrow();
    } finally {
      process.chdir(originalCwd);
      await rm(dir, { recursive: true, force: true });
      await rm(projectDir, { recursive: true, force: true });
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  test("uninstall removes the package from main, CLI, and legacy TUI configs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "opencode-insights-test-"));
    try {
      await writeFile(join(dir, "opencode.json"), '{"plugins": ["existing", {"package": "@rejacky/opencode-insights", "options": {}}]}\n', "utf8");
      await writeFile(join(dir, "cli.jsonc"), '{\n  // CLI comment\n  "plugins": ["@rejacky/opencode-insights", "other-cli"]\n}\n', "utf8");
      await writeFile(join(dir, "tui.json"), '{"plugins": ["@rejacky/opencode-insights/tui", "other-tui"]}\n', "utf8");
      const output = await uninstallOpenCode(options(dir));
      const main = JSON.parse(await readFile(join(dir, "opencode.json"), "utf8")) as { plugins: unknown[] };
      const cliText = await readFile(join(dir, "cli.jsonc"), "utf8");
      const cli = JSON.parse(stripJsonCommentsAndTrailingCommas(cliText)) as { plugins: unknown[] };
      const tui = JSON.parse(await readFile(join(dir, "tui.json"), "utf8")) as { plugins: unknown[] };
      expect(output).toContain("Uninstall cleanup complete");
      expect(main.plugins).toEqual(["existing"]);
      expect(cli.plugins).toEqual(["other-cli"]);
      expect(tui.plugins).toEqual(["other-tui"]);
      expect(cliText).toContain("CLI comment");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("revert changes local build entries in main config and CLI cleanup config", async () => {
    const dir = await mkdtemp(join(tmpdir(), "opencode-insights-test-"));
    try {
      await writeFile(join(dir, "opencode.jsonc"), '{\n  // Main comment\n  "plugins": ["existing", "/Users/me/opencode-insights/dist/index.js"]\n}\n', "utf8");
      await writeFile(join(dir, "cli.json"), '{"plugins": ["/Users/me/opencode-insights/dist/tui.js"]}\n', "utf8");
      const output = await revertOpenCodeDebug(options(dir, { keepData: false }));
      const main = JSON.parse(stripJsonCommentsAndTrailingCommas(await readFile(join(dir, "opencode.jsonc"), "utf8"))) as { plugins: unknown[] };
      const cli = JSON.parse(await readFile(join(dir, "cli.json"), "utf8")) as { plugins: unknown[] };
      expect(output).toContain("Reverted to the official package");
      expect(main.plugins).toEqual(["existing", "@rejacky/opencode-insights@latest"]);
      expect(cli.plugins).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("revert reports cleanup when only CLI stale entries are removed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "opencode-insights-test-"));
    try {
      await writeFile(join(dir, "opencode.json"), '{"plugins": ["existing"]}\n', "utf8");
      await writeFile(join(dir, "cli.json"), '{"plugins": ["@rejacky/opencode-insights@0.4.1", "other-cli"]}\n', "utf8");

      const output = await revertOpenCodeDebug(options(dir));

      expect(output).toContain("Reverted to the official package");
      expect(output).toContain("CLI plugin: removed stale Insights entries");
      const cli = JSON.parse(await readFile(join(dir, "cli.json"), "utf8")) as { plugins: unknown[] };
      expect(cli.plugins).toEqual(["other-cli"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("parses common command options", () => {
    expect(parseOptions(["--limit", "100", "--json", "--port", "9999", "-o", "/tmp/out.json"])).toMatchObject({
      limit: 100,
      limitProvided: true,
      json: true,
      port: 9999,
      output: "/tmp/out.json"
    });
  });

  test("revert leaves missing configs alone and reports missing local output", async () => {
    const dir = await mkdtemp(join(tmpdir(), "opencode-insights-test-"));
    try {
      const source = '{"plugins": ["existing", "@rejacky/opencode-insights@latest"]}\n';
      await writeFile(join(dir, "opencode.json"), source, "utf8");
      const output = await revertOpenCodeDebug(options(dir));
      expect(output).toContain("not present (local build output)");
      expect(await readFile(join(dir, "opencode.json"), "utf8")).toBe(source);
      expect(output).toContain("CLI plugin: config not found");
      expect(output).toContain("Legacy TUI plugin: config not found");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("debug is repeatable and replaces versioned and npm-prefixed entries", async () => {
    const dir = await mkdtemp(join(tmpdir(), "opencode-insights-test-"));
    const projectDir = await mkdtemp(join(tmpdir(), "opencode-insights-project-"));
    const originalCwd = process.cwd();
    try {
      await mkdir(join(projectDir, "dist"), { recursive: true });
      await writeFile(join(projectDir, "dist", "index.js"), "", "utf8");
      await writeFile(join(projectDir, "dist", "tui.js"), "", "utf8");
      await writeFile(join(dir, "opencode.json"), '{"plugins": ["npm:@rejacky/opencode-insights", "@rejacky/opencode-insights@0.2.0"]}\n', "utf8");
      process.chdir(projectDir);
      await configureOpenCodeDebug(options(dir));
      await configureOpenCodeDebug(options(dir));
      const localEntry = resolve("dist/index.js");
      const config = JSON.parse(await readFile(join(dir, "opencode.json"), "utf8")) as { plugins: unknown[] };
      expect(config.plugins).toEqual([localEntry]);
    } finally {
      process.chdir(originalCwd);
      await rm(dir, { recursive: true, force: true });
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  test("dry-run debug and uninstall do not write configuration", async () => {
    const dir = await mkdtemp(join(tmpdir(), "opencode-insights-test-"));
    const projectDir = await mkdtemp(join(tmpdir(), "opencode-insights-project-"));
    const originalCwd = process.cwd();
    try {
      await mkdir(join(projectDir, "dist"), { recursive: true });
      await writeFile(join(projectDir, "dist", "index.js"), "", "utf8");
      await writeFile(join(projectDir, "dist", "tui.js"), "", "utf8");
      const source = '{"plugins": ["/tmp/opencode-insights/dist/index.js"]}\n';
      await writeFile(join(dir, "opencode.json"), source, "utf8");
      process.chdir(projectDir);
      const debugOutput = await configureOpenCodeDebug(options(dir, { dryRun: true }));
      expect(debugOutput).toContain("Dry run: no files written");
      expect(await readFile(join(dir, "opencode.json"), "utf8")).toBe(source);
      const uninstallOutput = await uninstallOpenCode(options(dir, { dryRun: true }));
      expect(uninstallOutput).toContain("would remove");
      expect(await readFile(join(dir, "opencode.json"), "utf8")).toBe(source);
    } finally {
      process.chdir(originalCwd);
      await rm(dir, { recursive: true, force: true });
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  test("preserves option warnings and session summary behavior", () => {
    expect(parseOptions(["--limit", "nope", "--port", "0"])).toMatchObject({ limit: 20, limitProvided: true, port: 8765 });
    expect(parseOptions(["--config-dir", "/tmp/opencode", "--dry-run", "--keep-data"])).toMatchObject({ configDir: "/tmp/opencode", dryRun: true, keepData: true });
    expect(unsupportedFlagWarning("--db")).toContain("dbPath");
    expect(unsupportedFlagWarning("--data-dir")).toContain("no longer supported");
    expect(unsupportedFlagWarning("--limit")).toBeUndefined();
    const rows = summarizeSessions([
      {
        id: "ses_1",
        title: "Greeting",
        updatedAt: 1_700_000_000_000,
        messages: [{ id: "msg_1", sessionID: "ses_1", role: "user", text: "Hi", requests: [], response: undefined }],
        requests: []
      }
    ] satisfies HistorySession[]);
    expect(formatSessionSummary(rows)).toContain("Greeting");
    expect(formatSessionSummary(rows)).toContain("ses_1");
  });
});
