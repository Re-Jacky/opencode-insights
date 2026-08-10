# Storage Config in config.jsonc Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move `dbPath`/`retentionDays` storage settings from opencode.json plugin params into `~/.opencode-insights/config.jsonc`, making the config file the single source of truth, with a commented-out `dbPath` template and `retentionDays: 1` written on first run.

**Architecture:** `readInsightsConfig` in src/capture.ts gains storage keys (`dbPath`, `retentionDays`), switches to `config.jsonc` (jsonc-parser), falls back to legacy `config.json`, and writes a commented template on first run. The plugin and CLI build store options from the config via a new `insightsOptionsFromConfig` helper; CLI `--db`/`--data-dir`/`--retention-days` flags are removed; `debug` writes the config template instead of plugin params.

**Tech Stack:** TypeScript (NodeNext ESM), vitest, jsonc-parser (existing dep), better-sqlite3/bun:sqlite fallback, @opencode-ai/plugin.

**Spec:** `docs/superpowers/specs/2026-08-10-storage-config-jsonc-design.md`

## Global Constraints

- NodeNext ESM: all relative imports need explicit `.js` extensions.
- Tests import from `src/` directly, never from `dist/`.
- `exactOptionalPropertyTypes` is on: optional fields are `T | undefined`, and records must be built with `compactUndefined()` to strip `undefined` keys.
- `readInsightsConfig` is best-effort: parse/read/write failures fall back to defaults, never throw.
- Config resolution order: `config.jsonc` → legacy `config.json` → write default `config.jsonc` + return defaults.
- `dbPath` absent → default `~/.opencode-insights/insights.sqlite`. `retentionDays` absent → `1`; `0` disables cleaning.
- Release gate: `npm run verify` (`typecheck && test && build`) must pass.

---

### Task 1: capture.ts — jsonc config with storage keys

**Files:**
- Modify: `src/capture.ts` (imports ~1-5; types ~34-55; config section ~129-201)
- Test: `test/capture.test.ts`

**Interfaces:**
- Consumes: `DEFAULT_PROMPT_RIGHT_METRICS` (src/metrics.js, already imported), `resolveRetentionDays` (same file).
- Produces:
  - `InsightsConfig = { promptRightMetrics: PromptRightMetric[]; goUsage: GoUsageConfig; dbPath?: string | undefined; retentionDays?: number | undefined }`
  - `resolveInsightsConfigPath(options?): string` — now `join(dataDir, "config.jsonc")`
  - `resolveLegacyInsightsConfigPath(options?): string` — `join(dataDir, "config.json")`
  - `insightsOptionsFromConfig(config: InsightsConfig, dataDir?: string): InsightsOptions`
  - `readInsightsConfig(options?): Promise<InsightsConfig>` — 3-step resolution, jsonc parsing
  - `createCaptureStore` / `resolveCapturePath` / `resolveRetentionDays` — unchanged signatures

- [ ] **Step 1: Update and extend the failing tests in `test/capture.test.ts`**

Replace the test at `test/capture.test.ts:30-39` and add the new tests after the import block section (keep existing go-usage tests untouched):

