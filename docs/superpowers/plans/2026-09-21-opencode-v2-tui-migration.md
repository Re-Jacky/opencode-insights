# OpenCode V2 TUI-Only Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `@rejacky/opencode-insights` a V2-only, CLI-only TUI plugin that keeps the Token Usage, Session Analysis, Subagents, Go Usage, and Copilot Usage sidebars plus the prompt-right metrics row, and delete the V1 server plugin, capture/storage, viewer, and CLI.

**Architecture:** The plugin becomes a single `@opencode/plugin/tui` `Plugin.define({ id, setup })` entrypoint. `setup` owns plain (pure) state objects, subscribes once with `context.data.listen`, and registers two `context.ui.slot` claims rendered as reactive Solid JSX. V2 events are translated into the existing pure metrics/activity/subagents state by a new `src/events.ts`. Config parsing moves out of `capture.ts` into `src/config.ts`.

**Tech Stack:** TypeScript (NodeNext ESM), SolidJS via `@opentui/solid`, `@opencode/plugin/tui` v2.0.11, `@opentui/core`, `jsonc-parser`, vitest, tsup.

**Spec:** `docs/superpowers/specs/2026-09-21-opencode-v2-tui-migration-design.md`

## Global Constraints

- V2-only. Do not add or preserve any V1 (`@opencode-ai/plugin`) code path.
- Node >= 22.13, `"type": "module"`. All relative imports need explicit `.js` extensions, including tests.
- `tsc --noEmit` is strict with `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`; optional fields are `T | undefined`. Do not assign `undefined` to an optional property; use `compactUndefined`-style object building or conditional spreads.
- JSX import source is `@opentui/solid` (tsconfig + tsup). Do not put `tui` inside any server default export.
- Package version ends at `1.0.0`. `@opencode/plugin` is a dependency; `@opentui/core`, `@opentui/solid`, `solid-js` are peerDependencies.
- Config path remains `~/.opencode-insights/config.jsonc`; keep `promptRightMetrics`, `goUsage`, `copilotUsage`; drop `dbPath`/`retentionDays`.
- The release gate is `npm run verify` (`typecheck && test && build`) and must pass at the end of every task.
- Never let plugin code throw into OpenCode: event/hydration handlers swallow errors.

## Review Focus

These are the input classes and failure modes most likely to bite a user, and the task that pins each with a test:

1. Malformed / partial V2 event payloads (missing `data`, missing `name`, missing `tokens`) must be ignored without throwing — Task 4.
2. An assistant message that spans multiple steps must not double-count tokens or session averages — Task 4.
3. The root session must never appear as its own subagent, and a session without `parentID` must never create a subagent row — Task 3.
4. A session whose provider is neither `opencode-go` nor `github-copilot` must never show the usage sections — Tasks 8 (visibility) and 4 (tracker).
5. Hydration of a large session history must stay bounded (concurrency limit) and must not leave a session permanently un-hydrated after a transient error — Task 2.

---

### Task 1: Extract the config module

Move config types/parsing/`resolveCopilotToken` out of `capture.ts` into a new `src/config.ts` with no capture/store dependency, and point `go-usage.ts`/`copilot-usage.ts` at it. `capture.ts` keeps its store code and imports `InsightsOptions` from `./config.js`.

**Files:**
- Create: `src/config.ts`
- Modify: `src/capture.ts` (remove config functions/types + `resolveCopilotToken`; import `InsightsOptions` from `./config.js`; keep `resolveCapturePath`, `createCaptureStore`, stores, normalizers, `insightsOptionsFromConfig`)
- Modify: `src/go-usage.ts:1` (`import type { GoUsageConfig, InsightsConfig } from "./config.js"`)
- Modify: `src/copilot-usage.ts:1` (same)
- Test: `test/config.test.ts`

**Interfaces:**
- Consumes: `DEFAULT_PROMPT_RIGHT_METRICS`, `PromptRightMetric` from `./metrics.js`.
- Produces:
  - `type InsightsOptions = { dataDir?: unknown }`
  - `type GoUsageConfig = { enabled: boolean; cookie: string; workspaceID: string; refreshMs: number }`
  - `type CopilotUsageConfig = { enabled: boolean; token: string; refreshMs: number }`
  - `type InsightsConfig = { promptRightMetrics: PromptRightMetric[]; goUsage: GoUsageConfig; copilotUsage: CopilotUsageConfig }`
  - `defaultDataDir(): string`
  - `resolveInsightsConfigPath(options?: InsightsOptions): string`
  - `readInsightsConfig(options?: InsightsOptions): Promise<InsightsConfig>`
  - `resolveCopilotToken(config: CopilotUsageConfig): string`

- [ ] **Step 1: Write the failing test**

Create `test/config.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/config.test.ts`
Expected: FAIL — cannot resolve `../src/config.js`.

- [ ] **Step 3: Create `src/config.ts`**

Move the following from `src/capture.ts` verbatim (adjusting only imports/exports), dropping `dbPath`/`retentionDays` and the capture-specific functions. The file must contain:

```ts
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { parse, type ParseError } from "jsonc-parser";
import { DEFAULT_PROMPT_RIGHT_METRICS, type PromptRightMetric } from "./metrics.js";

export type InsightsOptions = {
  dataDir?: unknown;
};

export type GoUsageConfig = {
  enabled: boolean;
  cookie: string;
  workspaceID: string;
  refreshMs: number;
};

export type CopilotUsageConfig = {
  enabled: boolean;
  token: string;
  refreshMs: number;
};

export type InsightsConfig = {
  promptRightMetrics: PromptRightMetric[];
  goUsage: GoUsageConfig;
  copilotUsage: CopilotUsageConfig;
};

const DEFAULT_GO_USAGE_REFRESH_MS = 300_000;
const DEFAULT_COPILOT_USAGE_REFRESH_MS = 300_000;
const MIN_GO_USAGE_REFRESH_MS = 60_000;
const MIN_COPILOT_USAGE_REFRESH_MS = 60_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function defaultDataDir() {
  return join(homedir(), ".opencode-insights");
}

function resolveConfigDataDir(options: InsightsOptions = {}) {
  return typeof options.dataDir === "string" && options.dataDir.length > 0
    ? options.dataDir
    : defaultDataDir();
}

export function resolveInsightsConfigPath(options: InsightsOptions = {}) {
  return join(resolveConfigDataDir(options), "config.jsonc");
}

export function resolveLegacyInsightsConfigPath(options: InsightsOptions = {}) {
  return join(resolveConfigDataDir(options), "config.json");
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
    `  "promptRightMetrics": ${JSON.stringify(DEFAULT_PROMPT_RIGHT_METRICS)},`,
    `  "goUsage": ${JSON.stringify(defaultGoUsageConfig())},`,
    `  "copilotUsage": ${JSON.stringify(defaultCopilotUsageConfig())}`,
    "}",
    ""
  ].join("\n");
}

function defaultInsightsConfig(): InsightsConfig {
  return {
    promptRightMetrics: [...DEFAULT_PROMPT_RIGHT_METRICS],
    goUsage: defaultGoUsageConfig(),
    copilotUsage: defaultCopilotUsageConfig()
  };
}

function defaultGoUsageConfig(): GoUsageConfig {
  return { enabled: false, cookie: "", workspaceID: "", refreshMs: DEFAULT_GO_USAGE_REFRESH_MS };
}

function defaultCopilotUsageConfig(): CopilotUsageConfig {
  return { enabled: false, token: "", refreshMs: DEFAULT_COPILOT_USAGE_REFRESH_MS };
}

function insightsConfigFrom(value: unknown): InsightsConfig {
  const record = isRecord(value) ? value : {};
  const metrics = Array.isArray(record.promptRightMetrics)
    ? record.promptRightMetrics.filter(isPromptRightMetric)
    : [];
  return {
    promptRightMetrics: metrics.length ? metrics : [...DEFAULT_PROMPT_RIGHT_METRICS],
    goUsage: goUsageConfigFrom(record.goUsage),
    copilotUsage: copilotUsageConfigFrom(record.copilotUsage)
  };
}

function goUsageConfigFrom(value: unknown): GoUsageConfig {
  const record = isRecord(value) ? value : {};
  const enabled = record.enabled === true;
  const cookie = typeof record.cookie === "string" && record.cookie.length > 0 ? record.cookie : "";
  const workspaceID =
    typeof record.workspaceID === "string" && record.workspaceID.length > 0 ? record.workspaceID : "";
  const refreshMs =
    typeof record.refreshMs === "number" && Number.isFinite(record.refreshMs)
      ? Math.max(MIN_GO_USAGE_REFRESH_MS, Math.trunc(record.refreshMs))
      : DEFAULT_GO_USAGE_REFRESH_MS;
  return { enabled, cookie, workspaceID, refreshMs };
}

function copilotUsageConfigFrom(value: unknown): CopilotUsageConfig {
  const record = isRecord(value) ? value : {};
  const enabled = record.enabled === true;
  const token = typeof record.token === "string" && record.token.length > 0 ? record.token : "";
  const refreshMs =
    typeof record.refreshMs === "number" && Number.isFinite(record.refreshMs)
      ? Math.max(MIN_COPILOT_USAGE_REFRESH_MS, Math.trunc(record.refreshMs))
      : DEFAULT_COPILOT_USAGE_REFRESH_MS;
  return { enabled, token, refreshMs };
}

function isPromptRightMetric(value: unknown): value is PromptRightMetric {
  return (
    value === "tps" ||
    value === "avg" ||
    value === "ttft" ||
    value === "used" ||
    value === "cache" ||
    value === "input" ||
    value === "output" ||
    value === "reasoning"
  );
}

export function resolveCopilotToken(config: CopilotUsageConfig): string {
  if (config.token.length > 0) return config.token;
  try {
    const authPath = join(homedir(), ".local/share/opencode/auth.json");
    if (!existsSync(authPath)) return "";
    const raw = readFileSync(authPath, "utf8");
    const auth = JSON.parse(raw) as Record<string, unknown>;
    const copilot = isRecord(auth?.["github-copilot"]) ? auth["github-copilot"] : undefined;
    if (!copilot) return "";
    const access = typeof copilot.access === "string" ? copilot.access : "";
    const refresh = typeof copilot.refresh === "string" ? copilot.refresh : "";
    return access || refresh;
  } catch {
    return "";
  }
}
```

