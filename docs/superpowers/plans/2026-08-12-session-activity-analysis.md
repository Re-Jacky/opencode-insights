# Session Activity Analysis Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add per-subagent activity metrics (tool calls, tool errors, skills, auto-compactions, model steps) to the TUI: appended suffixes on subagent sidebar rows, a new collapsible "Session Analysis" sidebar section aggregating the session's whole subagent tree, and a click-to-open scrollable tree dialog.

**Architecture:** A pure `src/activity.ts` module holds `SessionActivity` records per session and an `ActivityState` with a keyed per-metric dedup set. Live `message.part.updated` events feed the state in real time; `src/activity-hydrate.ts` backfills history (`session.list()` + per-child `session.messages()`, concurrency-capped) on sidebar mount so "jump out and come back" still shows data. `src/subagents.ts` attaches the live activity record to each child and appends a suffix; `src/tui.tsx` wires events, renders `SessionAnalysisSidebar`, and opens `SessionAnalysisDialog` via `api.ui.dialog.replace`.

**Tech Stack:** TypeScript (NodeNext ESM), vitest, SolidJS + @opentui/solid for the TUI.

**Spec:** `docs/superpowers/specs/2026-08-12-session-activity-analysis-design.md`

## Global Constraints

- `ActivityState` fields (exact names — later tasks depend on them): `bySessionID: Record<string, SessionActivity>`, `childrenByParent: Record<string, string[]>`, `titles: Record<string, string>`, `hydrated: Set<string>`, `seenKeys: Record<string, Set<string>>`, `loading: Set<string>`.
- Dedup keys are `"tool:${id}"`, `"error:${id}"`, `"skill:${id}"`, `"compact:${id}"`, `"step:${id}"` — one `Set` per session in `seenKeys`.
- `SessionActivity` fields: `toolCalls`, `toolBreakdown: Record<string, number>`, `errors`, `skills: Record<string, number>`, `autoCompacts`, `steps`.
- `exactOptionalPropertyTypes` is on: optional fields are declared `T | undefined`, never just `T?`.
- `noUncheckedIndexedAccess` is on: index access returns `T | undefined`; use `??` / `!` appropriately.
- NodeNext ESM: relative imports need explicit `.js` extensions; tests import from `src/` directly.
- No new dependencies. No linter; rely on `npm run verify` (typecheck && test && build).
- `test/entrypoints.test.ts` reads `src/tui.tsx` as text and asserts on identifiers/string literals — do not rename existing ones.
- The subagent sidebar rows today render `duration · ctx N tokens`; appending the activity suffix must not change existing rows that have no activity.

---

### Task 1: `src/activity.ts` — types, state factory, and recorders

**Files:**
- Create: `src/activity.ts`
- Test: `test/activity.test.ts`

**Interfaces:**
- Consumes: nothing (pure module).
- Produces:
  - `export type SessionActivity = { toolCalls: number; toolBreakdown: Record<string, number>; errors: number; skills: Record<string, number>; autoCompacts: number; steps: number }`
  - `export type ActivityState = { bySessionID: Record<string, SessionActivity>; childrenByParent: Record<string, string[]>; titles: Record<string, string>; hydrated: Set<string>; seenKeys: Record<string, Set<string>>; loading: Set<string> }`
  - `export function createActivityState(): ActivityState`
  - `export function emptyActivity(): SessionActivity`
  - `export function hasActivity(a: SessionActivity | undefined): boolean`
  - `export function recordChild(state: ActivityState, sessionID: string, parentID: string): void`
  - `export function recordToolPart(state: ActivityState, sessionID: string, part: { id?: string; tool: string; state?: { status?: string; input?: { name?: string } } }): boolean`
  - `export function recordCompaction(state: ActivityState, sessionID: string, id: string, auto: boolean): boolean`
  - `export function recordStep(state: ActivityState, sessionID: string, id: string): boolean`

- [ ] **Step 1: Write the failing tests**

Create `test/activity.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import {
  createActivityState,
  emptyActivity,
  hasActivity,
  recordChild,
  recordCompaction,
  recordStep,
  recordToolPart
} from "../src/activity.js";

describe("activity state", () => {
  test("createActivityState initializes all maps", () => {
    const state = createActivityState();
    expect(state.bySessionID).toEqual({});
    expect(state.childrenByParent).toEqual({});
    expect(state.titles).toEqual({});
    expect(state.hydrated.size).toBe(0);
    expect(state.seenKeys).toEqual({});
    expect(state.loading.size).toBe(0);
  });

  test("emptyActivity starts at zero and hasActivity reflects any metric", () => {
    expect(hasActivity(undefined)).toBe(false);
    const zero = emptyActivity();
    expect(hasActivity(zero)).toBe(false);
    expect(hasActivity({ ...zero, toolCalls: 1 })).toBe(true);
    expect(hasActivity({ ...zero, errors: 1 })).toBe(true);
    expect(hasActivity({ ...zero, autoCompacts: 1 })).toBe(true);
    expect(hasActivity({ ...zero, steps: 1 })).toBe(true);
    expect(hasActivity({ ...zero, skills: { brainstorming: 1 } })).toBe(true);
  });

  test("recordChild appends to the parent list without duplicates", () => {
    const state = createActivityState();
    recordChild(state, "ses_child", "ses_parent");
    recordChild(state, "ses_child", "ses_parent");
    recordChild(state, "ses_other", "ses_parent");
    expect(state.childrenByParent["ses_parent"]).toEqual(["ses_child", "ses_other"]);
  });

  test("recordToolPart counts each tool part id once", () => {
    const state = createActivityState();
    const part = { id: "prt_1", tool: "bash", state: { status: "pending", input: {} } };
    expect(recordToolPart(state, "ses_a", part)).toBe(true);
    expect(recordToolPart(state, "ses_a", part)).toBe(false);
    expect(recordToolPart(state, "ses_a", { ...part, state: { status: "running", input: {} } })).toBe(false);
    expect(state.bySessionID["ses_a"]?.toolCalls).toBe(1);
    expect(state.bySessionID["ses_a"]?.toolBreakdown).toEqual({ bash: 1 });
  });

  test("recordToolPart counts an error on the last sighting without double counting", () => {
    const state = createActivityState();
    const id = "prt_fail";
    recordToolPart(state, "ses_a", { id, tool: "bash", state: { status: "pending", input: {} } });
    recordToolPart(state, "ses_a", { id, tool: "bash", state: { status: "error", input: {} } });
    recordToolPart(state, "ses_a", { id, tool: "bash", state: { status: "error", input: {} } });
    expect(state.bySessionID["ses_a"]?.toolCalls).toBe(1);
    expect(state.bySessionID["ses_a"]?.errors).toBe(1);
  });

  test("recordToolPart extracts skill names only when present", () => {
    const state = createActivityState();
    recordToolPart(state, "ses_a", { id: "prt_skill", tool: "skill", state: { status: "pending", input: {} } });
    recordToolPart(state, "ses_a", { id: "prt_skill", tool: "skill", state: { status: "completed", input: { name: "brainstorming" } } });
    expect(state.bySessionID["ses_a"]?.skills).toEqual({ brainstorming: 1 });
    expect(state.bySessionID["ses_a"]?.toolCalls).toBe(1);
  });

  test("recordToolPart counts distinct tools in the breakdown", () => {
    const state = createActivityState();
    recordToolPart(state, "ses_a", { id: "prt_1", tool: "read" });
    recordToolPart(state, "ses_a", { id: "prt_2", tool: "read" });
    recordToolPart(state, "ses_a", { id: "prt_3", tool: "write" });
    expect(state.bySessionID["ses_a"]?.toolBreakdown).toEqual({ read: 2, write: 1 });
  });

  test("recordCompaction counts auto compactions once per id", () => {
    const state = createActivityState();
    expect(recordCompaction(state, "ses_a", "prt_c1", true)).toBe(true);
    expect(recordCompaction(state, "ses_a", "prt_c1", true)).toBe(false);
    recordCompaction(state, "ses_a", "prt_c2", false);
    expect(state.bySessionID["ses_a"]?.autoCompacts).toBe(1);
  });

  test("recordStep counts once per id", () => {
    const state = createActivityState();
    expect(recordStep(state, "ses_a", "prt_s1")).toBe(true);
    expect(recordStep(state, "ses_a", "prt_s1")).toBe(false);
    recordStep(state, "ses_a", "prt_s2");
    expect(state.bySessionID["ses_a"]?.steps).toBe(2);
  });

  test("ids are deduped per session", () => {
    const state = createActivityState();
    recordToolPart(state, "ses_a", { id: "prt_1", tool: "bash" });
    recordToolPart(state, "ses_b", { id: "prt_1", tool: "bash" });
    expect(state.bySessionID["ses_a"]?.toolCalls).toBe(1);
    expect(state.bySessionID["ses_b"]?.toolCalls).toBe(1);
  });

  test("parts without an id always count (no dedup key)", () => {
    const state = createActivityState();
    recordToolPart(state, "ses_a", { tool: "bash" });
    recordToolPart(state, "ses_a", { tool: "bash" });
    expect(state.bySessionID["ses_a"]?.toolCalls).toBe(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/activity.test.ts`