```ts
  test("creates a default jsonc config beside the capture database", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "opencode-insights-config-"));
    cleanup.push(dataDir);

    await expect(readInsightsConfig({ dataDir })).resolves.toEqual({
      promptRightMetrics: ["tps", "avg", "used", "cache"],
      goUsage: { enabled: false, cookie: "", workspaceID: "", refreshMs: 300_000 }
    });
    const jsonc = await readFile(resolveInsightsConfigPath({ dataDir }), "utf8");
    expect(jsonc).toContain('"promptRightMetrics"');
    expect(jsonc).toContain('"retentionDays": 1');
    expect(jsonc).toContain('// "dbPath"');
    expect(jsonc.match(/^\s*"dbPath"/m)).toBeNull();
    await expect(readFile(resolveLegacyInsightsConfigPath({ dataDir }), "utf8")).rejects.toThrow();
  });

  test("parses dbPath and retentionDays from jsonc config", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "opencode-insights-config-"));
    cleanup.push(dataDir);
    await writeFile(
      resolveInsightsConfigPath({ dataDir }),
      '{\n  "dbPath": "/tmp/custom.sqlite",\n  "retentionDays": 0\n}\n'
    );

    await expect(readInsightsConfig({ dataDir })).resolves.toEqual({
      promptRightMetrics: ["tps", "avg", "used", "cache"],
      goUsage: { enabled: false, cookie: "", workspaceID: "", refreshMs: 300_000 },
      dbPath: "/tmp/custom.sqlite",
      retentionDays: 0
    });
  });

  test("allows comments and trailing commas in the jsonc config", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "opencode-insights-config-"));
    cleanup.push(dataDir);
    await writeFile(
      resolveInsightsConfigPath({ dataDir }),
      '{\n  // "dbPath": "/commented/out.sqlite",\n  "retentionDays": 3, // keep three days\n}\n'
    );

    await expect(readInsightsConfig({ dataDir })).resolves.toMatchObject({ retentionDays: 3 });
  });

  test("falls back to the legacy config.json when config.jsonc is absent", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "opencode-insights-config-"));
    cleanup.push(dataDir);
    await writeFile(
      resolveLegacyInsightsConfigPath({ dataDir }),
      JSON.stringify({ promptRightMetrics: ["used"], retentionDays: 7 })
    );

    await expect(readInsightsConfig({ dataDir })).resolves.toEqual({
      promptRightMetrics: ["used"],
      goUsage: { enabled: false, cookie: "", workspaceID: "", refreshMs: 300_000 },
      retentionDays: 7
    });
  });

  test("prefers config.jsonc over a legacy config.json", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "opencode-insights-config-"));
    cleanup.push(dataDir);
    await writeFile(resolveInsightsConfigPath({ dataDir }), JSON.stringify({ promptRightMetrics: ["cache"] }));
    await writeFile(resolveLegacyInsightsConfigPath({ dataDir }), JSON.stringify({ promptRightMetrics: ["used"] }));

    await expect(readInsightsConfig({ dataDir })).resolves.toMatchObject({ promptRightMetrics: ["cache"] });
  });
```

Also add `resolveLegacyInsightsConfigPath` to the import list at `test/capture.test.ts:5-17`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- capture.test.ts`
Expected: FAIL — "creates a default jsonc config..." (writes `config.json`, no `config.jsonc`; `retentionDays`/`dbPath` missing), "parses dbPath and retentionDays..." (undefined), "allows comments..." (JSON.parse throws on comments), "falls back to legacy..." (no legacy resolution), "prefers jsonc..." (legacy not consulted).

- [ ] **Step 3: Implement in `src/capture.ts`**

Add the jsonc-parser import:

```ts
import { parse, type ParseError } from "jsonc-parser";
```

Extend the config types (keep `InsightsOptions` as-is):

```ts
export type InsightsConfig = {
  promptRightMetrics: PromptRightMetric[];
  goUsage: GoUsageConfig;
  dbPath?: string | undefined;
  retentionDays?: number | undefined;
};
```

Replace the config-path and read functions (currently `resolveInsightsConfigPath` at `src/capture.ts:145` and `readInsightsConfig` at `src/capture.ts:149`) with:

```ts
export function resolveInsightsConfigPath(options: InsightsOptions = {}) {
  return join(resolveConfigDataDir(options), "config.jsonc");
}

export function resolveLegacyInsightsConfigPath(options: InsightsOptions = {}) {
  return join(resolveConfigDataDir(options), "config.json");
}

function resolveConfigDataDir(options: InsightsOptions = {}) {
  return typeof options.dataDir === "string" && options.dataDir.length > 0
    ? options.dataDir
    : defaultDataDir();
}

export async function readInsightsConfig(options: InsightsOptions = {}): Promise<InsightsConfig> {
  const jsoncPath = resolveInsightsConfigPath(options);
  if (existsSync(jsoncPath)) {
    return parseInsightsConfigFile(jsoncPath);
  }

  const legacyPath = resolveLegacyInsightsConfigPath(options);
  if (existsSync(legacyPath)) {
    return parseInsightsConfigFile(legacyPath);
  }

  try {
    await mkdir(dirname(jsoncPath), { recursive: true });
    await writeFile(jsoncPath, defaultInsightsConfigJsonc(), "utf8");
  } catch {
    // First-run setup is best-effort; defaults still apply.
  }
  return defaultInsightsConfig();
}