- [ ] **Step 4: Update `src/capture.ts`, `src/go-usage.ts`, `src/copilot-usage.ts`**

In `src/capture.ts`, delete the moved functions and types (`InsightsOptions`, `GoUsageConfig`, `CopilotUsageConfig`, `InsightsConfig`, `defaultDataDir`, `resolveInsightsConfigPath`, `resolveLegacyInsightsConfigPath`, `resolveConfigDataDir`, `readInsightsConfig`, `parseInsightsConfigFile`, `defaultInsightsConfigJsonc`, `defaultInsightsConfig`, `defaultGoUsageConfig`, `defaultCopilotUsageConfig`, `insightsConfigFrom`, `goUsageConfigFrom`, `copilotUsageConfigFrom`, `isPromptRightMetric`, `resolveCopilotToken`, and the `DEFAULT_GO_USAGE_REFRESH_MS`/`DEFAULT_COPILOT_USAGE_REFRESH_MS`/`MIN_*` constants). Add at the top:

```ts
import type { InsightsOptions } from "./config.js";
```

Keep `resolveCapturePath`, `createCaptureStore`, `insightsOptionsFromConfig`, the stores, and the normalizers. `insightsOptionsFromConfig` keeps its current signature but its parameter type becomes `{ dbPath?: unknown; retentionDays?: unknown }`:

```ts
type StoreOptions = { dbPath?: unknown; retentionDays?: unknown };

export function insightsOptionsFromConfig(config: StoreOptions, dataDir?: string): InsightsOptions {
  return compactUndefined({ dataDir, dbPath: config.dbPath, retentionDays: config.retentionDays });
}
```

In `src/go-usage.ts` and `src/copilot-usage.ts`, change the first import to:

```ts
import type { GoUsageConfig, InsightsConfig } from "./config.js";
```

(and for copilot: `import type { CopilotUsageConfig, InsightsConfig } from "./config.js";`).

- [ ] **Step 5: Run the tests and typecheck**

Run: `npx vitest run test/config.test.ts && npm run typecheck`
Expected: config tests PASS; typecheck PASS (existing `capture`/`index` tests still reference removed exports only if they imported them — if `test/capture.test.ts` imports a moved symbol, update that import to `../src/config.js`).

- [ ] **Step 6: Commit**

```bash
git add src/config.ts src/capture.ts src/go-usage.ts src/copilot-usage.ts test/config.test.ts
git commit -m "refactor: extract insights config into src/config.ts"
```

---

### Task 2: Rewrite activity hydration for the V2 Data API

Replace `client.session.list()`/`client.session.messages()` hydration with `context.data.session.list()` + `context.data.session.message.sync()/.list()`, reading the V2 `SessionMessageAssistant.content[]` shapes.

**Files:**
- Modify: `src/activity-hydrate.ts` (full rewrite)
- Test: `test/activity-hydrate.test.ts` (full rewrite)

**Interfaces:**
- Consumes: `recordChild`, `recordCompaction`, `recordToolPart`, `type ActivityState` from `./activity.js`.
- Produces:
  - `type ActivityData = { session: { list(): Array<{ id: string; parentID?: string; title?: string }>; message: { sync(sessionID: string): Promise<void>; list(sessionID: string): Array<Record<string, unknown>> } } }`
  - `hydrateActivity(data: ActivityData, state: ActivityState, rootSessionID: string): Promise<void>`

- [ ] **Step 1: Write the failing test**

Create `test/activity-hydrate.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import { createActivityState } from "../src/activity.js";
import { hydrateActivity, type ActivityData } from "../src/activity-hydrate.js";

describe("hydrateActivity", () => {
  test("records child sessions, tool calls, and compactions from message content", async () => {
    const state = createActivityState();
    const data: ActivityData = {
      session: {
        list: () => [
          { id: "ses_root", title: "Root" },
          { id: "ses_child", parentID: "ses_root", title: "Child" }
        ],
        message: {
          sync: async () => {},
          list: (sessionID) =>
            sessionID === "ses_child"
              ? [
                  {
                    type: "assistant",
                    content: [
                      { type: "tool", id: "t1", name: "read", state: { status: "completed", input: {} } },
                      { type: "compaction", id: "c1", reason: "auto", status: "completed" }
                    ]
                  }
                ]
              : []
        }
      }
    };

    await hydrateActivity(data, state, "ses_root");

    expect(state.childrenByParent["ses_root"]).toEqual(["ses_child"]);
    expect(state.bySessionID["ses_child"]?.toolCalls).toBe(1);
    expect(state.bySessionID["ses_child"]?.autoCompacts).toBe(1);
    expect(state.hydrated.has("ses_child")).toBe(true);
  });

  test("leaves the session unhydrated when message sync fails so it can retry", async () => {
    const state = createActivityState();
    const data: ActivityData = {
      session: {
        list: () => [{ id: "ses_root" }],
        message: {
          sync: async () => {
            throw new Error("transient");
          },
          list: () => []
        }
      }
    };

    await hydrateActivity(data, state, "ses_root");

    expect(state.hydrated.has("ses_root")).toBe(false);
    expect(state.loading.has("ses_root")).toBe(false);
  });

  test("returns early for a non-session id", async () => {
    const state = createActivityState();
    let listed = false;
    const data: ActivityData = {
      session: {
        list: () => {
          listed = true;
          return [];
        },
        message: { sync: async () => {}, list: () => [] }
      }
    };

    await hydrateActivity(data, state, "not-a-session");

    expect(listed).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/activity-hydrate.test.ts`
Expected: FAIL — `hydrateActivity` exports the old signature / `ActivityData` does not exist.

- [ ] **Step 3: Rewrite `src/activity-hydrate.ts`**

```ts
import { recordChild, recordCompaction, recordToolPart, type ActivityState } from "./activity.js";

export type ActivityData = {
  session: {
    list(): Array<{ id: string; parentID?: string; title?: string }>;
    message: {
      sync(sessionID: string): Promise<void>;
      list(sessionID: string): Array<Record<string, unknown>>;
    };
  };
};

const CONCURRENCY_LIMIT = 4;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isSessionID(value: string): boolean {
  return value.startsWith("ses");
}

function stringFrom(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

async function mapConcurrent<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (true) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await fn(items[index]!);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

function collectUnhydrated(state: ActivityState, rootSessionID: string): string[] {
  const visited = new Set<string>();
  const result: string[] = [];
  const stack = [rootSessionID];
  while (stack.length > 0) {
    const sessionID = stack.pop();
    if (sessionID === undefined || visited.has(sessionID)) continue;
    visited.add(sessionID);
    if (!state.hydrated.has(sessionID) && !state.loading.has(sessionID)) result.push(sessionID);
    for (const child of state.childrenByParent[sessionID] ?? []) {
      if (!visited.has(child)) stack.push(child);
    }
  }
  return result;
}

function applyContent(state: ActivityState, sessionID: string, content: Array<Record<string, unknown>>): void {
  for (const item of content) {
    const id = stringFrom(item.id);
    if (item.type === "tool" && typeof item.name === "string") {
      const toolState = isRecord(item.state) ? item.state : undefined;
      const error = isRecord(toolState?.error) ? stringFrom(toolState.error.message) : undefined;
      const input = isRecord(toolState?.input) ? toolState.input : undefined;
      recordToolPart(state, sessionID, {
        ...(id !== undefined ? { id } : {}),
        tool: item.name,
        ...(toolState
          ? { state: { ...(stringFrom(toolState.status) ? { status: stringFrom(toolState.status) } : {}), ...(input ? { input: input as { name?: string } } : {}), ...(error ? { error } : {}) } }
          : {})
      });
    } else if (item.type === "compaction" && id !== undefined) {
      recordCompaction(state, sessionID, id, item.reason === "auto");
    }
  }
}

export async function hydrateActivity(data: ActivityData, state: ActivityState, rootSessionID: string): Promise<void> {
  if (!isSessionID(rootSessionID)) return;

  let sessions: Array<{ id: string; parentID?: string; title?: string }> = [];
  try {
    sessions = data.session.list();
  } catch {
    return; // degrade to live-only data
  }
  for (const session of sessions) {
    if (!session.id) continue;
    if (session.title) state.titles[session.id] = session.title;
    if (session.parentID) recordChild(state, session.id, session.parentID);
  }

  const toHydrate = collectUnhydrated(state, rootSessionID);
  for (const sessionID of toHydrate) state.loading.add(sessionID);
  await mapConcurrent(toHydrate, CONCURRENCY_LIMIT, async (sessionID) => {
    try {
      await data.session.message.sync(sessionID);
      const messages = data.session.message.list(sessionID);
      for (const message of messages) {
        const content = Array.isArray(message.content)
          ? message.content.filter(isRecord)
          : [];
        if (content.length > 0) applyContent(state, sessionID, content);
      }
      state.hydrated.add(sessionID);
    } catch {
      // leave unhydrated so the next navigation retries
    } finally {
      state.loading.delete(sessionID);
    }
  });
}
```