Expected: FAIL — module `../src/activity.js` not found / functions not defined.

- [ ] **Step 3: Write the implementation**

Create `src/activity.ts`:

```ts
export type SessionActivity = {
  toolCalls: number;
  toolBreakdown: Record<string, number>;
  errors: number;
  skills: Record<string, number>;
  autoCompacts: number;
  steps: number;
};

export type ActivityState = {
  bySessionID: Record<string, SessionActivity>;
  childrenByParent: Record<string, string[]>;
  titles: Record<string, string>;
  hydrated: Set<string>;
  seenKeys: Record<string, Set<string>>;
  loading: Set<string>;
};

export function createActivityState(): ActivityState {
  return {
    bySessionID: {},
    childrenByParent: {},
    titles: {},
    hydrated: new Set(),
    seenKeys: {},
    loading: new Set()
  };
}

export function emptyActivity(): SessionActivity {
  return { toolCalls: 0, toolBreakdown: {}, errors: 0, skills: {}, autoCompacts: 0, steps: 0 };
}

export function hasActivity(a: SessionActivity | undefined): boolean {
  if (!a) return false;
  return (
    a.toolCalls > 0 ||
    a.errors > 0 ||
    a.autoCompacts > 0 ||
    a.steps > 0 ||
    Object.keys(a.skills).length > 0
  );
}

export function recordChild(state: ActivityState, sessionID: string, parentID: string): void {
  const children = state.childrenByParent[parentID];
  if (!children) {
    state.childrenByParent[parentID] = [sessionID];
    return;
  }
  if (!children.includes(sessionID)) children.push(sessionID);
}

function activityFor(state: ActivityState, sessionID: string): SessionActivity {
  return (state.bySessionID[sessionID] ??= emptyActivity());
}

function seen(state: ActivityState, sessionID: string, key: string): boolean {
  const keys = state.seenKeys[sessionID];
  if (!keys) {
    state.seenKeys[sessionID] = new Set([key]);
    return false;
  }
  if (keys.has(key)) return true;
  keys.add(key);
  return false;
}

export function recordToolPart(
  state: ActivityState,
  sessionID: string,
  part: { id?: string; tool: string; state?: { status?: string; input?: { name?: string } } }
): boolean {
  const activity = activityFor(state, sessionID);
  let counted = false;
  if (part.id !== undefined) {
    if (!seen(state, sessionID, `tool:${part.id}`)) {
      activity.toolCalls += 1;
      activity.toolBreakdown[part.tool] = (activity.toolBreakdown[part.tool] ?? 0) + 1;
      counted = true;
    }
  } else {
    activity.toolCalls += 1;
    activity.toolBreakdown[part.tool] = (activity.toolBreakdown[part.tool] ?? 0) + 1;
    counted = true;
  }
  const partState = part.state;
  if (partState?.status === "error" && part.id !== undefined) {
    if (!seen(state, sessionID, `error:${part.id}`)) activity.errors += 1;
  }
  if (part.tool === "skill" && partState?.input && typeof partState.input.name === "string" && partState.input.name.length > 0) {
    if (part.id !== undefined) {
      if (!seen(state, sessionID, `skill:${part.id}`)) {
        activity.skills[partState.input.name] = (activity.skills[partState.input.name] ?? 0) + 1;
      }
    } else {
      activity.skills[partState.input.name] = (activity.skills[partState.input.name] ?? 0) + 1;
    }
  }
  return counted;
}

export function recordCompaction(state: ActivityState, sessionID: string, id: string, auto: boolean): boolean {
  if (!auto) return false;
  const activity = activityFor(state, sessionID);
  if (seen(state, sessionID, `compact:${id}`)) return false;
  activity.autoCompacts += 1;
  return true;
}

export function recordStep(state: ActivityState, sessionID: string, id: string): boolean {
  const activity = activityFor(state, sessionID);
  if (seen(state, sessionID, `step:${id}`)) return false;
  activity.steps += 1;
  return true;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/activity.test.ts`
Expected: PASS (11 tests).

- [ ] **Step 5: Commit**

```bash
git add src/activity.ts test/activity.test.ts
git commit -m "feat: session activity recorders with per-metric keyed dedup"
```

---

### Task 2: `src/activity.ts` — merge and recursive tree aggregation

**Files:**
- Modify: `src/activity.ts`
- Test: `test/activity.test.ts`

