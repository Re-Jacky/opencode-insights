# Debug / Revert Debug Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `npm run debug` replace (not duplicate) the official `@rejacky/opencode-insights@latest` spec in the OpenCode configs with the local build output, and add `npm run revert-debug` to swap the local build output back to the official package.

**Architecture:** All config editing lives in `src/cli.ts` (single source of truth — `debug` and `uninstall` already live there). A fixed `isInsightsPluginEntry` matcher recognizes every form of the insights spec (bare, `@latest`, `@<semver>`, `npm:`-prefixed, `/tui` subpath, tgz, local dist paths). `debug` keeps replace-or-append semantics; a new `revert` subcommand replaces only local dist-path entries with the hardcoded `@rejacky/opencode-insights@latest`. JSONC comments are preserved via the existing `writeJsonConfig` (jsonc-parser `modify`).

**Tech Stack:** TypeScript (strict, NodeNext ESM), vitest, jsonc-parser (already a dependency), Node >= 22.13.

## Global Constraints

- ESM NodeNext: all relative imports need explicit `.js` extensions (`import … from "../src/cli.js"`).
- `exactOptionalPropertyTypes` is on: optional fields are explicitly `T | undefined`.
- Tests import from `src/` directly, never from `dist/`; they live in `test/**/*.test.ts`.
- `npm run verify` = `typecheck && test && build` — the release gate; must pass before finishing.
- Commit messages use `feat:`/`fix:`/`style:` prefixes.
- Recognition of local dev paths uses the pattern `/opencode-insights/dist/(index|tui).js$` (repo dir named `opencode-insights`) — per approved spec; no cwd-derived matching.

---

### Task 1: Recognize version-suffixed official specs (debug no longer duplicates `@latest`)

The bug: `isInsightsPluginEntry` (src/cli.ts:470) only matches the bare spec
`@rejacky/opencode-insights`. A config with `@rejacky/opencode-insights@latest` is not
recognized, so `setSinglePluginSpec` keeps it AND appends the local path — two entries.

**Files:**
- Modify: `src/cli.ts:452-477` (`setSinglePluginSpec`, `isInsightsPluginEntry`, add `isInsightsSpec`) and `src/cli.ts:336-337` (call sites)
- Test: `test/cli.test.ts`

**Interfaces:**
- Consumes: existing `JsonObject`, `isPluginEntry`, constants `SERVER_PLUGIN_SPEC`, `SUBPATH_TUI_PLUGIN_SPEC` (src/cli.ts:17-19).
- Produces: `setSinglePluginSpec(config: JsonObject, nextPlugin: unknown)` — drops the `previousPlugin`/`nextPluginSpec` params. Nothing outside `configureOpenCodeDebug` calls it.

- [ ] **Step 1: Write the failing tests**

Add these two tests to `test/cli.test.ts` (after the existing "debug command points opencode and tui configs at local build output" test, around line 210). The existing helpers (`mkdtemp`, `stripJsonCommentsAndTrailingCommas`, etc.) are already imported.

```typescript
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/cli.test.ts -t "debug replaces"`

Expected: FAIL — both tests see two plugin entries (`["existing", "@rejacky/opencode-insights@latest", "<tmp>/dist/index.js"]`) instead of one. The "points opencode and tui configs at local build output" test still passes.

- [ ] **Step 3: Implement the matcher fix**

In `src/cli.ts`, replace the whole `setSinglePluginSpec` + `isInsightsPluginEntry` block (src/cli.ts:463-477) with:

```typescript
function setSinglePluginSpec(config: JsonObject, nextPlugin: unknown) {
  const current = Array.isArray(config.plugin) ? config.plugin : [];
  const next = current.filter((entry) => !isInsightsPluginEntry(entry));
  config.plugin = [...next, nextPlugin];
}

function isInsightsPluginEntry(entry: unknown): boolean {
  const spec = Array.isArray(entry) ? entry[0] : entry;
  if (typeof spec !== "string") return false;
  return isInsightsSpec(spec);
}

function isInsightsSpec(spec: string): boolean {
  if (spec === SERVER_PLUGIN_SPEC || spec === SUBPATH_TUI_PLUGIN_SPEC) return true;
  if (spec.startsWith("npm:")) return isInsightsSpec(spec.slice(4));
  if (spec.startsWith(`${SERVER_PLUGIN_SPEC}@`)) return true;
  return /(?:^|[/@-])opencode-insights.*\.tgz$/u.test(spec) || /\/opencode-insights\/dist\/(?:index|tui)\.js$/u.test(spec);
}
```