- [ ] **Step 4: Run the tests and typecheck**

Run: `npx vitest run test/activity-hydrate.test.ts && npm run typecheck`
Expected: PASS. The old `src/tui.tsx` still calls the previous hydration API; update that one call site to `hydrateActivity(api.client as never, activity, props.session_id)` so the repo stays green until Task 5 rewrites `tui.tsx`.

- [ ] **Step 5: Commit**

```bash
git add src/activity-hydrate.ts test/activity-hydrate.test.ts
git commit -m "refactor: hydrate activity from the V2 Data API"
```

---

### Task 3: Rewrite subagent event extraction for V2

Replace the V1 `message.part.updated` task-tool and `session.*` extraction in `subagents.ts` with V2 `session.created` / `session.renamed` / `session.status` / `session.idle` / `session.execution.failed` / step-and-usage events. Drop the task-tool workaround entirely: V2 `session.created` carries `parentID`.

**Files:**
- Modify: `src/subagents.ts` (replace `EventLike`, `applySubagentEvent`, `extractTaskToolSubagent`, `extractSubagent`, `updateExistingSubagent`, `statusFromEvent`; keep everything from `createSubagentState` through the render/model helpers and the formatting helpers)
- Test: `test/subagents.test.ts` (rewrite the `applySubagentEvent` cases; keep model/render cases)

**Interfaces:**
- Consumes: `emptyActivity`, `formatActivitySuffix`, `ActivityState`, `SessionActivity` from `./activity.js`.
- Produces (unchanged signatures):
  - `createSubagentState(activityStore?: ActivityState): SubagentState`
  - `recordSubagentFromSessionInfo(state, session: { id: string; parentID?: string; title?: string }): void`
  - `applySubagentEvent(state: SubagentState, event: unknown): boolean`
  - `getSubagentSidebarModel`, `getSubagentSidebarRowAtLine`, `sumSubagentTokens`, etc. unchanged.

- [ ] **Step 1: Write the failing tests**

Replace the `applySubagentEvent` section of `test/subagents.test.ts` with V2-shaped fixtures. Add these cases (keep the existing pure model/render tests untouched):

```ts
import { describe, expect, test } from "vitest";
import { createSubagentState, applySubagentEvent, getSubagentSidebarModel } from "../src/subagents.js";

function created(overrides: Record<string, unknown> = {}) {
  return {
    type: "session.created",
    created: 1_000,
    data: {
      sessionID: "ses_child",
      parentID: "ses_root",
      title: "Explore tests",
      ...overrides
    }
  };
}

describe("applySubagentEvent (V2)", () => {
  test("creates a running subagent from session.created with a parent", () => {
    const state = createSubagentState();

    expect(applySubagentEvent(state, created())).toBe(true);

    expect(state.children["ses_child"]).toMatchObject({
      id: "ses_child",
      parentID: "ses_root",
      title: "Explore tests",
      status: "running"
    });
  });

  test("ignores a root session without a parent", () => {
    const state = createSubagentState();
    expect(applySubagentEvent(state, { type: "session.created", created: 1, data: { sessionID: "ses_root" } })).toBe(false);
    expect(Object.keys(state.children)).toHaveLength(0);
  });

  test("never registers a session as its own child", () => {
    const state = createSubagentState();
    expect(
      applySubagentEvent(state, { type: "session.created", created: 1, data: { sessionID: "ses_x", parentID: "ses_x" } })
    ).toBe(false);
  });

  test("marks a subagent done on session.idle and errored on session.execution.failed", () => {
    const state = createSubagentState();
    applySubagentEvent(state, created());
    applySubagentEvent(state, { type: "session.idle", created: 2, data: { sessionID: "ses_child" } });
    expect(state.children["ses_child"]?.status).toBe("done");

    applySubagentEvent(state, created());
    applySubagentEvent(state, {
      type: "session.execution.failed",
      created: 3,
      data: { sessionID: "ses_child", error: { type: "x", message: "boom" } }
    });
    expect(state.children["ses_child"]?.status).toBe("error");
  });

  test("updates tokens from session.usage.updated", () => {
    const state = createSubagentState();
    applySubagentEvent(state, created());
    applySubagentEvent(state, {
      type: "session.usage.updated",
      created: 4,
      data: { sessionID: "ses_child", tokens: { input: 10, output: 20, reasoning: 5, cache: { read: 1, write: 2 } } }
    });
    expect(state.children["ses_child"]?.tokens?.total).toBe(38);
  });

  test("ignores partial events without throwing", () => {
    const state = createSubagentState();
    expect(applySubagentEvent(state, { type: "session.idle" })).toBe(false);
    expect(applySubagentEvent(state, undefined)).toBe(false);
    expect(applySubagentEvent(state, { type: "session.created", data: { parentID: "ses_root" } })).toBe(false);
    expect(getSubagentSidebarModel(state, "ses_root")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/subagents.test.ts`
Expected: FAIL — the old extractors do not understand `{ type, data }`.

- [ ] **Step 3: Replace the extraction section of `src/subagents.ts`**

Delete `EventLike`, `extractTaskToolSubagent`, `taskToolStatus`, `sessionIdFromTaskOutput`, `extractSubagent`, `updateExistingSubagent`, `statusFromEvent`, and `agentTitle`. Replace `applySubagentEvent` and add helpers:

```ts
function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function eventData(event: unknown): { type: string; created: number; data: Record<string, unknown> } | undefined {
  if (!isRecord(event)) return undefined;
  const type = asString(event.type);
  if (!type) return undefined;
  return {
    type,
    created: asNumber(event.created) ?? Date.now(),
    data: isRecord(event.data) ? event.data : {}
  };
}

export function applySubagentEvent(state: SubagentState, event: unknown): boolean {
  const parsed = eventData(event);
  if (!parsed) return false;
  const { type, created, data } = parsed;
  const sessionID = asString(data.sessionID);

  if (type === "session.created") {
    const parentID = asString(data.parentID);
    if (!sessionID || !parentID || sessionID === parentID) return false;
    if (state.children[sessionID]) return false;
    const startedAt = new Date(created).toISOString();
    state.children[sessionID] = {
      id: sessionID,
      parentID,
      title: asString(data.title) ?? asString(data.agent) ?? "subagent",
      status: "running",
      startedAt,
      updatedAt: startedAt
    };
    state.totalExecuted += 1;
    return true;
  }

  if (!sessionID) return false;
  const previous = state.children[sessionID];
  if (!previous) return false;

  if (type === "session.renamed") {
    const title = asString(data.title);
    if (!title || title === previous.title) return false;
    state.children[sessionID] = { ...previous, title, updatedAt: new Date(created).toISOString() };
    return true;
  }

  if (type === "session.status") {
    const statusType = isRecord(data.status) ? asString(data.status.type) : undefined;
    const next = statusType === "busy" || statusType === "retry" ? "running" : "done";
    return setStatus(state, previous, next, created);
  }

  if (type === "session.idle") {
    return setStatus(state, previous, "done", created);
  }

  if (type === "session.execution.failed") {
    return setStatus(state, previous, "error", created);
  }

  if (type === "session.usage.updated" || type === "session.step.ended") {
    const tokens = extractTokens(data.tokens) ?? previous.tokens;
    const updatedAt = new Date(created).toISOString();
    state.children[sessionID] = {
      ...previous,
      updatedAt,
      tokens,
      elapsedMs: elapsedMs(previous.startedAt, previous.endedAt ?? updatedAt)
    };
    return true;
  }

  return false;
}

function setStatus(state: SubagentState, previous: SubagentInfo, status: SubagentStatus, created: number): boolean {
  if (previous.status === status) return false;
  const timestamp = new Date(created).toISOString();
  const terminal = status === "done" || status === "error";
  state.children[previous.id] = {
    ...previous,
    status,
    updatedAt: timestamp,
    endedAt: terminal ? previous.endedAt ?? timestamp : previous.endedAt,
    elapsedMs: elapsedMs(previous.startedAt, terminal ? previous.endedAt ?? timestamp : timestamp)
  };
  return true;
}
```

`extractTokens`, `compactUndefined`, `formatContext`, `formatUsage`, `formatSubagentDuration`, `formatDuration`, `statusSortRank`, `formatSubagentTitle`, `truncateMiddle`, `elapsedMs`, `isTerminalStatus` stay. Remove the now-unused `numberFromPath`. Keep `isRecord`/`asString`/`asNumber` as the single definitions (delete any duplicates).

- [ ] **Step 4: Run tests and typecheck**

Run: `npx vitest run test/subagents.test.ts && npm run typecheck`
Expected: PASS. If `src/tui.tsx` typechecks are broken by removed helpers, it will be fixed in Task 5.

- [ ] **Step 5: Commit**