**Interfaces:**
- Consumes: `SessionActivity`, `ActivityState`, `emptyActivity`, `hasActivity` from Task 1.
- Produces:
  - `export function mergeActivity(...activities: SessionActivity[]): SessionActivity`
  - `export function treeActivity(state: ActivityState, rootSessionID: string): SessionActivity`
  - `export function treeLoading(state: ActivityState, rootSessionID: string): boolean`

- [ ] **Step 1: Write the failing tests**

Append to `test/activity.test.ts`:

```ts
import {
  createActivityState,
  emptyActivity,
  hasActivity,
  mergeActivity,
  recordChild,
  recordCompaction,
  recordStep,
  recordToolPart,
  treeActivity,
  treeLoading
} from "../src/activity.js";
```

(Replace the existing import block at the top with the one above — it adds `mergeActivity`, `treeActivity`, `treeLoading`.)

```ts
describe("activity merge and tree", () => {
  test("mergeActivity sums every metric and merges breakdowns", () => {
    const a = { ...emptyActivity(), toolCalls: 3, errors: 1, autoCompacts: 2, steps: 5, toolBreakdown: { bash: 2, read: 1 }, skills: { brainstorming: 1 } };
    const b = { ...emptyActivity(), toolCalls: 4, errors: 0, autoCompacts: 1, steps: 0, toolBreakdown: { bash: 3, write: 1 }, skills: { brainstorming: 2, tdd: 1 } };
    const merged = mergeActivity(a, b);
    expect(merged.toolCalls).toBe(7);
    expect(merged.errors).toBe(1);
    expect(merged.autoCompacts).toBe(3);
    expect(merged.steps).toBe(5);
    expect(merged.toolBreakdown).toEqual({ bash: 5, read: 1, write: 1 });
    expect(merged.skills).toEqual({ brainstorming: 3, tdd: 1 });
  });

  test("mergeActivity with no args is empty", () => {
    expect(hasActivity(mergeActivity())).toBe(false);
  });

  test("treeActivity aggregates root and descendants recursively", () => {
    const state = createActivityState();
    recordChild(state, "ses_a", "ses_root");
    recordChild(state, "ses_b", "ses_a");
    recordToolPart(state, "ses_root", { id: "p1", tool: "bash" });
    recordToolPart(state, "ses_a", { id: "p2", tool: "read" });
    recordStep(state, "ses_a", "s1");
    recordToolPart(state, "ses_b", { id: "p3", tool: "write" });
    recordCompaction(state, "ses_b", "c1", true);

    const tree = treeActivity(state, "ses_root");
    expect(tree.toolCalls).toBe(3);
    expect(tree.toolBreakdown).toEqual({ bash: 1, read: 1, write: 1 });
    expect(tree.steps).toBe(1);
    expect(tree.autoCompacts).toBe(1);
  });

  test("treeActivity guards against cycles", () => {
    const state = createActivityState();
    recordChild(state, "ses_a", "ses_root");
    recordChild(state, "ses_root", "ses_a");
    recordToolPart(state, "ses_root", { id: "p1", tool: "bash" });
    expect(treeActivity(state, "ses_root").toolCalls).toBe(1);
  });

  test("treeActivity ignores missing sessions", () => {
    const state = createActivityState();
    recordChild(state, "ses_missing", "ses_root");
    recordToolPart(state, "ses_root", { id: "p1", tool: "bash" });
    expect(treeActivity(state, "ses_root").toolCalls).toBe(1);
  });

  test("treeActivity includes children added live after seeding", () => {
    const state = createActivityState();
    recordChild(state, "ses_live_child", "ses_root");
    recordToolPart(state, "ses_live_child", { id: "p1", tool: "grep" });
    expect(treeActivity(state, "ses_root").toolCalls).toBe(1);
  });

  test("treeLoading reports true when any tree session is loading", () => {
    const state = createActivityState();
    recordChild(state, "ses_a", "ses_root");
    state.loading.add("ses_a");
    expect(treeLoading(state, "ses_root")).toBe(true);
    state.loading.delete("ses_a");
    expect(treeLoading(state, "ses_root")).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/activity.test.ts`
Expected: FAIL — `mergeActivity` / `treeActivity` / `treeLoading` not exported.

- [ ] **Step 3: Write the implementation**

Append to `src/activity.ts`:

```ts
export function mergeActivity(...activities: SessionActivity[]): SessionActivity {
  const result = emptyActivity();
  for (const activity of activities) {
    result.toolCalls += activity.toolCalls;
    result.errors += activity.errors;
    result.autoCompacts += activity.autoCompacts;
    result.steps += activity.steps;
    for (const [tool, count] of Object.entries(activity.toolBreakdown)) {
      result.toolBreakdown[tool] = (result.toolBreakdown[tool] ?? 0) + count;
    }
    for (const [name, count] of Object.entries(activity.skills)) {
      result.skills[name] = (result.skills[name] ?? 0) + count;
    }
  }
  return result;
}

function collectTreeSessions(state: ActivityState, rootSessionID: string): string[] {
  const visited = new Set<string>();
  const result: string[] = [];
  const stack = [rootSessionID];
  while (stack.length > 0) {
    const sessionID = stack.pop();
    if (sessionID === undefined || visited.has(sessionID)) continue;
    visited.add(sessionID);
    result.push(sessionID);
    const children = state.childrenByParent[sessionID] ?? [];
    for (const child of children) {
      if (!visited.has(child)) stack.push(child);
    }
  }
  return result;
}

export function treeActivity(state: ActivityState, rootSessionID: string): SessionActivity {
  const activities: SessionActivity[] = [];
  for (const sessionID of collectTreeSessions(state, rootSessionID)) {
    const activity = state.bySessionID[sessionID];
    if (activity) activities.push(activity);
  }
  return mergeActivity(...activities);
}

export function treeLoading(state: ActivityState, rootSessionID: string): boolean {
  return collectTreeSessions(state, rootSessionID).some((sessionID) => state.loading.has(sessionID));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/activity.test.ts`
Expected: PASS (18 tests).

- [ ] **Step 5: Commit**

```bash
git add src/activity.ts test/activity.test.ts
git commit -m "feat: activity merge and recursive tree aggregation"
```

---

### Task 3: `src/activity.ts` — formatters and dialog row builder

**Files:**
- Modify: `src/activity.ts`
- Test: `test/activity.test.ts`

**Interfaces:**
- Consumes: `SessionActivity`, `hasActivity`, `treeActivity` from Tasks 1–2.
- Produces:
  - `export function formatActivitySuffix(a: SessionActivity | undefined): string` — `""` when nothing; otherwise `"18 calls · 2 auto-compacts · 1 error · 3 skills"` (zero values omitted, pluralized, skills last).
  - `export function formatActivityBrief(a: SessionActivity | undefined): string` — alias of `formatActivitySuffix`.
  - `export function buildSessionAnalysisRows(state: ActivityState, rootSessionID: string): string[]` — dialog lines (see Step 1 for exact format).

- [ ] **Step 1: Write the failing tests**