async function parseInsightsConfigFile(path: string): Promise<InsightsConfig> {
  try {
    const parseErrors: ParseError[] = [];
    const parsed = parse(await readFile(path, "utf8"), parseErrors, { allowTrailingComma: true }) as unknown;
    if (parseErrors.length > 0) return defaultInsightsConfig();
    return insightsConfigFrom(parsed);
  } catch {
    return defaultInsightsConfig();
  }
}

function defaultInsightsConfigJsonc(): string {
  return [
    "{",
    "  // Database file. Default: ~/.opencode-insights/insights.sqlite",
    '  // "dbPath": "/absolute/path/to/insights.sqlite",',
    '  "retentionDays": 1,',
    `  "promptRightMetrics": ${JSON.stringify(DEFAULT_PROMPT_RIGHT_METRICS)},`,
    `  "goUsage": ${JSON.stringify(defaultGoUsageConfig())}`,
    "}",
    ""
  ].join("\n");
}

export function insightsOptionsFromConfig(config: InsightsConfig, dataDir?: string): InsightsOptions {
  return compactUndefined({ dataDir, dbPath: config.dbPath, retentionDays: config.retentionDays });
}
```

Update `insightsConfigFrom` (currently `src/capture.ts:175`) to parse the new keys:

```ts
function insightsConfigFrom(value: unknown): InsightsConfig {
  const record = isRecord(value) ? value : {};
  const metrics = Array.isArray(record.promptRightMetrics)
    ? record.promptRightMetrics.filter(isPromptRightMetric)
    : [];
  const dbPath =
    typeof record.dbPath === "string" && record.dbPath.trim().length > 0 ? record.dbPath : undefined;
  const rawRetention = record.retentionDays;
  const retentionDays =
    rawRetention === undefined || rawRetention === null || rawRetention === ""
      ? undefined
      : resolveRetentionDays(rawRetention);
  return {
    promptRightMetrics: metrics.length ? metrics : [...DEFAULT_PROMPT_RIGHT_METRICS],
    goUsage: goUsageConfigFrom(record.goUsage),
    dbPath,
    retentionDays
  };
}
```

Note: `compactUndefined` and `defaultGoUsageConfig` already exist in the file; `defaultInsightsConfig` is unchanged.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- capture.test.ts`
Expected: PASS (all tests including the pre-existing go-usage/retention ones).