```bash
git add src/subagents.ts test/subagents.test.ts
git commit -m "feat: extract subagents from V2 session events"
```

---

### Task 4: Add the V2 event bridge

Add `src/events.ts`, a pure dispatcher that maps a V2 event onto the existing metrics/activity/subagents state and reports which domains changed. This is the highest-risk mapping, so it is isolated and unit-tested.

**Files:**
- Create: `src/events.ts`
- Test: `test/events.test.ts`

**Interfaces:**
- Consumes: `recordAssistantDelta`, `recordAssistantMessage`, `recordToolActivity`, `type MetricsState`, `type AssistantResponseUsage` from `./metrics.js`; `recordChild`, `recordCompaction`, `recordStep`, `type ActivityState` from `./activity.js`; `applySubagentEvent`, `type SubagentState` from `./subagents.js`; `createGoProviderTracker` from `./go-usage.js`; `createCopilotProviderTracker` from `./copilot-usage.js`.
- Produces:
  - `type InsightState = { metrics: MetricsState; activity: ActivityState; subagents: SubagentState; goProviders: ReturnType<typeof createGoProviderTracker>; copilotProviders: ReturnType<typeof createCopilotProviderTracker>; stepStartedAt: Record<string, number>; stepUsageByMessage: Record<string, Required<AssistantResponseUsage> | undefined>; toolNameById: Record<string, string> }`
  - `type InsightEventResult = { metrics: boolean; activity: boolean; subagents: boolean; providers: boolean }`
  - `createInsightState(parts: { metrics; activity; subagents; goProviders; copilotProviders }): InsightState`
  - `applyInsightEvent(state: InsightState, event: unknown): InsightEventResult`

Mapping decisions (pin these in code comments):

- `session.text.delta` → `recordAssistantDelta`.
- `session.step.started` → remember `started`; `recordAssistantMessage({ createdAt })` to open timing; `recordStep(activity, sessionID, event.id)`.
- `session.step.ended` → accumulate `output`/`reasoning` and keep the latest `input`/`cache` snapshot for `assistantMessageID`. Record once per message only when `finish !== "tool-calls"` (terminal step), using the accumulated usage and `completedAt = created`. This avoids double-counting multi-step messages.
- `session.tool.input.started` → `recordToolActivity` + `recordToolPart` (running) using `data.name`.
- `session.tool.success` / `session.tool.failed` → `recordToolPart` using the remembered `toolNameById[data.id]`, falling back to `"tool"`.
- `session.compaction.started` → `recordCompaction(activity, sessionID, event.id, reason === "auto")`.
- `session.created` → `recordChild` if `data.parentID`, title, provider trackers from `data.model.providerID`, and `applySubagentEvent`.
- `session.renamed` → title.
- `session.status` / `session.idle` / `session.execution.failed` / `session.usage.updated` → `applySubagentEvent`.
- `session.model.selected` and `session.step.started` → provider trackers from `data.model.providerID`.

- [ ] **Step 1: Write the failing test**

Create `test/events.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import { createActivityState } from "../src/activity.js";
import { createCopilotProviderTracker } from "../src/copilot-usage.js";
import { applyInsightEvent, createInsightState } from "../src/events.js";
import { createGoProviderTracker } from "../src/go-usage.js";
import { createMetricsState } from "../src/metrics.js";
import { createSubagentState } from "../src/subagents.js";

function state() {
  const activity = createActivityState();
  const subagents = createSubagentState(activity);
  return {
    state: createInsightState({
      metrics: createMetricsState(),
      activity,
      subagents,
      goProviders: createGoProviderTracker(),
      copilotProviders: createCopilotProviderTracker()
    }),
    activity,
    subagents
  };
}

describe("applyInsightEvent", () => {
  test("records text deltas as metrics", () => {
    const { state: s } = state();
    const result = applyInsightEvent(s, {
      type: "session.text.delta",
      created: 100,
      data: { sessionID: "ses_a", assistantMessageID: "msg_1", delta: "hello world" }
    });
    expect(result.metrics).toBe(true);
    expect(s.metrics.streamSamplesByMessageID["msg_1"]?.length).toBe(1);
  });

  test("does not double-count tokens across multiple steps of one assistant message", () => {
    const { state: s } = state();
    applyInsightEvent(s, {
      type: "session.step.started",
      created: 1,
      data: { sessionID: "ses_a", assistantMessageID: "msg_1", model: { providerID: "opencode-go" }, started: 1 }
    });
    applyInsightEvent(s, {
      type: "session.step.ended",
      created: 10,
      data: {
        sessionID: "ses_a",
        assistantMessageID: "msg_1",
        finish: "tool-calls",
        tokens: { input: 5, output: 3, reasoning: 1, cache: { read: 0, write: 0 } }
      }
    });
    applyInsightEvent(s, {
      type: "session.step.ended",
      created: 20,
      data: {
        sessionID: "ses_a",
        assistantMessageID: "msg_1",
        finish: "stop",
        tokens: { input: 8, output: 4, reasoning: 2, cache: { read: 1, write: 1 } }
      }
    });

    const usage = s.metrics.responseUsageByMessageID["msg_1"];
    expect(usage?.usage.outputTokens).toBe(7);
    expect(usage?.usage.reasoningTokens).toBe(3);
    expect(usage?.usage.inputTokens).toBe(8);
  });

  test("records tools and compactions as activity", () => {
    const { state: s, activity } = state();
    applyInsightEvent(s, {
      type: "session.tool.input.started",
      created: 1,
      data: { sessionID: "ses_a", assistantMessageID: "msg_1", id: "t1", name: "read" }
    });
    applyInsightEvent(s, {
      type: "session.tool.failed",
      created: 2,
      data: { sessionID: "ses_a", assistantMessageID: "msg_1", id: "t1", error: { type: "x", message: "denied" } }
    });
    applyInsightEvent(s, {
      type: "session.compaction.started",
      created: 3,
      id: "evt_compact",
      data: { sessionID: "ses_a", reason: "auto" }
    });

    expect(activity.bySessionID["ses_a"]?.toolCalls).toBe(1);
    expect(activity.bySessionID["ses_a"]?.warnings).toBe(1);
    expect(activity.bySessionID["ses_a"]?.autoCompacts).toBe(1);
  });

  test("records child sessions, titles, and providers on session.created", () => {
    const { state: s, activity, subagents } = state();
    const result = applyInsightEvent(s, {
      type: "session.created",
      created: 1,
      data: {
        sessionID: "ses_child",
        parentID: "ses_root",
        title: "Child",
        model: { providerID: "github-copilot" }
      }
    });

    expect(result.providers).toBe(true);
    expect(result.subagents).toBe(true);
    expect(activity.childrenByParent["ses_root"]).toEqual(["ses_child"]);
    expect(activity.titles["ses_child"]).toBe("Child");
    expect(subagents.children["ses_child"]?.status).toBe("running");
    expect(s.copilotProviders.usesCopilot("ses_child")).toBe(true);
    expect(s.goProviders.usesOpenCodeGo("ses_child")).toBe(false);
  });

  test("ignores malformed events without throwing", () => {
    const { state: s } = state();
    for (const bad of [undefined, {}, { type: 3 }, { type: "session.text.delta" }, { type: "session.text.delta", data: {} }, { type: "session.step.ended", data: { sessionID: "ses_a", assistantMessageID: "m" } }]) {
      expect(() => applyInsightEvent(s, bad)).not.toThrow();
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/events.test.ts`
Expected: FAIL — cannot resolve `../src/events.js`.

- [ ] **Step 3: Create `src/events.ts`**

First, export the tracker types the bridge references. Add to `src/go-usage.ts`:

```ts
export type GoProviderTracker = ReturnType<typeof createGoProviderTracker>;
```

and to `src/copilot-usage.ts`:

```ts
export type CopilotProviderTracker = ReturnType<typeof createCopilotProviderTracker>;
```