Append to `test/activity.test.ts`. First replace the import block at the top of the file with:

```ts
import { describe, expect, test } from "vitest";
import {
  buildSessionAnalysisRows,
  createActivityState,
  emptyActivity,
  formatActivityBrief,
  formatActivitySuffix,
  hasActivity,
  mergeActivity,
  recordChild,
  recordCompaction,
  recordStep,
  recordToolPart,
  treeActivity,
  treeLoading
} from "../src/activity.js";
```

Then append:

```ts
describe("activity formatting", () => {
  test("formatActivitySuffix omits zero values and pluralizes", () => {
    const a = { ...emptyActivity(), toolCalls: 18, autoCompacts: 2, errors: 1, skills: { brainstorming: 2, tdd: 1 } };
    expect(formatActivitySuffix(a)).toBe("18 calls · 2 auto-compacts · 1 error · 3 skills");
    expect(formatActivitySuffix({ ...emptyActivity(), toolCalls: 1 })).toBe("1 call");
    expect(formatActivitySuffix(emptyActivity())).toBe("");
    expect(formatActivitySuffix(undefined)).toBe("");
  });

  test("formatActivitySuffix ordering is calls, auto-compacts, errors, skills", () => {
    const a = { ...emptyActivity(), autoCompacts: 1, errors: 1, toolCalls: 1, skills: { tdd: 1 } };
    expect(formatActivitySuffix(a)).toBe("1 call · 1 auto-compact · 1 error · 1 skill");
  });

  test("formatActivityBrief matches the suffix", () => {
    const a = { ...emptyActivity(), toolCalls: 2 };
    expect(formatActivityBrief(a)).toBe(formatActivitySuffix(a));
    expect(formatActivityBrief(emptyActivity())).toBe("");
  });

  test("buildSessionAnalysisRows renders sections and the subagent tree", () => {
    const state = createActivityState();
    state.titles["ses_root"] = "Main";
    state.titles["ses_a"] = "T3: tightly-coupled fixtures";
    state.titles["ses_b"] = "child-of-T3";
    recordChild(state, "ses_a", "ses_root");
    recordChild(state, "ses_b", "ses_a");
    recordToolPart(state, "ses_root", { id: "p1", tool: "bash" });
    recordToolPart(state, "ses_a", { id: "p2", tool: "read" });
    recordCompaction(state, "ses_a", "c1", true);
    recordStep(state, "ses_a", "s1");

    expect(buildSessionAnalysisRows(state, "ses_root")).toEqual([
      "▾ Tools (2)",
      "  bash 1",
      "  read 1",
      "▾ Auto-compactions",
      "  1",
      "▾ Model calls (steps)",
      "  1",
      "▾ Subagents",
      "  · T3: tightly-coupled fixtures  1 call · 1 auto-compact",
      "    · child-of-T3"
    ]);
  });

  test("buildSessionAnalysisRows omits zero sections and errors section", () => {
    const state = createActivityState();
    state.titles["ses_root"] = "Main";
    recordToolPart(state, "ses_root", { id: "p1", tool: "bash", state: { status: "error", input: {} } });
    expect(buildSessionAnalysisRows(state, "ses_root")).toEqual([
      "▾ Tools (1)",
      "  bash 1",
      "▾ Tool errors",
      "  1"
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/activity.test.ts`
Expected: FAIL — `formatActivitySuffix` / `buildSessionAnalysisRows` not exported.

- [ ] **Step 3: Write the implementation**

Append to `src/activity.ts`:

```ts
function pluralize(count: number, singular: string, plural?: string): string {
  return `${count} ${count === 1 ? singular : (plural ?? `${singular}s`)}`;
}

export function formatActivitySuffix(a: SessionActivity | undefined): string {
  if (!hasActivity(a)) return "";
  const parts: string[] = [];
  if (a && a.toolCalls > 0) parts.push(pluralize(a.toolCalls, "call"));
  if (a && a.autoCompacts > 0) parts.push(pluralize(a.autoCompacts, "auto-compact"));
  if (a && a.errors > 0) parts.push(pluralize(a.errors, "error"));
  if (a && Object.keys(a.skills).length > 0) {
    const total = Object.values(a.skills).reduce((sum, count) => sum + count, 0);
    parts.push(pluralize(total, "skill"));
  }
  return parts.join(" · ");
}

export function formatActivityBrief(a: SessionActivity | undefined): string {
  return formatActivitySuffix(a);
}

function truncateMiddle(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  if (maxLength <= 3) return value.slice(0, maxLength);
  const marker = "...";
  const left = Math.ceil((maxLength - marker.length) / 2);
  const right = Math.floor((maxLength - marker.length) / 2);
  return `${value.slice(0, left)}${marker}${value.slice(value.length - right)}`;
}

function sortedBreakdown(breakdown: Record<string, number>): Array<[string, number]> {
  return Object.entries(breakdown).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

function indent(lines: string[], depth: number): string[] {
  return lines.map((text) => `${"  ".repeat(depth)}${text}`);
}

export function buildSessionAnalysisRows(state: ActivityState, rootSessionID: string): string[] {
  const rows: string[] = [];
  const children = (sessionID: string) => state.childrenByParent[sessionID] ?? [];
  const activityOf = (sessionID: string) => state.bySessionID[sessionID] ?? emptyActivity();
  const titleOf = (sessionID: string) => state.titles[sessionID] ?? sessionID;
  const childIds: string[] = [];

  const visit = (sessionID: string, depth: number) => {
    for (const childID of children(sessionID)) {
      childIds.push(childID);
      const childActivity = activityOf(childID);
      const suffix = formatActivitySuffix(childActivity);
      const line = `· ${truncateMiddle(titleOf(childID), 36)}${suffix ? `  ${suffix}` : ""}`;
      rows.push(`${"  ".repeat(depth + 1)}${line}`);
      visit(childID, depth + 1);
    }
  };
  visit(rootSessionID, 0);

  const tree = treeActivity(state, rootSessionID);

  const sections: Array<[string, string[]]> = [];
  if (tree.toolCalls > 0) {
    sections.push([`▾ Tools (${tree.toolCalls})`, indent(sortedBreakdown(tree.toolBreakdown).map(([tool, count]) => `${tool} ${count}`), 1)]);
  }
  if (Object.keys(tree.skills).length > 0) {
    const total = Object.values(tree.skills).reduce((sum, count) => sum + count, 0);
    sections.push([`▾ Skills (${total})`, indent(sortedBreakdown(tree.skills).map(([name, count]) => `${name} ${count}`), 1)]);
  }
  if (tree.autoCompacts > 0) {
    sections.push([`▾ Auto-compactions`, [`  ${tree.autoCompacts}`]]);
  }
  if (tree.errors > 0) {
    sections.push([`▾ Tool errors`, [`  ${tree.errors}`]]);
  }
  if (tree.steps > 0) {
    sections.push([`▾ Model calls (steps)`, [`  ${tree.steps}`]]);
  }
  if (childIds.length > 0 && hasActivity(tree)) {
    sections.push([`▾ Subagents`, rows]);
  }

  return sections.flatMap(([title, body]) => [title, ...body]);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/activity.test.ts`