Then update the two call sites in `configureOpenCodeDebug` (src/cli.ts:336-337):

```typescript
  setSinglePluginSpec(opencodeConfig, localServerEntry);
  setSinglePluginSpec(tuiConfig, localTuiEntry);
```

(Remove the `SERVER_PLUGIN_SPEC` / `TUI_PLUGIN_SPEC` middle argument; the constants stay — `uninstall` still uses them.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/cli.test.ts`

Expected: PASS (all cli tests, including the two new ones and both existing debug tests).

- [ ] **Step 5: Commit**

```bash
git add src/cli.ts test/cli.test.ts
git commit -m "fix: debug replaces version-suffixed official plugin specs"
```

---

### Task 2: `revert` subcommand + `revert-debug` npm script

**Files:**
- Modify: `src/cli.ts` (add `revertOpenCodeDebug` + helpers near `configureOpenCodeDebug` ~line 361; dispatch ~line 127; `usage()` ~line 549)
- Modify: `test/cli.test.ts` (import + 5 tests)
- Modify: `package.json:47-56` (scripts)
- Modify: `AGENTS.md:11` (commands section)

**Interfaces:**
- Consumes: `isInsightsPluginEntry` (Task 1), existing `readJsonConfig` / `readJsonConfigSource` / `writeJsonConfig` (src/cli.ts:378-395, 537-547), `resolveOpenCodeConfigPath`, `defaultOpenCodeConfigDir`, `JsonObject`, `CliOptions`.
- Produces: exported `revertOpenCodeDebug(options: CliOptions): Promise<string>` — called by the `revert` dispatch in `main()`.

- [ ] **Step 1: Write the failing tests**

Add `revertOpenCodeDebug` to the import list at the top of `test/cli.test.ts` (alphabetical order, between `removePlugin` and `stripJsonCommentsAndTrailingCommas`):

```typescript
import {
  addUniquePlugin,
  configureOpenCodeDebug,
  formatSessionSummary,
  parseOptions,
  removePlugin,
  revertOpenCodeDebug,
  stripJsonCommentsAndTrailingCommas,
  summarizeSessions,
  uninstallOpenCode,
  unsupportedFlagWarning
} from "../src/cli.js";
```

Add these five tests after the Task 1 tests:

```typescript
test("revert swaps local build output back to the official package", async () => {
  const dir = await mkdtemp(join(tmpdir(), "opencode-insights-test-"));
  try {
    await writeFile(
      join(dir, "opencode.jsonc"),
      '{\n  // Keep this comment when revert updates the plugin.\n  "plugin": ["existing", "/Users/me/opencode-insights/dist/index.js",],\n}\n',
      "utf8"
    );
    await writeFile(
      join(dir, "tui.json"),
      '{\n  // Keep this TUI comment too.\n  "plugin": ["/Users/me/opencode-insights/dist/tui.js"]\n}\n',
      "utf8"
    );

    const output = await revertOpenCodeDebug({
      configDir: dir,
      limit: 20,
      limitProvided: false,
      json: false,
      dryRun: false,
      keepData: false
    });

    const opencodeText = await readFile(join(dir, "opencode.jsonc"), "utf8");
    const tuiText = await readFile(join(dir, "tui.json"), "utf8");
    const opencode = JSON.parse(stripJsonCommentsAndTrailingCommas(opencodeText)) as { plugin: unknown[] };
    const tui = JSON.parse(stripJsonCommentsAndTrailingCommas(tuiText)) as { plugin: unknown[] };
    expect(output).toContain("Reverted to the official package");
    expect(opencodeText).toContain("Keep this comment");
    expect(tuiText).toContain("Keep this TUI comment");
    expect(opencode.plugin).toEqual(["existing", "@rejacky/opencode-insights@latest"]);
    expect(tui.plugin).toEqual(["@rejacky/opencode-insights@latest"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("revert reports when no local build output is present", async () => {
  const dir = await mkdtemp(join(tmpdir(), "opencode-insights-test-"));
  try {
    const source = '{\n  "plugin": ["existing", "@rejacky/opencode-insights@latest"]\n}\n';
    await writeFile(join(dir, "opencode.jsonc"), source, "utf8");

    const output = await revertOpenCodeDebug({
      configDir: dir,
      limit: 20,
      limitProvided: false,
      json: false,
      dryRun: false,
      keepData: false
    });

    expect(output).toContain("not present (local build output)");
    expect(await readFile(join(dir, "opencode.jsonc"), "utf8")).toBe(source);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("revert dry run leaves configs unchanged", async () => {
  const dir = await mkdtemp(join(tmpdir(), "opencode-insights-test-"));
  try {
    const source = '{\n  "plugin": ["/Users/me/opencode-insights/dist/index.js"]\n}\n';
    await writeFile(join(dir, "opencode.json"), source, "utf8");

    const output = await revertOpenCodeDebug({
      configDir: dir,
      limit: 20,
      limitProvided: false,
      json: false,
      dryRun: true,
      keepData: false
    });

    expect(output).toContain("would replace");
    expect(output).toContain("Dry run: no files written");
    expect(await readFile(join(dir, "opencode.json"), "utf8")).toBe(source);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("revert skips missing config files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "opencode-insights-test-"));
  try {
    await writeFile(join(dir, "tui.json"), '{"plugin": ["/Users/me/opencode-insights/dist/tui.js"]}\n', "utf8");

    const output = await revertOpenCodeDebug({
      configDir: dir,
      limit: 20,
      limitProvided: false,
      json: false,
      dryRun: false,
      keepData: false
    });

    expect(output).toContain("Server plugin: config not found");
    expect(output).toContain("TUI plugin: replaced local build with @rejacky/opencode-insights@latest");
    const tui = JSON.parse(await readFile(join(dir, "tui.json"), "utf8")) as { plugin: unknown[] };
    expect(tui.plugin).toEqual(["@rejacky/opencode-insights@latest"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("revert collapses a stale dev path when the official spec is already present", async () => {
  const dir = await mkdtemp(join(tmpdir(), "opencode-insights-test-"));
  try {
    await writeFile(
      join(dir, "opencode.jsonc"),
      '{\n  "plugin": ["@rejacky/opencode-insights@latest", "/Users/me/opencode-insights/dist/index.js"]\n}\n',
      "utf8"
    );

    await revertOpenCodeDebug({
      configDir: dir,
      limit: 20,
      limitProvided: false,
      json: false,
      dryRun: false,
      keepData: false
    });

    const opencode = JSON.parse(stripJsonCommentsAndTrailingCommas(await readFile(join(dir, "opencode.jsonc"), "utf8"))) as {
      plugin: unknown[];
    };
    expect(opencode.plugin).toEqual(["@rejacky/opencode-insights@latest"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/cli.test.ts -t "revert"`

Expected: FAIL — `revertOpenCodeDebug` is not exported from `../src/cli.js`.

- [ ] **Step 3: Implement the revert command**

In `src/cli.ts`, add these functions right after `configureOpenCodeDebug` (after line 361):

```typescript
export async function revertOpenCodeDebug(options: CliOptions) {
  const configDir = options.configDir ?? defaultOpenCodeConfigDir();
  const opencodePath = resolveOpenCodeConfigPath(configDir);
  const tuiPath = join(configDir, "tui.json");
  const officialSpec = `${SERVER_PLUGIN_SPEC}@latest`;

  const lines = [
    `OpenCode config: ${opencodePath}`,
    `TUI config: ${tuiPath}`,
    `Official plugin spec: ${officialSpec}`,
    `Server plugin: ${await revertPluginToOfficial(opencodePath, officialSpec, options)}`,
    `TUI plugin: ${await revertPluginToOfficial(tuiPath, officialSpec, options)}`
  ];

  if (options.dryRun) {
    lines.push("Dry run: no files written.");
  } else {
    lines.push("Reverted to the official package. Restart OpenCode to load it.");
  }
  return lines.join("\n");
}

async function revertPluginToOfficial(path: string, officialSpec: string, options: CliOptions) {
  if (!existsSync(path)) return "config not found";
  const source = await readJsonConfigSource(path);
  const config = await readJsonConfig(path, { plugin: [] }, source);
  const current = Array.isArray(config.plugin) ? config.plugin : [];
  let changed = false;
  const next = current.map((entry) => {
    if (!isLocalDistEntry(entry)) return entry;
    changed = true;
    return officialSpec;
  });
  if (!changed) return "not present (local build output)";
  config.plugin = dedupeStrings(next);
  if (options.dryRun) return `would replace local build with ${officialSpec}`;
  await writeJsonConfig(path, config, source);
  return `replaced local build with ${officialSpec}`;
}

function isLocalDistEntry(entry: unknown): boolean {
  const spec = Array.isArray(entry) ? entry[0] : entry;
  return typeof spec === "string" && /\/opencode-insights\/dist\/(?:index|tui)\.js$/u.test(spec);
}

function dedupeStrings(values: unknown[]) {
  const seen = new Set<string>();
  return values.filter((value) => {
    if (typeof value !== "string") return true;
    if (seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}
```

Then wire up the command dispatch in `main()` (right after the `debug` block, src/cli.ts:127-130):

```typescript
  if (command === "revert") {
    process.stdout.write(`${await revertOpenCodeDebug(options)}\n`);
    return;
  }
```

And add the usage line in `usage()` (src/cli.ts:552, right after the debug line):

```typescript
    "  opencode-insights revert [--config-dir DIR] [--dry-run]",
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/cli.test.ts`

Expected: PASS (all cli tests).

- [ ] **Step 5: Add the npm script and docs**

In `package.json` scripts (line 49), after the `debug` line:

```json
    "revert-debug": "node dist/cli.js revert",
```

In `AGENTS.md` line 11, replace the `npm run debug` bullet with:

```markdown
- `npm run debug` — builds then runs `node dist/cli.js debug` to point the OpenCode configs at the local build; `npm run revert-debug` runs `node dist/cli.js revert` to restore the official `@rejacky/opencode-insights@latest` package. Requires a build first.
```

- [ ] **Step 6: Run the release gate**

Run: `npm run verify`

Expected: typecheck passes, all tests pass, tsup build succeeds.

- [ ] **Step 7: Manual smoke test against the real configs (dry-run only)**

Run:

```bash
node dist/cli.js debug --dry-run
node dist/cli.js revert --dry-run
```

Expected: both print their config paths and report the planned change ("Dry run: no files written.") without touching `~/.config/opencode/`. `debug --dry-run` must show the local `dist/index.js` path; `revert --dry-run` must show `@rejacky/opencode-insights@latest`.

- [ ] **Step 8: Commit**

```bash
git add src/cli.ts test/cli.test.ts package.json AGENTS.md
git commit -m "feat: revert-debug command to restore the official package"
```

---

## Self-Review

- **Spec coverage:** matcher (all 6 recognition rules) → Task 1; debug replace-without-duplicate + append-if-absent → Task 1; revert subcommand, hardcoded `@latest`, dev-path-only matching, "not present" report, missing-file skip, `--config-dir`/`--dry-run` → Task 2; npm scripts + usage() + AGENTS.md → Task 2; all 8 tests listed in the spec → Tasks 1-2 (spec tests map 1:1 to the tests above, plus the stale-dev-path dedupe case).
- **Placeholders:** none — every step has concrete code or commands.
- **Type consistency:** `setSinglePluginSpec(config, nextPlugin)` drops the `previousPlugin` param everywhere (both call sites in Task 1); `revertOpenCodeDebug(options: CliOptions): Promise<string>` matches the dispatch and tests; `isInsightsPluginEntry(entry)` is internal-only and never exported (tests exercise it end-to-end via `configureOpenCodeDebug`).