```ts
import { recordChild, recordCompaction, recordStep, recordToolPart, type ActivityState } from "./activity.js";
import type { CopilotProviderTracker } from "./copilot-usage.js";
import type { GoProviderTracker } from "./go-usage.js";
import {
  recordAssistantDelta,
  recordAssistantMessage,
  recordToolActivity,
  type AssistantResponseUsage,
  type MetricsState
} from "./metrics.js";
import { applySubagentEvent, type SubagentState } from "./subagents.js";

export type InsightState = {
  metrics: MetricsState;
  activity: ActivityState;
  subagents: SubagentState;
  goProviders: GoProviderTracker;
  copilotProviders: CopilotProviderTracker;
  stepStartedAt: Record<string, number>;
  stepUsageByMessage: Record<string, AssistantResponseUsage | undefined>;
  toolNameById: Record<string, string>;
};

export type InsightEventResult = {
  metrics: boolean;
  activity: boolean;
  subagents: boolean;
  providers: boolean;
};

export function createInsightState(parts: {
  metrics: MetricsState;
  activity: ActivityState;
  subagents: SubagentState;
  goProviders: GoProviderTracker;
  copilotProviders: CopilotProviderTracker;
}): InsightState {
  return {
    ...parts,
    stepStartedAt: {},
    stepUsageByMessage: {},
    toolNameById: {}
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function tokenUsage(value: unknown): Required<AssistantResponseUsage> | undefined {
  if (!isRecord(value)) return undefined;
  const cache = isRecord(value.cache) ? value.cache : {};
  const fields = {
    inputTokens: num(value.input),
    outputTokens: num(value.output),
    reasoningTokens: num(value.reasoning),
    cacheReadTokens: num(cache.read),
    cacheWriteTokens: num(cache.write)
  };
  if (Object.values(fields).every((item) => item === undefined)) return undefined;
  return {
    inputTokens: fields.inputTokens ?? 0,
    outputTokens: fields.outputTokens ?? 0,
    reasoningTokens: fields.reasoningTokens ?? 0,
    cacheReadTokens: fields.cacheReadTokens ?? 0,
    cacheWriteTokens: fields.cacheWriteTokens ?? 0
  };
}

function providerFrom(data: Record<string, unknown>): string | undefined {
  const model = isRecord(data.model) ? data.model : undefined;
  return model ? str(model.providerID) : undefined;
}

export function applyInsightEvent(state: InsightState, event: unknown): InsightEventResult {
  const result: InsightEventResult = { metrics: false, activity: false, subagents: false, providers: false };
  if (!isRecord(event)) return result;
  const type = str(event.type);
  if (!type) return result;
  const created = num(event.created) ?? Date.now();
  const data = isRecord(event.data) ? event.data : {};
  const sessionID = str(data.sessionID);
  const messageID = str(data.assistantMessageID);

  const recordProvider = (sessionKey: string | undefined, providerID: string | undefined) => {
    if (!sessionKey || !providerID) return;
    state.goProviders.record(sessionKey, providerID);
    state.copilotProviders.record(sessionKey, providerID);
    result.providers = true;
  };

  switch (type) {
    case "session.text.delta": {
      const delta = str(data.delta);
      if (!sessionID || !messageID || delta === undefined) break;
      recordAssistantDelta(state.metrics, { sessionID, messageID, delta, at: created });
      result.metrics = true;
      break;
    }
    case "session.step.started": {
      if (!sessionID || !messageID) break;
      const started = num(data.started) ?? created;
      state.stepStartedAt[messageID] = started;
      recordAssistantMessage(state.metrics, { sessionID, messageID, createdAt: started });
      recordProvider(sessionID, providerFrom(data));
      const stepID = str(event.id);
      if (stepID !== undefined && recordStep(state.activity, sessionID, stepID)) result.activity = true;
      result.metrics = true;
      break;
    }
    case "session.step.ended": {
      if (!sessionID || !messageID) break;
      const step = tokenUsage(data.tokens);
      if (step) {
        const previous = state.stepUsageByMessage[messageID];
        state.stepUsageByMessage[messageID] = {
          inputTokens: step.inputTokens,
          cacheReadTokens: step.cacheReadTokens,
          cacheWriteTokens: step.cacheWriteTokens,
          outputTokens: (previous?.outputTokens ?? 0) + step.outputTokens,
          reasoningTokens: (previous?.reasoningTokens ?? 0) + step.reasoningTokens
        };
      }
      const finish = str(data.finish);
      if (finish === "tool-calls") break;
      const usage = state.stepUsageByMessage[messageID] ?? {};
      recordAssistantMessage(state.metrics, {
        sessionID,
        messageID,
        createdAt: state.stepStartedAt[messageID] ?? created,
        completedAt: created,
        ...(usage.inputTokens !== undefined ? { inputTokens: usage.inputTokens } : {}),
        ...(usage.outputTokens !== undefined ? { outputTokens: usage.outputTokens } : {}),
        ...(usage.reasoningTokens !== undefined ? { reasoningTokens: usage.reasoningTokens } : {}),
        ...(usage.cacheReadTokens !== undefined ? { cacheReadTokens: usage.cacheReadTokens } : {}),
        ...(usage.cacheWriteTokens !== undefined ? { cacheWriteTokens: usage.cacheWriteTokens } : {}),
        ...(finish !== undefined ? { finish } : {})
      });
      result.metrics = true;
      break;
    }
    case "session.tool.input.started": {
      const toolID = str(data.id);
      const name = str(data.name) ?? "tool";
      if (!sessionID || !toolID) break;
      state.toolNameById[toolID] = name;
      recordToolActivity(state.metrics, sessionID, messageID ?? "");
      if (recordToolPart(state.activity, sessionID, { id: toolID, tool: name, state: { status: "running" } })) {
        result.activity = true;
      }
      result.metrics = true;
      break;
    }
    case "session.tool.called":
    case "session.tool.success":
    case "session.tool.failed": {
      const toolID = str(data.id);
      if (!sessionID || !toolID) break;
      const name = state.toolNameById[toolID] ?? "tool";
      const error = isRecord(data.error) ? str(data.error.message) : undefined;
      const status = type === "session.tool.failed" ? "error" : type === "session.tool.success" ? "completed" : "running";
      recordToolActivity(state.metrics, sessionID, messageID ?? "");
      if (recordToolPart(state.activity, sessionID, {
        id: toolID,
        tool: name,
        ...(status === "running" ? {} : { state: { status, ...(error ? { error } : {}) } })
      })) {
        result.activity = true;
      }
      result.metrics = true;
      break;
    }
    case "session.compaction.started": {
      const id = str(event.id);
      if (!sessionID || !id) break;
      if (recordCompaction(state.activity, sessionID, id, data.reason === "auto")) result.activity = true;
      break;
    }
    case "session.created": {
      if (!sessionID) break;
      const parentID = str(data.parentID);
      const title = str(data.title);
      if (title) state.activity.titles[sessionID] = title;
      if (parentID) recordChild(state.activity, sessionID, parentID);
      recordProvider(sessionID, providerFrom(data));
      if (applySubagentEvent(state.subagents, event)) result.subagents = true;
      break;
    }
    case "session.renamed": {
      if (!sessionID) break;
      const title = str(data.title);
      if (title) state.activity.titles[sessionID] = title;
      if (applySubagentEvent(state.subagents, event)) result.subagents = true;
      break;
    }
    case "session.status":
    case "session.idle":
    case "session.execution.failed":
    case "session.usage.updated": {
      if (applySubagentEvent(state.subagents, event)) result.subagents = true;
      break;
    }
    case "session.model.selected": {
      recordProvider(sessionID, providerFrom(data));
      break;
    }
    default:
      break;
  }

  return result;
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `npx vitest run test/events.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/events.ts test/events.test.ts
git commit -m "feat: add V2 event to state bridge"
```

---

### Task 5: V2 plugin shell, slots, Token Usage, and prompt-right metrics

Rewrite `src/tui.tsx` as a V2 CLI plugin: `Plugin.define`, state, one `context.data.listen` subscription, one shared 1s ticker, the `sidebar.content` and `prompt.footer.status` claims, and the Token Usage + prompt-right components. The remaining sections are added in Tasks 6–8.

**Files:**
- Modify: `src/tui.tsx` (full rewrite)
- Modify: `package.json` (add `@opencode/plugin` dependency; keep `@opencode-ai/plugin` until Task 9)
- Modify: `tsup.config.ts` (add `"@opencode/plugin"`, `"@opencode/plugin/tui"` to `external`)
- Test: `test/tui.test.ts` (full rewrite as a source-level smoke test)

**Interfaces:**
- Consumes: everything produced by Tasks 1–4; `context.data.listen`, `context.ui.slot`, `context.data.session.status`.
- Produces: global `tui` definition with `id = "opencode-insights"`, `setup(context)`, default export.

- [ ] **Step 1: Write the failing smoke test**

Replace `test/tui.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

const source = () => readFileSync(new URL("../src/tui.tsx", import.meta.url), "utf8");