Expected: PASS (23 tests).

- [ ] **Step 5: Commit**

```bash
git add src/activity.ts test/activity.test.ts
git commit -m "feat: activity formatting and session analysis dialog rows"
```

---

### Task 4: `src/activity-hydrate.ts` — history backfill

**Files:**
- Create: `src/activity-hydrate.ts`
- Test: `test/activity-hydrate.test.ts`

**Interfaces:**
- Consumes: `ActivityState`, `recordChild`, `recordToolPart`, `recordCompaction`, `recordStep` from Tasks 1–2.
- Produces:
  - `export type ActivityClient = { session: { list(input: { limit?: number }): Promise<{ data?: Array<{ id: string; parentID?: string; title?: string }> }>; messages(input: { sessionID: string }): Promise<{ data?: Array<{ parts?: Array<Record<string, unknown>> }> }> } }`
  - `export async function hydrateActivity(client: ActivityClient, state: ActivityState, rootSessionID: string): Promise<void>`
  - Part scanning is defensive: a part is a record with optional `id`, `type`, `tool`, `state`, `auto` fields; unknown shapes are skipped.

- [ ] **Step 1: Write the failing tests**

Create `test/activity-hydrate.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import { createActivityState } from "../src/activity.js";
import { hydrateActivity, type ActivityClient } from "../src/activity-hydrate.js";

function makeClient(overrides: Partial<ActivityClient["session"]> = {}): ActivityClient {
  return {
    session: {
      list: async () => ({ data: [] }),
      messages: async () => ({ data: [] }),
      ...overrides
    }
  };
}

describe("hydrateActivity", () => {
  test("seeds childrenByParent and titles from session.list", async () => {
    const state = createActivityState();
    const client = makeClient({
      list: async () => ({
        data: [
          { id: "ses_root", title: "Main" },
          { id: "ses_a", parentID: "ses_root", title: "T3" },
          { id: "ses_b", parentID: "ses_a", title: "child" }
        ]
      })
    });
    await hydrateActivity(client, state, "ses_root");
    expect(state.childrenByParent["ses_root"]).toEqual(["ses_a"]);
    expect(state.childrenByParent["ses_a"]).toEqual(["ses_b"]);
    expect(state.titles["ses_a"]).toBe("T3");
  });

  test("backfills tool, compaction, and step counts per session", async () => {
    const state = createActivityState();
    const client = makeClient({
      list: async () => ({ data: [{ id: "ses_root", title: "Main" }, { id: "ses_a", parentID: "ses_root", title: "T3" }] }),
      messages: async ({ sessionID }) => ({
        data:
          sessionID === "ses_a"
            ? [
                { parts: [
                    { id: "prt_t1", type: "tool", tool: "bash", state: { status: "completed", input: {} } },
                    { id: "prt_c1", type: "compaction", auto: true },
                    { id: "prt_s1", type: "step-finish", reason: "stop" }
                  ] }
              ]
            : []
      })
    });
    await hydrateActivity(client, state, "ses_root");
    expect(state.bySessionID["ses_a"]?.toolCalls).toBe(1);
    expect(state.bySessionID["ses_a"]?.toolBreakdown).toEqual({ bash: 1 });
    expect(state.bySessionID["ses_a"]?.autoCompacts).toBe(1);
    expect(state.bySessionID["ses_a"]?.steps).toBe(1);
    expect(state.hydrated.has("ses_a")).toBe(true);
  });

  test("does not double count parts seen live before backfill", async () => {
    const state = createActivityState();
    // part seen live (identical id)
    state.bySessionID["ses_a"] = { toolCalls: 1, toolBreakdown: { bash: 1 }, errors: 0, skills: {}, autoCompacts: 0, steps: 0 };
    state.seenKeys["ses_a"] = new Set(["tool:prt_t1"]);
    const client = makeClient({
      list: async () => ({ data: [{ id: "ses_root", title: "Main" }, { id: "ses_a", parentID: "ses_root", title: "T3" }] }),
      messages: async () => ({
        data: [{ parts: [{ id: "prt_t1", type: "tool", tool: "bash", state: { status: "completed", input: {} } }] }]
      })
    });
    await hydrateActivity(client, state, "ses_root");
    expect(state.bySessionID["ses_a"]?.toolCalls).toBe(1);
  });

  test("skips already hydrated sessions", async () => {
    const state = createActivityState();
    state.hydrated.add("ses_root");
    let messagesCalled = 0;
    const client = makeClient({
      list: async () => ({ data: [{ id: "ses_root", title: "Main" }] }),
      messages: async () => {
        messagesCalled += 1;
        return { data: [] };
      }
    });
    await hydrateActivity(client, state, "ses_root");
    expect(messagesCalled).toBe(0);
  });

  test("marks loading during the fetch and clears it after", async () => {
    const state = createActivityState();
    const client = makeClient({
      list: async () => ({ data: [{ id: "ses_root", title: "Main" }] }),
      messages: async () => {
        expect(state.loading.has("ses_root")).toBe(true);
        return { data: [] };
      }
    });
    await hydrateActivity(client, state, "ses_root");
    expect(state.loading.size).toBe(0);
    expect(state.hydrated.has("ses_root")).toBe(true);
  });

  test("does not mark hydrated when messages fails; retries next call", async () => {
    const state = createActivityState();
    const client = makeClient({
      list: async () => ({ data: [{ id: "ses_root", title: "Main" }] }),
      messages: async () => {
        throw new Error("boom");
      }
    });
    await hydrateActivity(client, state, "ses_root");
    expect(state.hydrated.has("ses_root")).toBe(false);
    expect(state.loading.size).toBe(0);
  });

  test("ignores non-session root ids", async () => {
    const state = createActivityState();
    let listCalled = 0;
    const client = makeClient({
      list: async () => {
        listCalled += 1;
        return { data: [] };
      }
    });
    await hydrateActivity(client, state, "not-a-session");
    expect(listCalled).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/activity-hydrate.test.ts`
Expected: FAIL — module `../src/activity-hydrate.js` not found.

- [ ] **Step 3: Write the implementation**

Create `src/activity-hydrate.ts`:

```ts
import { recordChild, recordCompaction, recordStep, recordToolPart, type ActivityState } from "./activity.js";

export type ActivityClient = {
  session: {
    list(input: { limit?: number }): Promise<{ data?: Array<{ id: string; parentID?: string; title?: string }> }>;
    messages(input: { sessionID: string }): Promise<{ data?: Array<{ parts?: Array<Record<string, unknown>> }> }>;
  };
};

const CONCURRENCY_LIMIT = 4;
const LIST_LIMIT = 1000;

function isSessionID(value: string): boolean {
  return value.startsWith("ses");
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
    const children = state.childrenByParent[sessionID] ?? [];
    for (const child of children) {
      if (!visited.has(child)) stack.push(child);
    }
  }
  return result;
}

function applyParts(state: ActivityState, sessionID: string, parts: Array<Record<string, unknown>>): void {
  for (const part of parts) {
    const id = typeof part.id === "string" ? part.id : undefined;
    const type = part.type;
    if (type === "tool" && typeof part.tool === "string") {
      recordToolPart(state, sessionID, {
        id,
        tool: part.tool,
        state: typeof part.state === "object" && part.state !== null && !Array.isArray(part.state)
          ? (part.state as { status?: string; input?: { name?: string } })
          : undefined
      });
    } else if (type === "compaction" && id !== undefined) {
      recordCompaction(state, sessionID, id, part.auto === true);
    } else if (type === "step-finish" && id !== undefined) {
      recordStep(state, sessionID, id);
    }
  }
}

export async function hydrateActivity(client: ActivityClient, state: ActivityState, rootSessionID: string): Promise<void> {
  if (!isSessionID(rootSessionID)) return;
  let sessions: Array<{ id: string; parentID?: string; title?: string }> = [];
  try {
    const response = await client.session.list({ limit: LIST_LIMIT });
    sessions = response.data ?? [];
  } catch {
    return; // degrade to live-only data
  }
  for (const session of sessions) {
    if (session.id) {
      if (session.title) state.titles[session.id] = session.title;
      if (session.parentID) recordChild(state, session.id, session.parentID);
    }
  }

  const toHydrate = collectUnhydrated(state, rootSessionID);
  for (const sessionID of toHydrate) state.loading.add(sessionID);
  await mapConcurrent(toHydrate, CONCURRENCY_LIMIT, async (sessionID) => {
    try {
      const response = await client.session.messages({ sessionID });
      const messages = response.data ?? [];
      for (const message of messages) {
        if (message.parts && message.parts.length > 0) {
          applyParts(state, sessionID, message.parts);
        }
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

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/activity-hydrate.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/activity-hydrate.ts test/activity-hydrate.test.ts
git commit -m "feat: activity history backfill with concurrency cap"
```

---

### Task 5: `src/subagents.ts` — attach activity and append suffix

**Files:**
- Modify: `src/subagents.ts`
- Test: `test/subagents.test.ts`

**Interfaces:**
- Consumes: `SessionActivity`, `ActivityState`, `emptyActivity`, `formatActivitySuffix` from `./activity.js` (Tasks 1–3).
- Produces:
  - `SubagentInfo` gains `activity?: SessionActivity | undefined`.
  - `SubagentState` gains `activityStore?: ActivityState | undefined`.
  - `createSubagentState(activityStore?: ActivityState): SubagentState` (backward compatible — existing call sites pass nothing).
  - Row subtitles gain the activity suffix (via `formatActivitySuffix`).

- [ ] **Step 1: Write the failing tests**

Append to `test/subagents.test.ts`:

```ts
import { createActivityState, recordToolPart } from "../src/activity.js";
```

Add this import line to the existing import block at the top of `test/subagents.test.ts`.

```ts
describe("subagent activity suffix", () => {
  test("appends activity suffix to the row subtitle", () => {
    const activity = createActivityState();
    const state = createSubagentState(activity);
    recordToolPart(activity, "ses_child_1", { id: "prt_1", tool: "bash" });
    recordToolPart(activity, "ses_child_1", { id: "prt_2", tool: "read" });

    applySubagentEvent(state, {
      type: "session.updated",
      properties: {
        info: {
          id: "ses_child_1",
          parentID: "ses_parent",
          title: "Review tests",
          time: { created: 1_000 },
          tokens: { input: 12, output: 8 }
        }
      }
    });

    expect(getSubagentSidebarModel(state, "ses_parent", { now: 6_000 })?.rows[0]?.subtitle).toBe(
      "00:05 · ctx 20 tokens · 2 calls"
    );
  });

  test("keeps subtitle unchanged when the subagent has no activity", () => {
    const activity = createActivityState();
    const state = createSubagentState(activity);

    applySubagentEvent(state, {
      type: "session.updated",
      properties: {
        info: {
          id: "ses_child_1",
          parentID: "ses_parent",
          title: "Review tests",
          time: { created: 1_000 },
          tokens: { input: 12, output: 8 }
        }
      }
    });

    expect(getSubagentSidebarModel(state, "ses_parent", { now: 6_000 })?.rows[0]?.subtitle).toBe(
      "00:05 · ctx 20 tokens"
    );
  });

  test("attaches a live activity record created on demand", () => {
    const activity = createActivityState();
    const state = createSubagentState(activity);

    applySubagentEvent(state, {
      type: "session.updated",
      properties: {
        info: { id: "ses_child_1", parentID: "ses_parent", title: "X", time: { created: 1_000 } }
      }
    });

    expect(activity.bySessionID["ses_child_1"]).toBeDefined();
    expect(state.children["ses_child_1"]?.activity).toBe(activity.bySessionID["ses_child_1"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/subagents.test.ts`
Expected: FAIL — `createSubagentState(activity)` doesn't accept an argument / `activity` property missing.

- [ ] **Step 3: Write the implementation**

Modify `src/subagents.ts`:

Add at the top (after the existing imports; the file currently has none — add one):

```ts
import { emptyActivity, formatActivitySuffix, type ActivityState, type SessionActivity } from "./activity.js";
```

Change the type declarations:

```ts
export type SubagentInfo = {
  id: string;
  parentID: string;
  title: string;
  status: SubagentStatus;
  startedAt: string;
  updatedAt: string;
  endedAt?: string | undefined;
  elapsedMs?: number | undefined;
  tokens?: {
    input?: number | undefined;
    output?: number | undefined;
    total?: number | undefined;
    contextPercent?: number | undefined;
  } | undefined;
  activity?: SessionActivity | undefined;
};

export type SubagentState = {
  children: Record<string, SubagentInfo>;
  totalExecuted: number;
  activityStore?: ActivityState | undefined;
};
```

Change `createSubagentState`:

```ts
export function createSubagentState(activityStore?: ActivityState): SubagentState {
  return { children: {}, totalExecuted: 0, ...(activityStore ? { activityStore } : {}) };
}
```

In `applySubagentEvent`, inside the `next` object construction, add the activity attach. Find the line:

```ts
    tokens: created.tokens ?? previous?.tokens
  };
```

and replace with:

```ts
    tokens: created.tokens ?? previous?.tokens,
    activity: state.activityStore ? (state.activityStore.bySessionID[created.id] ??= emptyActivity()) : undefined
  };
```

In `getSubagentSidebarModel`, find:

```ts
      subtitle: [formatSubagentDuration(child, options.now), formatUsage(child)].filter(Boolean).join(" · "),
```