- [ ] **Step 5: Run typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/capture.ts test/capture.test.ts
git commit -m "feat: read storage config from config.jsonc"
```

---

### Task 2: index.ts — plugin reads config, drops storage params

**Files:**
- Modify: `src/index.ts` (options type ~16-18, startup ~20-31)
- Test: `test/plugin.test.ts`

**Interfaces:**
- Consumes: `readInsightsConfig`, `insightsOptionsFromConfig` (Task 1).
- Produces: `OpenCodeInsightsOptions = { cliShim?: boolean | undefined; dataDir?: string | undefined }` — the plugin's only accepted params.

- [ ] **Step 1: Update the failing tests in `test/plugin.test.ts`**

Replace the whole file body's two tests and add a third:

```ts
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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

    await OpenCodeInsights({} as never, { dataDir: dir, cliShim: false });

    expect(existsSync(join(dir, "insights.sqlite")) || existsSync(join(dir, "insights.sqlite.jsonl"))).toBe(true);
  });

  test("exposes request-context hooks by default", async () => {
    const dir = await mkdtemp(join(tmpdir(), "opencode-insights-plugin-"));
    cleanup.push(dir);
    const plugin = await OpenCodeInsights({} as never, { dataDir: dir, cliShim: false });

    expect(plugin).toHaveProperty("chat.headers");
    expect(plugin).toHaveProperty("experimental.chat.messages.transform");
    expect(plugin).toHaveProperty("experimental.chat.system.transform");
  });

  test("stores at the dbPath configured in config.jsonc", async () => {
    const dir = await mkdtemp(join(tmpdir(), "opencode-insights-plugin-"));
    cleanup.push(dir);
    const dbPath = join(dir, "custom.sqlite");
    await writeFile(join(dir, "config.jsonc"), JSON.stringify({ dbPath }), "utf8");

    await OpenCodeInsights({} as never, { dataDir: dir, cliShim: false });

    expect(existsSync(dbPath) || existsSync(`${dbPath}.jsonl`)).toBe(true);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- plugin.test.ts`
Expected: FAIL — "stores at the dbPath configured in config.jsonc" (plugin ignores config; `dbPath` is not part of the options type, so the first two tests also fail typecheck).

- [ ] **Step 3: Implement in `src/index.ts`**

Replace the options type and the startup block:

```ts
type OpenCodeInsightsOptions = {
  cliShim?: boolean | undefined;
  dataDir?: string | undefined;
};

export const OpenCodeInsights: Plugin = async (_input, options?: OpenCodeInsightsOptions) => {
  if (options?.cliShim !== false) {
    void ensureCliShim().catch(() => undefined);
  }

  const config = await readInsightsConfig(options);
  const store = createCaptureStore(insightsOptionsFromConfig(config, options?.dataDir));
  ...
```

Update the import list on `src/index.ts:3-13` to add `insightsOptionsFromConfig` and `readInsightsConfig` (and keep `createCaptureStore` and the rest). Remove nothing else.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- plugin.test.ts`
Expected: PASS.

- [ ] **Step 5: Run typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/index.ts test/plugin.test.ts
git commit -m "feat: plugin reads storage settings from config.jsonc"
```

---

### Task 3: cli.ts — drop storage flags, config-driven dbPath, debug writes config

**Files:**
- Modify: `src/cli.ts` (imports ~10; CliOptions ~21-34; parseOptions ~130-178; main ~36-128; configureOpenCodeDebug ~321-359; debugServerOptions ~440-444; usage ~553-568)
- Test: `test/cli.test.ts`

**Interfaces:**
- Consumes: `readInsightsConfig`, `resolveInsightsConfigPath` (Task 1).
- Produces: `CliOptions` without `retentionDays`; `dbPath`/`dataDir` remain as internal optional fields (never set by flags).

- [ ] **Step 1: Update the failing tests in `test/cli.test.ts`**

Update the import list (add `readInsightsConfig`, `resolveInsightsConfigPath` from `../src/capture.js`) and make these changes:

Test at `test/cli.test.ts:18-30` — drop the storage flags:

```ts
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
```

Test at `test/cli.test.ts:50-57` — drop `--data-dir`:

```ts
  test("parses uninstall options", () => {
    expect(parseOptions(["--config-dir", "/tmp/opencode", "--keep-data", "--dry-run"])).toMatchObject({
      configDir: "/tmp/opencode",
      dryRun: true,
      keepData: true
    });
  });
```

Uninstall test at `test/cli.test.ts:98-106` — pass `dbPath` instead of `dataDir`:

```ts
      const output = await uninstallOpenCode({
        configDir: dir,
        dbPath: join(dataDir, "insights.sqlite"),
        limit: 20,
        limitProvided: false,
        json: false,
        dryRun: false,
        keepData: false
      });
```

(The `dataDir` variable at `test/cli.test.ts:83` is still used for the data files it writes.)

Debug test at `test/cli.test.ts:153-200` — replace the call, expected plugin entry, and add config.jsonc assertions:

```ts
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- cli.test.ts`
Expected: FAIL — "parses common command options" (dbPath/retentionDays no longer stripped), "parses uninstall options" (dataDir not parsed), debug tests (params block written into opencode.json, no config.jsonc).

- [ ] **Step 3: Implement in `src/cli.ts`**

Update the import line at `src/cli.ts:10`:

```ts
import { readInsightsConfig, resolveCapturePath, resolveInsightsConfigPath } from "./capture.js";
```

Remove `retentionDays` from `CliOptions` (keep `dbPath`/`dataDir` as internal fields, now with their doc role changed to "internal — set from config or tests"):

```ts
type CliOptions = {
  dbPath?: string | undefined;
  dataDir?: string | undefined;
  limit: number;
  limitProvided: boolean;
  json: boolean;
  host?: string | undefined;
  port?: number | undefined;
  output?: string | undefined;
  configDir?: string | undefined;
  dryRun: boolean;
  keepData: boolean;
};
```

In `main` (`src/cli.ts:36-39`), thread the configured dbPath after parsing:

```ts
async function main(argv: string[]) {
  const command = argv[2] ?? "recent";
  const options = parseOptions(argv.slice(3));
  const positionals = parsePositionals(argv.slice(3));
  const config = await readInsightsConfig();
  options.dbPath = config.dbPath;
```

In `parseOptions`, remove the three flag branches and the retention validation block:

```ts
    } else if (arg === "--limit") {
      options.limit = Number.parseInt(args[index + 1] ?? "20", 10);
      options.limitProvided = true;
      index += 1;
    } else if (arg === "--host") {
```

(Delete the `--db`, `--data-dir`, `--retention-days` branches and the trailing `if (options.retentionDays !== undefined && ...)` block at `src/cli.ts:174-176`.)

In `configureOpenCodeDebug` (`src/cli.ts:321-359`):

- Replace `setSinglePluginSpec(opencodeConfig, SERVER_PLUGIN_SPEC, [localServerEntry, debugServerOptions(options)], localServerEntry)` with:

```ts
  setSinglePluginSpec(opencodeConfig, SERVER_PLUGIN_SPEC, localServerEntry);
```

- Add the config path to the output lines after the `Local TUI plugin` line:

```ts
    `Insights config: ${resolveInsightsConfigPath({ dataDir: options.dataDir })}`
```

- After the `if (options.dryRun)` block and before writing the opencode/tui configs, ensure the config.jsonc template exists (no-op when already present):

```ts
  await readInsightsConfig({ dataDir: options.dataDir });
```

Delete `debugServerOptions` (`src/cli.ts:440-444`).

Update `usage()` (`src/cli.ts:553-568`) — remove `[--retention-days DAYS]` from the debug line and `[--db PATH] [--data-dir DIR]` from every other line:

```ts
function usage() {
  return [
    "Usage:",
    "  opencode-insights debug [--config-dir DIR] [--dry-run]",
    "  opencode-insights uninstall [--config-dir DIR] [--keep-data] [--dry-run]",
    "  opencode-insights recent [--limit N] [--json]",
    "  opencode-insights sessions [--limit N] [--json]",
    "  opencode-insights history [--limit N]",
    "  opencode-insights show <session-id> [--limit N]",
    "  opencode-insights export <session-id> [--output PATH] [--limit N]",
    "  opencode-insights serve [--limit N] [--host HOST] [--port PORT]",
    "  opencode-insights open [--limit N] [--host HOST] [--port PORT]",
    "  opencode-insights doctor",
    "  opencode-insights vacuum"
  ].join("\n");
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- cli.test.ts`
Expected: PASS.

- [ ] **Step 5: Run typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/cli.ts test/cli.test.ts
git commit -m "feat: cli reads storage config, drops storage flags"
```

---

### Task 4: Docs and release gate

**Files:**
- Modify: `README.md` (Storage section ~228-258)
- Modify: `AGENTS.md` (operational rules line 34)

- [ ] **Step 1: Update README.md Storage section**

Replace the `opencode.json` override example (README.md:244-258) with:

```markdown
Storage settings live in the config file `~/.opencode-insights/config.jsonc` (JSONC —
comments allowed). The plugin creates it on first run with `dbPath` commented out
(uncomment to relocate the database) and `retentionDays` defaulting to 1:

```jsonc
{
  // Database file. Default: ~/.opencode-insights/insights.sqlite
  // "dbPath": "/absolute/path/to/insights.sqlite",
  "retentionDays": 1,
  "promptRightMetrics": ["tps", "avg", "used", "cache"],
  "goUsage": { "enabled": false, "cookie": "", "workspaceID": "", "refreshMs": 300000 }
}
```

`retentionDays` sets how many days of captures are kept (`0` disables auto-cleaning).
A legacy `config.json` is still honored when `config.jsonc` does not exist. Plugin
params such as `{ "dbPath": … }` in `opencode.json` are no longer read.
```

- [ ] **Step 2: Update AGENTS.md**

Change the line at AGENTS.md:34 to:

```markdown
- Storage defaults to `~/.opencode-insights/insights.sqlite` with `config.jsonc` beside it; `dbPath`/`retentionDays` are read from the config file (a legacy `config.json` is honored when the jsonc is absent). One day of retention by default.
```

- [ ] **Step 3: Run the full release gate**

Run: `npm run verify`
Expected: PASS (typecheck, all tests, build).

- [ ] **Step 4: Commit**

```bash
git add README.md AGENTS.md
git commit -m "docs: document config.jsonc storage settings"
```