describe("V2 TUI plugin shell", () => {
  test("defines the plugin with the stable id", () => {
    expect(source()).toContain("Plugin.define({");
    expect(source()).toContain('id: "opencode-insights"');
  });

  test("subscribes to V2 events and registers both slots", () => {
    expect(source()).toContain("context.data.listen(");
    expect(source()).toContain('append: "sidebar.content"');
    expect(source()).toContain('append: "prompt.footer.status"');
  });

  test("does not use the removed V1 plugin API", () => {
    const text = source();
    expect(text).not.toContain("@opencode-ai/plugin");
    expect(text).not.toContain("api.event.on");
    expect(text).not.toContain("api.theme.current");
  });

  test("renders prompt-right metrics and token usage", () => {
    expect(source()).toContain("PromptRight");
    expect(source()).toContain("renderPromptRightMetricsText");
    expect(source()).toContain("renderSessionTokenUsage");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/tui.test.ts`
Expected: FAIL — the current file still uses `@opencode-ai/plugin`.

- [ ] **Step 3: Add the dependency and externals**

`package.json`: add `"@opencode/plugin": "^2.0.11"` under `dependencies` (leave `@opencode-ai/plugin` in `devDependencies` for now).

`tsup.config.ts` `external`: add `"@opencode/plugin"` and `"@opencode/plugin/tui"`.

- [ ] **Step 4: Rewrite `src/tui.tsx`**

```tsx
/** @jsxImportSource @opentui/solid */
import { createTextAttributes } from "@opentui/core";
import { Plugin, usePlugin } from "@opencode/plugin/tui";
import type { Context } from "@opencode/plugin/tui/context";
import { createMemo, createSignal, For, Show, type JSX } from "solid-js";
import { readInsightsConfig, type InsightsConfig } from "./config.js";
import { createMetricsState, renderPromptRightMetricsText, renderSessionTokenUsage } from "./metrics.js";
import { hydrateActivity } from "./activity-hydrate.js";
import { createActivityState } from "./activity.js";
import { createSubagentState, sumSubagentTokens } from "./subagents.js";
import { createGoProviderTracker } from "./go-usage.js";
import { createCopilotProviderTracker } from "./copilot-usage.js";
import { applyInsightEvent, createInsightState, type InsightState } from "./events.js";

const bold = createTextAttributes({ bold: true });

function isSessionID(value: string | undefined): value is string {
  return typeof value === "string" && value.startsWith("ses");
}

function Section(props: {
  title: string;
  collapsed: boolean;
  onToggle: () => void;
  children: JSX.Element;
}) {
  return (
    <box flexDirection="column">
      <text attributes={bold} onMouseDown={props.onToggle}>
        {`${props.collapsed ? "▶" : "▼"} ${props.title}`}
      </text>
      <Show when={!props.collapsed}>{props.children}</Show>
    </box>
  );
}

function TokenUsageSection(props: { sessionID: string; state: InsightState; version: number }) {
  const theme = usePlugin().theme;
  const [collapsed, setCollapsed] = createSignal(false);
  const lines = createMemo(() => {
    props.version;
    const subagents = sumSubagentTokens(props.state.subagents, props.sessionID);
    const content = renderSessionTokenUsage(props.state.metrics, props.sessionID, subagents);
    return content.length > 0 ? content.split("\n") : [];
  });

  return (
    <Show when={lines().length > 0}>
      <Section
        title={lines()[0] ?? "Token Usage"}
        collapsed={collapsed()}
        onToggle={() => setCollapsed((value) => !value)}
      >
        <For each={lines().slice(1)}>{(line) => <text fg={theme.text.muted}>{line}</text>}</For>
      </Section>
    </Show>
  );
}

function PromptRight(props: { sessionID: string; mode: string; status: "idle" | "running"; state: InsightState; version: number; config: InsightsConfig }) {
  const theme = usePlugin().theme;
  const text = createMemo(() => {
    props.version;
    if (!isSessionID(props.sessionID) || props.mode === "shell") return "";
    return renderPromptRightMetricsText(props.state.metrics, props.sessionID, {
      idle: props.status === "idle",
      metrics: props.config.promptRightMetrics
    });
  });

  return <Show when={text().length > 0}><text fg={theme.text.muted}>{text()}</text></Show>;
}

async function setup(context: Context) {
  const config = await readInsightsConfig({ dataDir: context.options.dataDir });
  const activity = createActivityState();
  const state = createInsightState({
    metrics: createMetricsState(),
    activity,
    subagents: createSubagentState(activity),
    goProviders: createGoProviderTracker(),
    copilotProviders: createCopilotProviderTracker()
  });

  const [metricsRev, setMetricsRev] = createSignal(0);
  const [activityRev, setActivityRev] = createSignal(0);
  const [subagentsRev, setSubagentsRev] = createSignal(0);
  const [now, setNow] = createSignal(Date.now());
  const ticker = setInterval(() => setNow(Date.now()), 1_000);

  const stop = context.data.listen(({ details }) => {
    let result;
    try {
      result = applyInsightEvent(state, details);
    } catch {
      return;
    }
    if (result.metrics) setMetricsRev((value) => value + 1);
    if (result.activity) setActivityRev((value) => value + 1);
    if (result.subagents) setSubagentsRev((value) => value + 1);
  });

  const hydrated = new Set<string>();
  const hydrate = (sessionID: string) => {
    if (!isSessionID(sessionID) || hydrated.has(sessionID)) return;
    hydrated.add(sessionID);
    void hydrateActivity(context.data, activity, sessionID)
      .then(() => setActivityRev((value) => value + 1))
      .catch(() => hydrated.delete(sessionID));
  };

  const unregisterSidebar = context.ui.slot({
    append: "sidebar.content",
    render: (input) => (
      <box flexDirection="column">
        <TokenUsageSection
          sessionID={input.sessionID}
          state={state}
          version={metricsRev() + activityRev() + subagentsRev() + now()}
        />
      </box>
    )
  });

  const unregisterPrompt = context.ui.slot({
    append: "prompt.footer.status",
    render: (input) => (
      <PromptRight
        sessionID={input.sessionID ?? ""}
        mode={input.mode}
        status={input.sessionID ? context.data.session.status(input.sessionID) : "idle"}
        state={state}
        version={metricsRev() + now()}
        config={config}
      />
    )
  });

  return () => {
    stop();
    clearInterval(ticker);
    unregisterSidebar();
    unregisterPrompt();
  };
}

const tui = Plugin.define({ id: "opencode-insights", setup });

export { tui };
export default tui;
```

- [ ] **Step 5: Run tests and typecheck**

Run: `npx vitest run test/tui.test.ts && npm run typecheck`
Expected: PASS. Delete the now-obsolete assertions in `test/entrypoints.test.ts` that read `src/tui.tsx` for `api.route.navigate`, `api.theme.current.backgroundElement`, and `toggleTokenUsage` (those components move to Tasks 6–8); keep the `src/index.ts` assertions.

- [ ] **Step 6: Build**

Run: `npm run build`
Expected: PASS — `dist/tui.js` and `dist/tui.d.ts` produced.

- [ ] **Step 7: Commit**

```bash
git add src/tui.tsx package.json tsup.config.ts test/tui.test.ts test/entrypoints.test.ts
git commit -m "feat: V2 TUI shell with token usage and prompt metrics"
```

---

### Task 6: Session Analysis sidebar and dialog

Add the Session Analysis section (collapsible brief rows, click opens a dialog with collapsible groups) using `context.ui.dialog.show`/`set`/`clear`.

**Files:**
- Modify: `src/tui.tsx`
- Test: `test/tui.test.ts`

**Interfaces:**
- Consumes: `treeActivity`, `treeLoading`, `treeSubagentCount`, `formatActivityBriefRows`, `buildSessionAnalysisRows`, `type ActivityState`, `type SessionAnalysisRow` from `./activity.js`; `context.ui.dialog`.
- Produces: `SessionAnalysisSection(props: { sessionID: string; state: InsightState; version: number; onHydrate: () => void })` and `SessionAnalysisDialog(props: { sessionID: string; state: InsightState })`.

- [ ] **Step 1: Extend the smoke test**

Add to `test/tui.test.ts`:

```ts
  test("renders the session analysis sidebar and dialog", () => {
    const text = source();
    expect(text).toContain("SessionAnalysisSection");
    expect(text).toContain("SessionAnalysisDialog");
    expect(text).toContain("buildSessionAnalysisRows");
    expect(text).toContain("context.ui.dialog.show(");
    expect(text).toContain('context.ui.dialog.set({ size: "large" })');
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/tui.test.ts`
Expected: FAIL — identifiers absent.

- [ ] **Step 3: Implement the section and dialog**

Add to `src/tui.tsx`. Extend the `solid-js` import with `onMount`, and add `buildSessionAnalysisRows`, `formatActivityBriefRows`, `treeActivity`, `treeLoading`, `treeSubagentCount` to the `./activity.js` import:

```tsx
function SessionAnalysisSection(props: {
  sessionID: string;
  state: InsightState;
  version: number;
  onHydrate: () => void;
}) {
  const context = usePlugin();
  const theme = context.theme;
  const [collapsedGroups, setCollapsedGroups] = createSignal<Set<string>>(new Set());

  onMount(props.onHydrate);

  const lines = createMemo(() => {
    props.version;
    const tree = treeActivity(props.state.activity, props.sessionID);
    const loading = treeLoading(props.state.activity, props.sessionID);
    const rows = formatActivityBriefRows(tree, treeSubagentCount(props.state.activity, props.sessionID));
    return loading && rows.length === 0 ? ["loading…"] : rows;
  });

  const toggleGroup = (key: string) => {
    setCollapsedGroups((previous) => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const openDialog = () => {
    context.ui.dialog.set({ size: "large" });
    context.ui.dialog.show(() => (
      <SessionAnalysisDialog
        sessionID={props.sessionID}
        state={props.state}
        collapsedGroups={collapsedGroups()}
        onToggleGroup={toggleGroup}
      />
    ));
  };

  return (
    <Show when={lines().length > 0}>
      <box flexDirection="column">
        <text attributes={bold} onMouseUp={openDialog}>
          {"Session Analysis"}
        </text>
        <For each={lines()}>{(line) => <text fg={theme.text.muted}>{line}</text>}</For>
      </box>
    </Show>
  );
}

function SessionAnalysisDialog(props: {
  sessionID: string;
  state: InsightState;
  collapsedGroups: Set<string>;
  onToggleGroup: (key: string) => void;
}) {
  const context = usePlugin();
  const theme = context.theme;
  const rows = createMemo(() => buildSessionAnalysisRows(props.state.activity, props.sessionID));
  const visible = createMemo<SessionAnalysisRow[]>(() => {
    const result: SessionAnalysisRow[] = [];
    let header: string | undefined;
    for (const row of rows()) {
      if (row.header) {
        header = row.text;
        result.push({ text: `${props.collapsedGroups.has(row.text) ? "▶" : "▾"} ${row.text}`, header: true, key: row.text });
      } else if (header === undefined || !props.collapsedGroups.has(header)) {
        result.push(row);
      }
    }
    return result;
  });

  return (
    <box flexDirection="column" flexGrow={1} paddingLeft={4} paddingRight={4} paddingTop={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={bold}>{"Session Analysis"}</text>
        <text fg={theme.text.muted} onMouseUp={() => context.ui.dialog.clear()}>{"esc"}</text>
      </box>
      <scrollbox flexGrow={1} paddingTop={1}>
        <For each={visible()}>
          {(row) => (
            <text
              fg={row.header ? theme.text.base : theme.text.muted}
              {...(row.header ? { attributes: bold } : {})}
              {...(row.header && row.key ? { onMouseUp: () => props.onToggleGroup(row.key ?? "") } : {})}
            >
              {row.text}
            </text>
          )}
        </For>
      </scrollbox>
    </box>
  );
}
```

Wire it into the slot just above `<TokenUsageSection …/>`:

```tsx
          <SessionAnalysisSection
            sessionID={input.sessionID}
            state={state}
            version={activityRev() + now()}
            onHydrate={() => hydrate(input.sessionID)}
          />
```

- [ ] **Step 4: Run tests and typecheck**

Run: `npx vitest run test/tui.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tui.tsx test/tui.test.ts
git commit -m "feat: session analysis sidebar and dialog on V2"
```

---

### Task 7: Subagents sidebar

Add the Subagents section. Each row is its own `<text>` (hover highlight via a signal, click navigates with the router) — no line arithmetic.

**Files:**
- Modify: `src/tui.tsx`
- Test: `test/tui.test.ts`

**Interfaces:**
- Consumes: `getSubagentSidebarModel`, `type SubagentSidebarRow` from `./subagents.js`; `context.ui.router.navigate`.
- Produces: `SubagentsSection(props: { sessionID: string; state: InsightState; version: number })`.

- [ ] **Step 1: Extend the smoke test**

```ts
  test("renders subagents with router navigation and hover", () => {
    const text = source();
    expect(text).toContain("SubagentsSection");
    expect(text).toContain("getSubagentSidebarModel");
    expect(text).toContain("context.ui.router.navigate({ type: \"session\", sessionID: row.id })");
    expect(text).toContain("onMouseMove");
    expect(text).toContain("theme.background.raised.base");
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/tui.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement the section**

Add imports `getSubagentSidebarModel` from `./subagents.js`, then:

```tsx
function SubagentsSection(props: { sessionID: string; state: InsightState; version: number }) {
  const context = usePlugin();
  const theme = context.theme;
  const [collapsed, setCollapsed] = createSignal(false);
  const [hovered, setHovered] = createSignal<string | undefined>();
  const model = createMemo(() => {
    props.version;
    return getSubagentSidebarModel(props.state.subagents, props.sessionID, { now: Date.now() });
  });

  return (
    <Show when={model()}>
      {(value) => (
        <box flexDirection="column">
          <text attributes={bold} onMouseDown={() => setCollapsed((current) => !current)}>
            {`${collapsed() ? "▶" : "▼"} ${value().title}`}
          </text>
          <Show when={!collapsed()}>
            <text fg={theme.text.muted}>{value().summary}</text>
            <For each={value().rows}>
              {(row) => (
                <box
                  flexDirection="row"
                  backgroundColor={hovered() === row.id ? theme.background.raised.base : undefined}
                  onMouseMove={() => setHovered(row.id)}
                  onMouseOut={() => setHovered(undefined)}
                  onMouseUp={() => context.ui.router.navigate({ type: "session", sessionID: row.id })}
                >
                  <text fg={row.status === "running" ? theme.text.feedback.success.base : row.status === "error" ? theme.text.feedback.error.base : theme.text.muted}>
                    {"• "}
                  </text>
                  <box flexDirection="column">
                    <text fg={theme.text.base}>{row.title}</text>
                    <text fg={theme.text.muted}>{row.subtitle}</text>
                  </box>
                </box>
              )}
            </For>
          </Show>
        </box>
      )}
    </Show>
  );
}
```

Wire it at the bottom of the sidebar slot:

```tsx
          <SubagentsSection sessionID={input.sessionID} state={state} version={subagentsRev() + now()} />
```

- [ ] **Step 4: Run tests and typecheck**

Run: `npx vitest run test/tui.test.ts && npm run typecheck`
Expected: PASS. If `backgroundColor` requires a different prop name in `@opentui/solid`, use `bg` instead (verify against the Go/Copilot components in Task 8 which also need background handling; the existing V1 code used `backgroundElement` as a chunk bg).

- [ ] **Step 5: Commit**

```bash
git add src/tui.tsx test/tui.test.ts
git commit -m "feat: reactive subagents sidebar on V2"
```

---

### Task 8: Go Usage and Copilot Usage sidebars

Add the two provider-gated usage sections. Visibility is driven by `goUsageSectionVisible`/`copilotUsageSectionVisible`; refreshes happen from a `createEffect` on visibility.

**Files:**
- Modify: `src/tui.tsx`
- Modify: `src/activity-hydrate.ts` (records nothing new; only if a helper is needed)
- Test: `test/tui.test.ts`

**Interfaces:**
- Consumes: `createGoUsageRefresher`, `goUsageRows`, `goUsageSectionVisible`, `type GoUsageState` from `./go-usage.js`; `createCopilotUsageRefresher`, `copilotUsageRow`, `copilotUsageSectionVisible`, `type CopilotUsageState` from `./copilot-usage.js`.
- Produces: `GoUsageSection(props: { sessionID: string; state: InsightState; config: InsightsConfig; refresher: GoUsageRefresher; version: number })` and `CopilotUsageSection(props: { …; state: InsightState; token: string; refresher: CopilotUsageRefresher; version: number })`.

- [ ] **Step 1: Extend the smoke test**

```ts
  test("renders provider-gated Go and Copilot usage sections", () => {
    const text = source();
    expect(text).toContain("GoUsageSection");
    expect(text).toContain("CopilotUsageSection");
    expect(text).toContain("goUsageSectionVisible");
    expect(text).toContain("copilotUsageSectionVisible");
    expect(text).toContain("goUsage.usesOpenCodeGo(sessionID)");
    expect(text).toContain("copilotProviders.usesCopilot(sessionID)");
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/tui.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement both sections and wire refreshers + revisions**

Add imports (extend the `solid-js` import with `createEffect`, and add `resolveCopilotToken` to the `./config.js` import):

```tsx
import {
  createGoUsageRefresher,
  formatGoUsageRow,
  goUsageRows,
  goUsageSectionVisible,
  type GoUsageRow
} from "./go-usage.js";
import {
  copilotUsageRow,
  copilotUsageSectionVisible,
  createCopilotUsageRefresher,
  formatCopilotUsageRow
} from "./copilot-usage.js";
```

Add components:

```tsx
function GoUsageSection(props: {
  sessionID: string;
  state: InsightState;
  config: InsightsConfig;
  refresher: ReturnType<typeof createGoUsageRefresher>;
  version: number;
}) {
  const theme = usePlugin().theme;
  const [collapsed, setCollapsed] = createSignal(false);
  const visible = createMemo(() => {
    props.version;
    return goUsageSectionVisible(props.config, props.state.goProviders.usesOpenCodeGo(props.sessionID));
  });
  const rows = createMemo<GoUsageRow[] | undefined>(() => {
    props.version;
    return visible() ? goUsageRows(props.refresher.state, Date.now()) : undefined;
  });
  const error = createMemo(() => {
    props.version;
    return props.refresher.state.error;
  });

  createEffect(() => {
    if (visible()) void props.refresher.refresh();
  });

  return (
    <Show when={visible() && (rows() !== undefined || error() !== undefined)}>
      <Section title="Go Usage" collapsed={collapsed()} onToggle={() => setCollapsed((current) => !current)}>
        <Show when={error()} fallback={
          <For each={rows() ?? []}>{(row) => <text fg={theme.text.muted}>{formatGoUsageRow(row)}</text>}</For>
        }>
          {(message) => <text fg={theme.text.feedback.error.base}>{`Go usage: ${message()}`}</text>}
        </Show>
      </Section>
    </Show>
  );
}

function CopilotUsageSection(props: {
  sessionID: string;
  state: InsightState;
  config: InsightsConfig;
  token: string;
  refresher: ReturnType<typeof createCopilotUsageRefresher>;
  version: number;
}) {
  const theme = usePlugin().theme;
  const [collapsed, setCollapsed] = createSignal(false);
  const visible = createMemo(() => {
    props.version;
    return copilotUsageSectionVisible(props.config, props.token, props.state.copilotProviders.usesCopilot(props.sessionID));
  });
  const row = createMemo(() => {
    props.version;
    const data = props.refresher.state.data;
    return visible() && data ? copilotUsageRow(data, Date.now()) : undefined;
  });
  const error = createMemo(() => {
    props.version;
    return props.refresher.state.error;
  });

  createEffect(() => {
    if (visible()) void props.refresher.refresh();
  });

  return (
    <Show when={visible() && (row() !== undefined || error() !== undefined)}>
      <Section title="Copilot" collapsed={collapsed()} onToggle={() => setCollapsed((current) => !current)}>
        <Show when={error()} fallback={
          <For each={(row() ? formatCopilotUsageRow(row()!).split("\n") : [])}>
            {(line) => <text fg={theme.text.muted}>{line}</text>}
          </For>
        }>
          {(message) => <text fg={theme.text.feedback.error.base}>{`Copilot: ${message()}`}</text>}
        </Show>
      </Section>
    </Show>
  );
}
```

In `setup`, create the refreshers and revisions:

```tsx
  const token = resolveCopilotToken(config.copilotUsage);
  const goUsage = createGoUsageRefresher(config.goUsage);
  const copilotUsage = createCopilotUsageRefresher(config.copilotUsage, token);
```

Wire the sections into the sidebar slot (between Token Usage and Subagents):

```tsx
          <GoUsageSection sessionID={input.sessionID} state={state} config={config} refresher={goUsage} version={metricsRev() + now()} />
          <CopilotUsageSection sessionID={input.sessionID} state={state} config={config} token={token} refresher={copilotUsage} version={metricsRev() + now()} />
```

- [ ] **Step 4: Run tests and typecheck**

Run: `npx vitest run test/tui.test.ts && npm run typecheck`
Expected: PASS. The shared `now()` ticker already forces the Go/Copilot rows to recompute (reset countdowns), so no extra per-refresher timers are needed.

- [ ] **Step 5: Build**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/tui.tsx test/tui.test.ts
git commit -m "feat: Go and Copilot usage sections on V2"
```

---

### Task 9: Remove the V1/server/CLI/viewer surface

Delete the server plugin, capture/store, viewer, CLI, shim, and obsolete helpers and tests; remove the old dependencies; clean `package.json`/`tsup.config.ts`.

**Files:**
- Delete: `src/index.ts`, `src/capture.ts`, `src/inspect.ts`, `src/viewer.ts`, `src/cli.ts`, `src/cli-shim.ts`, `src/bun-sqlite.d.ts`, `src/listeners.ts`, `src/render-state.ts`
- Delete: `test/cli.test.ts`, `test/cli-shim.test.ts`, `test/viewer.test.ts`, `test/inspect.test.ts`, `test/capture.test.ts`, `test/plugin.test.ts`, `test/entrypoints.test.ts`
- Modify: `package.json`, `tsup.config.ts`, `tsconfig.json` (if it references removed types)

**Interfaces:**
- Consumes: nothing.
- Produces: a package whose only entry is `./tui`.

- [ ] **Step 1: Verify nothing kept imports the removed modules**

Run: `grep -rn "capture.js\|inspect.js\|viewer.js\|cli-shim\|listeners.js\|render-state.js\|index.js" src test --include='*.ts' --include='*.tsx'`
Expected: no matches outside the files being deleted. If `src/tui.tsx` still imports `readInsightsConfig` from `./capture.js`, change it to `./config.js`.

- [ ] **Step 2: Delete the files**

```bash
git rm src/index.ts src/capture.ts src/inspect.ts src/viewer.ts src/cli.ts src/cli-shim.ts src/bun-sqlite.d.ts src/listeners.ts src/render-state.ts
git rm test/cli.test.ts test/cli-shim.test.ts test/viewer.test.ts test/inspect.test.ts test/capture.test.ts test/plugin.test.ts test/entrypoints.test.ts
```

- [ ] **Step 3: Clean `package.json`**

- Remove `bin`, `postinstall`, and `prepack` (the build is still run by `publish.yml`).
- Set `"exports"` to only:

```json
  "exports": {
    "./tui": {
      "types": "./dist/tui.d.ts",
      "import": "./dist/tui.js",
      "default": "./dist/tui.js"
    }
  },
```

- Set `"main": "./dist/tui.js"`, `"types": "./dist/tui.d.ts"`.
- `dependencies`: keep `jsonc-parser`, add `"@opencode/plugin": "^2.0.11"`; remove `better-sqlite3`, `sql.js`.
- `peerDependencies`: `"@opencode/plugin": "^2.0.11"` is a dependency, so peers are `"@opentui/core": ">=0.5.10"`, `"@opentui/solid": ">=0.5.10"`, `"solid-js": ">=1.9.0"`.
- `devDependencies`: remove `@opencode-ai/plugin`, `@types/better-sqlite3`, `@types/sql.js`; keep `@opencode/plugin`, `@opentui/core`, `@opentui/solid`, `solid-js`, `tsup`, `typescript`, `vitest`, `@types/node`.

- [ ] **Step 4: Clean `tsup.config.ts`**

```ts
import { defineConfig } from "tsup";

export default defineConfig({
  entry: { tui: "src/tui.tsx" },
  format: ["esm"],
  dts: true,
  clean: true,
  sourcemap: false,
  external: ["@opencode/plugin", "@opencode/plugin/tui", "@opentui/core", "@opentui/solid", "solid-js"],
  esbuildOptions(options) {
    options.jsx = "automatic";
    options.jsxImportSource = "@opentui/solid";
  }
});
```

- [ ] **Step 5: Reinstall and run the full gate**

Run: `npm install && npm run verify`
Expected: PASS — typecheck clean, all remaining tests pass, single `dist/tui.js` built.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor: remove V1 server, capture, viewer, and CLI surface"
```

---

### Task 10: Update docs and bump to 1.0.0

**Files:**
- Modify: `README.md`, `DEVELOPMENT.md`, `AGENTS.md`, `package.json`

**Interfaces:** none.

- [ ] **Step 1: Bump the version**

In `package.json`, set `"version": "1.0.0"`.

- [ ] **Step 2: Rewrite `AGENTS.md`**

Replace the Commands/Architecture/Operational sections to reflect: no server plugin, no capture/storage/viewer/CLI; `npm run verify` is still the gate; architecture lists `src/tui.tsx` (V2 `Plugin.define`, slots, reactive sections), `src/events.ts` (V2 event bridge), `src/config.ts`, and the kept pure modules; config path `~/.opencode-insights/config.jsonc`; removal of `tui.json`/`plugin` → `plugins` references; `test/entrypoints.test.ts` no longer exists, so drop that convention note (replace it with the `test/tui.test.ts` source-smoke convention). Keep the CodeGraph block at the top.

- [ ] **Step 3: Rewrite `README.md` and `DEVELOPMENT.md`**

- README: describe the plugin as V2-only TUI sidebars; install via `~/.config/opencode/cli.json`:

```json
{
  "plugins": ["@rejacky/opencode-insights"]
}
```

  Document `config.jsonc`, the five sections, and remove capture/viewer/CLI/doctor/serve documentation. Add a breaking-change note: V1 users must stay on `0.4.x`.
- DEVELOPMENT.md: commands are `npm run verify` / `npm run typecheck` / `npm test` / `npm run build`; remove `debug`/`revert-debug` and capture/viewer instructions; describe manual V2 verification (add the local build to `cli.json`, restart OpenCode, check the sidebars).

- [ ] **Step 4: Final gate**

Run: `npm run verify`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add README.md DEVELOPMENT.md AGENTS.md package.json
git commit -m "docs: document V2-only TUI plugin and bump to 1.0.0"
```

---

## Self-Review

**Spec coverage:**

- Package/entrypoint, exports, deps, install surface → Tasks 5 and 9. ✔
- File layout (create/adapt/delete) → Tasks 1–9. ✔
- Reactive state model (shared `now`, revision signals, memos, no listener registries/polling) → Tasks 5–8, and `listeners.ts`/`render-state.ts` deleted in Task 9. ✔
- Event bridge mapping table → Task 4 covers every listed row (`session.text.delta`, `session.step.*`, `session.tool.*`, `session.compaction.started`, `session.created`, `session.renamed`, `session.status`, `session.idle`, `session.execution.failed`, `session.usage.updated`, provider from `session.model.selected`/`step.started`). `session.compaction.ended` and `session.reasoning.delta` are intentionally not consumed (compaction is counted at start; reasoning deltas don't affect current metrics). ✔
- Hydration via `Data` API and `SessionMessageAssistant.content[]` → Task 2. ✔
- Components/slots/dialog/router/theme tokens → Tasks 5–8. ✔
- Config → Task 1. ✔
- Tests (delete/keep/rewrite/add) → Tasks 2–9. ✔
- Docs & release → Task 10. ✔
- Spec deviation: the spec said `metrics.ts` unchanged; this plan keeps it unchanged and instead accumulates per-message usage in `events.ts` (Task 4). ⚠ Note this as an explicit, intentional deviation — no `metrics.ts` edit is needed.

**Placeholder scan:** The plan contains no TBD/TODO and no "similar to Task N" references; every code step shows the code to write.

**Type consistency:** `InsightState` is defined once in Task 4 and consumed unchanged in Tasks 5–8. `hydrateActivity(data, state, rootSessionID)` is defined in Task 2 and called with `context.data` in Task 5. `applySubagentEvent(state, event)` is defined in Task 3 and called from Task 4. `GoProviderTracker`/`CopilotProviderTracker` names are used in Task 4's `InsightState`; Task 4 must export or import them — add `export type GoProviderTracker = ReturnType<typeof createGoProviderTracker>` to `go-usage.ts` and `export type CopilotProviderTracker = ReturnType<typeof createCopilotProviderTracker>` to `copilot-usage.ts` as part of Task 4 Step 3.

**Review Focus coverage:** (1) partial events → Task 4 "ignores malformed events"; (2) multi-step double count → Task 4 "does not double-count"; (3) root-as-subagent → Task 3 tests; (4) provider gate → Task 4 provider test plus Tasks 8 visibility functions; (5) hydration bounds/retry → Task 2 tests (concurrency constant + un-hydrate-on-failure).
