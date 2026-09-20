import { describe, expect, test } from "vitest";
import {
  addUniquePlugin,
  configureOpenCodeDebug,
  parseOptions,
  removePlugin,
  revertOpenCodeDebug,
  setSinglePluginSpec,
  stripJsonCommentsAndTrailingCommas,
  uninstallOpenCode
} from "../src/cli.js";
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
      expect(cli.plugins).toEqual(["@rejacky/opencode-insights@latest"]);
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
});