and replace with:

```ts
      subtitle: [formatSubagentDuration(child, options.now), formatUsage(child), formatActivitySuffix(child.activity)].filter(Boolean).join(" · "),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/subagents.test.ts`
Expected: PASS — all existing tests plus the 3 new ones. Existing subtitles are unchanged (no activity attached in those tests).

- [ ] **Step 5: Commit**

```bash
git add src/subagents.ts test/subagents.test.ts
git commit -m "feat: attach activity to subagents and append suffix to rows"
```

---

### Task 6: `src/tui.tsx` — live event wiring and sidebar section

**Files:**
- Modify: `src/tui.tsx`
- Test: `test/entrypoints.test.ts`

**Interfaces:**
- Consumes: `createActivityState`, `recordChild`, `recordCompaction`, `recordStep`, `recordToolPart`, `treeActivity`, `treeLoading` from `./activity.js`; `formatActivityBrief` from `./activity.js`; `hydrateActivity` from `./activity-hydrate.js`; `createSubagentState(activityStore)` from `./subagents.js` (Task 5).
- Produces:
  - `SessionAnalysisSidebar` component (props: `api`, `sessionID`, `state: ActivityState`, `subscribe`, `hydrate`).
  - `SessionAnalysisDialog` component (props: `api`, `state: ActivityState`, `rootSessionID`).
  - `activityListeners` registry; `hydrateActivity` invoked from the sidebar's `hydrate` prop.
  - `recordChild` + `titles` population in the `session.created` / `session.updated` handlers.

- [ ] **Step 1: Write the failing entrypoint assertions**

Append to `test/entrypoints.test.ts`:

```ts
  test("renders the session analysis sidebar and dialog", () => {
    const source = readFileSync(new URL("../src/tui.tsx", import.meta.url), "utf8");

    expect(source).toContain("function SessionAnalysisSidebar");
    expect(source).toContain('"Session Analysis"');
    expect(source).toContain("api.ui.dialog.replace");
    expect(source).toContain("function SessionAnalysisDialog");
    expect(source).toContain("buildSessionAnalysisRows");
    expect(source).toContain("treeActivity");
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/entrypoints.test.ts`
Expected: FAIL — `function SessionAnalysisSidebar` not found in `src/tui.tsx`.

- [ ] **Step 3: Implement the live wiring and sidebar**

Modify `src/tui.tsx`:

Add to the import block from `./subagents.js` nothing new; add new imports after the `./subagents.js` import:

```tsx
import {
  buildSessionAnalysisRows,
  createActivityState,
  formatActivityBrief,
  recordChild,
  recordCompaction,
  recordStep,
  recordToolPart,
  treeActivity,
  treeLoading,
  type ActivityState
} from "./activity.js";
import { hydrateActivity, type ActivityClient } from "./activity-hydrate.js";
import { useTerminalDimensions } from "@opentui/solid";
```

Note: `createSignal, onCleanup` are already imported from `solid-js` — extend that existing import with `For` so it reads `import { createSignal, For, onCleanup } from "solid-js";` (do not add a second import line from the same module).

```tsx
import { createSignal, For, onCleanup } from "solid-js";
```

Add the two components after `SubagentSidebar` (before `renderTokenUsageSidebar`):

```tsx
function renderSessionAnalysisSidebar(
  line: string,
  api: TuiPluginApi,
  titleAttributes: number,
  collapsed: boolean
) {
  const chunks: TextChunk[] = [
    textChunk(`${collapsed ? "▶" : "▼"} Session Analysis\n`, api.theme.current.text, titleAttributes),
    textChunk(line, api.theme.current.textMuted)
  ];
  return new StyledText(chunks);
}

function SessionAnalysisDialog(props: {
  api: TuiPluginApi;
  state: ActivityState;
  rootSessionID: string;
}) {
  const dimensions = useTerminalDimensions();
  const titleAttributes = createTextAttributes({ bold: true });
  const rows = buildSessionAnalysisRows(props.state, props.rootSessionID);
  const maxHeight = Math.max(4, Math.floor(dimensions().height / 2) - 6);
  const { Dialog } = props.api.ui;
  return (
    <Dialog size="large" onClose={() => props.api.ui.dialog.clear()}>
      <box flexDirection="column" flexGrow={1} paddingLeft={4} paddingRight={4} paddingTop={1}>
        <text fg={props.api.theme.current.text} attributes={titleAttributes}>
          Session Analysis
        </text>
        <scrollbox
          verticalScrollbarOptions={{ visible: true }}
          maxHeight={maxHeight}
          flexGrow={1}
          paddingTop={1}
        >
          <For each={rows}>
            {(row) => <text fg={props.api.theme.current.textMuted}>{row}</text>}
          </For>
        </scrollbox>
      </box>
    </Dialog>
  );
}

function SessionAnalysisSidebar(props: {
  api: TuiPluginApi;
  sessionID: string;
  state: ActivityState;
  subscribe: (listener: Listener) => () => void;
  hydrate: () => void;
}) {
  let text: TextRenderable | undefined;
  const [collapsed, setCollapsed] = createSignal(false);
  const titleAttributes = createTextAttributes({ bold: true });
  let previous: { content: string; visible: boolean; height: number | string } | undefined;

  const toggle = (event: MouseEvent) => {
    if (!text || event.y !== text.y) return;
    setCollapsed((prev) => !prev);
    sync();
  };

  const openDialog = (event: MouseEvent) => {
    if (!text || collapsed() || event.y === text.y) return;
    props.api.ui.dialog.replace(() => (
      <SessionAnalysisDialog api={props.api} state={props.state} rootSessionID={props.sessionID} />
    ));
  };

  const sync = () => {
    if (!text) return;
    const tree = treeActivity(props.state, props.sessionID);
    const loading = treeLoading(props.state, props.sessionID);
    const brief = formatActivityBrief(tree);
    const line = loading ? (brief ? `${brief} · loading…` : "loading…") : brief;
    const visible = line.length > 0;
    const content = `${collapsed()}|${line}`;
    const next: { content: string; visible: boolean; height: number | "auto" } = {
      content,
      visible,
      height: visible ? "auto" : 0
    };
    if (!hasRenderStateChanged(previous, next)) return;
    previous = next;
    text.visible = next.visible;
    text.height = next.height;
    text.content = visible ? renderSessionAnalysisSidebar(line, props.api, titleAttributes, collapsed()) : "";
    props.api.renderer.requestRender();
  };

  const unsubscribe = props.subscribe(sync);
  const timer = setInterval(sync, 1_000);
  onCleanup(() => {
    unsubscribe();
    clearInterval(timer);
  });
  props.hydrate();

  return (
    <text
      ref={(ref: TextRenderable) => {
        text = ref;
        sync();
      }}
      onMouseDown={toggle}
      onMouseUp={openDialog}
      fg={props.api.theme.current.textMuted}
    >
      {""}
    </text>
  );
}
```

