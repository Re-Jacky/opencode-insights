import { describe, expect, test } from "vitest";
import { createActivityState, recordToolPart } from "../src/activity.js";
import { applySubagentEvent, createSubagentState, getSubagentSidebarModel, getSubagentSidebarRowAtLine, pruneStaleSubagents, renderSubagentFooter, renderSubagentStatus, renderSubagentSidebar } from "../src/subagents.js";

const created = (title = "Review tests") => ({
  id: "evt_created", created: 1_000, type: "session.created",
  data: { sessionID: "ses_child", parentID: "ses_parent", title }
});

describe("v2 subagent status", () => {
  test("maps sidebar rows and preserves exact v2 rendering details", () => {
    const state = createSubagentState();
    applySubagentEvent(state, { ...created("✓General Task — Say hi"), data: { ...created().data, title: "✓General Task — Say hi" } });
    expect(getSubagentSidebarRowAtLine(getSubagentSidebarModel(state, "ses_parent")!, 2)?.id).toBe("ses_child");
    expect(renderSubagentSidebar(state, "ses_parent", { now: 6_000 })).toBe(["Subagents", "1 running · 0 done · 0 error", "General Task: Say hi", "00:05"].join("\n"));
    expect(renderSubagentStatus(state, { now: 6_000 })).toContain("1 running · 0 done · 0 failed · 1 total");
  });

  test("keeps terminal state and prunes stale children without affecting active children", () => {
    const state = createSubagentState();
    applySubagentEvent(state, created("Recent"));
    applySubagentEvent(state, { id: "evt_done", created: 2_000, type: "session.execution.succeeded", data: { sessionID: "ses_child" } });
    expect(renderSubagentFooter(state, "ses_parent", { now: 3_000 })).toBe("Subagents 0 running · 1 done · 0 error");
    expect(pruneStaleSubagents(state, { now: 200_001, staleMs: 180_000 })).toBe(true);
    expect(getSubagentSidebarModel(state, "ses_parent")).toBeUndefined();
    expect(renderSubagentFooter(state, "missing")).toBe("");
  });
  test("uses published session execution lifecycle events", () => {
    const state = createSubagentState();
    applySubagentEvent(state, created());
    applySubagentEvent(state, { id: "evt_failed", created: 4_000, type: "session.execution.failed", data: { sessionID: "ses_child", error: { type: "error", message: "failed" } } });
    expect(renderSubagentFooter(state, "ses_parent", { now: 5_000 })).toBe("Subagents 0 running · 0 done · 1 error");
    expect(getSubagentSidebarModel(state, "ses_parent", { now: 5_000 })?.rows[0]).toMatchObject({ id: "ses_child", title: "Review tests", status: "error", subtitle: "00:03" });
  });

  test("resolves task identity from the persisted assistant tool part", () => {
    const state = createSubagentState();
    const part = { type: "tool", id: "tool_1", name: "task", state: { status: "running", input: { description: "Say hi", subagent_type: "general" }, metadata: { sessionId: "ses_child", parentSessionId: "ses_parent" }, time: { start: 1_000 } } };
    applySubagentEvent(state, { id: "evt_tool", created: 1_000, type: "session.tool.called", data: { sessionID: "ses_parent", assistantMessageID: "msg_parent", id: "tool_1", input: {}, executed: false } }, part);
    expect(getSubagentSidebarModel(state, "ses_parent", { now: 2_000 })).toMatchObject({ rows: [{ id: "ses_child", title: "General: Say hi", status: "running", subtitle: "00:01" }] });
  });

  test("does not invent task identity from an event-only terminal payload", () => {
    const state = createSubagentState();
    applySubagentEvent(state, { id: "evt_tool", created: 1_000, type: "session.tool.called", data: { sessionID: "ses_parent", assistantMessageID: "msg_parent", id: "tool_1", input: { description: "Say hi" }, executed: false } });
    expect(getSubagentSidebarModel(state, "ses_parent")).toBeUndefined();
  });

  test("preserves activity suffix on v2 task children", () => {
    const activity = createActivityState();
    const state = createSubagentState(activity);
    recordToolPart(activity, "ses_child", { id: "tool_activity", tool: "bash" });
    applySubagentEvent(state, created());
    expect(getSubagentSidebarModel(state, "ses_parent", { now: 2_000 })?.rows[0]?.subtitle).toBe("00:01 · 1 tool call");
  });
});
