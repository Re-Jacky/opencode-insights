import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { createActivityState, recordChild, treeActivity } from "../src/activity.js";
import { createSubagentState, getSubagentSidebarModel } from "../src/subagents.js";
import { createListenerRegistry } from "../src/listeners.js";
import { hasRenderStateChanged } from "../src/render-state.js";

describe("TUI listener registry", () => {
  test("notifies only listeners registered with the matching registry", () => {
    const metrics = createListenerRegistry();
    const subagents = createListenerRegistry();
    let metricUpdates = 0;
    let subagentUpdates = 0;

    metrics.subscribe(() => metricUpdates++);
    subagents.subscribe(() => subagentUpdates++);

    metrics.notify();

    expect(metricUpdates).toBe(1);
    expect(subagentUpdates).toBe(0);
  });

  test("detects only visual sidebar state changes", () => {
    const state = { content: "Subagents", visible: true, height: "auto" as const };

    expect(hasRenderStateChanged(state, { ...state })).toBe(false);
    expect(hasRenderStateChanged(state, { ...state, content: "Subagents\n1 running" })).toBe(true);
  });
});

describe("v2 TUI contract", () => {
  test("uses v2 context APIs and does not retain v1 APIs", () => {
    const source = readFileSync(new URL("../src/tui.tsx", import.meta.url), "utf8");

    expect(source).toContain("context.data.on");
    expect(source).toContain("context.ui.slot");
    expect(source).toContain("context.ui.router.navigate");
    expect(source).toContain("context.ui.dialog");
    expect(source).toContain("return async () =>");
    expect(source).not.toContain("@opencode-ai/plugin/tui");
    expect(source).not.toContain("api.slots.register");
    expect(source).not.toContain("api.route.navigate");
    expect(source).not.toContain("api.lifecycle.onDispose");
    expect(source).not.toMatch(/slot\.(input|sidebar|footer|prompt)/);
    expect(source).toContain("context.theme.text");
    expect(source).not.toContain('fg="text"');
    expect(source).not.toContain('fg="textMuted"');
    expect(source).not.toContain('tool: "tool"');
    expect(source).toContain("applySubagentEvent");
    expect(source).toContain("goTracker.record");
    expect(source).toContain("copilotTracker.record");
    expect(source).toContain("context.data.session.message.list");
  });

  test("preserves v2 subagent and activity state when events are normalized", () => {
    const activity = createActivityState();
    const state = createSubagentState(activity);
    const child = { id: "ses_child", parentID: "ses_root", title: "Review", status: "running" as const, startedAt: new Date(1_000).toISOString(), updatedAt: new Date(1_000).toISOString() };
    state.children[child.id] = { ...child, activity: { toolCalls: 1, toolBreakdown: { bash: 1 }, warnings: 0, warningDetails: [], skills: {}, autoCompacts: 0, steps: 0 } };
    recordChild(activity, child.id, child.parentID);
    activity.bySessionID[child.id] = { toolCalls: 1, toolBreakdown: { bash: 1 }, warnings: 0, warningDetails: [], skills: {}, autoCompacts: 0, steps: 0 };

    expect(getSubagentSidebarModel(state, "ses_root")?.rows[0]?.subtitle).toContain("tool call");
    expect(treeActivity(activity, "ses_root").toolBreakdown).toEqual({ bash: 1 });
  });

  test("keeps setup lifecycle and runtime entrypoint assertions enabled", () => {
    const source = readFileSync(new URL("../src/tui.tsx", import.meta.url), "utf8");
    expect(source).toContain("const setup = async (context: Context)");
    expect(source).toContain("context.ui.slot");
    expect(source).toContain("return async () =>");
    expect(source).toContain("disposed");
    expect(source).toContain("context.ui.dialog.show");
  });
});