In the plugin body (where `metrics`, `subagents`, and the listener registries are created), add:

```ts
const activity = createActivityState();
const activityListeners = createListenerRegistry();
const subagents = createSubagentState(activity);
```

Replace the existing `const subagents = createSubagentState();` line with the above.

Extend the `session.created` and `session.updated` handlers. Find:

```ts
  const offSessionCreated = api.event.on("session.created", (evt) => {
    if (applySubagentEvent(subagents, evt)) subagentListeners.notify();
  });

  const offSessionUpdated = api.event.on("session.updated", (evt) => {
    if (applySubagentEvent(subagents, evt)) subagentListeners.notify();
    const info = evt.properties.info as { id?: unknown; model?: { providerID?: unknown } } | undefined;
    const sessionID = typeof info?.id === "string" ? info.id : undefined;
    const providerID = info?.model?.providerID;
    if (sessionID && typeof providerID === "string") {
      goProviderTracker.record(sessionID, providerID);
      metricListeners.notify();
    }
  });
```

and replace with:

```ts
  const offSessionCreated = api.event.on("session.created", (evt) => {
    if (applySubagentEvent(subagents, evt)) subagentListeners.notify();
    const info = evt.properties.info as { id?: unknown; parentID?: unknown; title?: unknown } | undefined;
    if (info && typeof info.id === "string") {
      if (typeof info.title === "string") activity.titles[info.id] = info.title;
      if (typeof info.parentID === "string") recordChild(activity, info.id, info.parentID);
      activityListeners.notify();
    }
  });

  const offSessionUpdated = api.event.on("session.updated", (evt) => {
    if (applySubagentEvent(subagents, evt)) subagentListeners.notify();
    const info = evt.properties.info as { id?: unknown; parentID?: unknown; title?: unknown; model?: { providerID?: unknown } } | undefined;
    const sessionID = typeof info?.id === "string" ? info.id : undefined;
    if (sessionID) {
      if (typeof info?.title === "string") activity.titles[sessionID] = info.title;
      if (typeof info?.parentID === "string") recordChild(activity, sessionID, info.parentID);
      activityListeners.notify();
    }
    const providerID = info?.model?.providerID;
    if (sessionID && typeof providerID === "string") {
      goProviderTracker.record(sessionID, providerID);
      metricListeners.notify();
    }
  });
```

Extend the `message.part.updated` handler (`offPart`). Find:

```ts
  const offPart = api.event.on("message.part.updated", (evt) => {
    const part = evt.properties.part;
    if (part.type === "tool") {
      recordToolActivity(metrics, part.sessionID ?? evt.properties.sessionID, part.messageID, Date.now());
    }
    if (applySubagentEvent(subagents, evt)) subagentListeners.notify();
    metricListeners.notify();
  });
```

and replace with:

```ts
  const offPart = api.event.on("message.part.updated", (evt) => {
    const part = evt.properties.part;
    const sessionID = part.sessionID ?? evt.properties.sessionID;
    if (part.type === "tool") {
      recordToolActivity(metrics, sessionID, part.messageID, Date.now());
      recordToolPart(activity, sessionID, part);
    } else if (part.type === "compaction") {
      recordCompaction(activity, sessionID, part.id, part.auto === true);
    } else if (part.type === "step-finish") {
      recordStep(activity, sessionID, part.id);
    }
    if (applySubagentEvent(subagents, evt)) subagentListeners.notify();
    metricListeners.notify();
    activityListeners.notify();
  });
```

Note: `part` is typed as the SDK `Part` union; the `recordToolPart` parameter type is structurally compatible (`{ id?: string; tool: string; state?: {...} }`). If TS complains about `part.id` being `string` but the union narrowing, cast narrowly: `recordToolPart(activity, sessionID, { id: part.id, tool: part.tool, state: part.state as { status?: string; input?: { name?: string } } | undefined })`.

Add the sidebar to the slot render. Find the `sidebar_content` slot registration and add `<SessionAnalysisSidebar … />` after `<SubagentSidebar … />`:

```tsx
          <SessionAnalysisSidebar
            api={api}
            sessionID={props.session_id}
            state={activity}
            subscribe={activityListeners.subscribe}
            hydrate={() => void hydrateActivity(api.client as unknown as ActivityClient, activity, props.session_id)}
          />
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/entrypoints.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full verify gate**

Run: `npm run verify`
Expected: typecheck + test + build all pass. If the TUI typecheck fails on the SDK `Part` union for `part.state`, apply the cast noted in Step 3.

- [ ] **Step 6: Commit**

```bash
git add src/tui.tsx test/entrypoints.test.ts
git commit -m "feat: session analysis sidebar and live activity wiring"
```

---

### Task 7: Documentation and final verification

**Files:**
- Modify: `AGENTS.md`

**Interfaces:**
- Consumes: nothing new.
- Produces: updated architecture notes.

- [ ] **Step 1: Update AGENTS.md**

In the Architecture section, add `src/activity.ts` / `src/activity-hydrate.ts` next to the other source files:

```markdown
- `src/activity.ts` — session activity metrics (tool calls, skills, auto-compactions, steps) with per-metric keyed dedup; `src/activity-hydrate.ts` — history backfill via `session.list()`/`session.messages()`.
```

(Add this bullet after the `src/metrics.ts` bullet, keeping the existing bullet style.)

- [ ] **Step 2: Run the full verify gate**

Run: `npm run verify`
Expected: typecheck && test && build all pass.

- [ ] **Step 3: Commit**

```bash
git add AGENTS.md
git commit -m "docs: note session activity modules in architecture"
```

---

### Task 8: Manual smoke check in the TUI

**Files:** none (manual verification).

**Interfaces:**
- Consumes: the built plugin from Task 6.

- [ ] **Step 1: Build**

Run: `npm run build`
Expected: `dist/` produced for `index`, `tui`, `cli`.

- [ ] **Step 2: Manual smoke test**

With an opencode session that has spawned subagents (or spawn one via the `task` tool), check:

1. Subagent rows append `· N calls` (and other non-zero metrics) after `ctx N tokens`.
2. The sidebar shows `▼ Session Analysis` with a brief line like `18 calls · 2 auto-compacts · 1 error · 3 skills` once the session has activity.
3. Clicking the title toggles collapse; clicking the brief line opens the dialog.
4. The dialog shows the tree sections (Tools, Skills, Auto-compactions, Tool errors, Model calls, Subagents) with indentation; the scrollbar appears when content overflows; `esc` closes it.
5. Navigate away from the session and back: the section still shows data (backfill path).
6. Rows for subagents with no activity show the old format (`duration · ctx N tokens`).

- [ ] **Step 3: Commit any fix-ups found during the smoke test**

```bash
git add -A
git commit -m "fix: session analysis smoke-test corrections"
```

(Only if fixes were needed; otherwise skip this step.)
