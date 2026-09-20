import { describe, expect, test } from "vitest";
import { createActivityState, recordToolPart } from "../src/activity.js";
import {
  applySubagentEvent as applySubagentEventV2,
  createSubagentState,
  getSubagentSidebarRowAtLine,
  getSubagentSidebarModel,
  pruneStaleSubagents,
  renderSubagentFooter,
  renderSubagentSidebar,
  renderSubagentStatus
} from "../src/subagents.js";

function applySubagentEvent(state: Parameters<typeof applySubagentEventV2>[0], event: Record<string, unknown>) {
  const properties = event.properties as Record<string, unknown> | undefined;
  const info = properties?.info as Record<string, unknown> | undefined;
  if (info?.id && info.parentID) {
    const time = info.time as Record<string, unknown> | undefined;
    applySubagentEventV2(state, {
      type: "session.created", created: time?.created ?? 0,
      data: { sessionID: info.id, parentID: info.parentID, title: info.title ?? info.name, tokens: info.tokens }
    });
    if (time?.completed !== undefined) applySubagentEventV2(state, { type: "session.execution.succeeded", created: time.completed, data: { sessionID: info.id } });
    if (info.error !== undefined) applySubagentEventV2(state, { type: "session.execution.failed", created: time?.updated ?? 0, data: { sessionID: info.id } });
    return;
  }
  if (event.type === "message.updated") {
    const info = properties?.info as Record<string, unknown> | undefined;
    const time = info?.time as Record<string, unknown> | undefined;
    applySubagentEventV2(state, { type: "session.step.ended", created: time?.completed ?? 0, data: { sessionID: info?.sessionID, tokens: info?.tokens } });
    return;
  }
  if (event.type === "session.created" && properties?.sessionID && info) {
    const time = info.time as Record<string, unknown> | undefined;
    applySubagentEventV2(state, { type: "session.created", created: time?.created ?? 0, data: { sessionID: info.id, parentID: info.parentID, title: info.title, tokens: info.tokens } });
    return;
  }
  if (properties?.sessionID) {
    if (event.type === "session.idle") return;
    applySubagentEventV2(state, { type: event.type === "session.error" ? "session.execution.failed" : event.type, data: { sessionID: properties.sessionID } });
    return;
  }
  const part = properties?.part as Record<string, unknown> | undefined;
  const taskState = part?.state as Record<string, unknown> | undefined;
  const metadata = taskState?.metadata as Record<string, unknown> | undefined;
  if (part?.tool === "task" && metadata?.sessionId && metadata.parentSessionId) {
    const input = taskState?.input as Record<string, unknown> | undefined;
    applySubagentEventV2(state, { type: "session.created", created: (taskState?.time as Record<string, unknown> | undefined)?.start ?? 0, data: { sessionID: metadata.sessionId, parentID: metadata.parentSessionId, title: taskState?.title ?? input?.description, tokens: taskState?.tokens } });
    if (taskState?.status === "completed") applySubagentEventV2(state, { type: "session.execution.succeeded", created: (taskState?.time as Record<string, unknown> | undefined)?.end ?? 0, data: { sessionID: metadata.sessionId } });
    return;
  }
  applySubagentEventV2(state, event);
}

describe("subagent status", () => {
  test("finds the sidebar row for either line of a rendered subagent", () => {
    const model = {
      title: "Subagents",
      summary: "1 running · 1 done · 0 error",
      rows: [
        { id: "ses_first", title: "First", subtitle: "00:01", status: "running" as const },
        { id: "ses_second", title: "Second", subtitle: "00:02", status: "done" as const }
      ]
    };

    expect(getSubagentSidebarRowAtLine(model, 0)).toBeUndefined();
    expect(getSubagentSidebarRowAtLine(model, 1)).toBeUndefined();
    expect(getSubagentSidebarRowAtLine(model, 2)?.id).toBe("ses_first");
    expect(getSubagentSidebarRowAtLine(model, 3)?.id).toBe("ses_first");
    expect(getSubagentSidebarRowAtLine(model, 4)).toBeUndefined();
    expect(getSubagentSidebarRowAtLine(model, 5)?.id).toBe("ses_second");
    expect(getSubagentSidebarRowAtLine(model, 6)?.id).toBe("ses_second");
  });

  test("tracks running, completed, and failed subagents", () => {
    const state = createSubagentState();

    applySubagentEvent(state, {
      type: "session.updated",
      properties: {
        info: {
          id: "ses_child_1",
          parentID: "ses_parent",
          title: "Review tests",
          time: { created: 1_000 }
        }
      }
    });
    applySubagentEvent(state, {
      type: "session.updated",
      properties: {
        info: {
          id: "ses_child_1",
          parentID: "ses_parent",
          title: "Review tests",
          time: { created: 1_000, completed: 4_000 },
          tokens: { input: 100, output: 25 }
        }
      }
    });
    applySubagentEvent(state, {
      type: "session.updated",
      properties: {
        info: {
          id: "ses_child_2",
          parentID: "ses_parent",
          title: "Run build",
          time: { created: 2_000 },
          error: "failed"
        }
      }
    });

    expect(renderSubagentStatus(state, { now: 5_000 })).toContain("0 running · 1 done · 1 failed · 2 total");
  });

  test("tracks v2 session events from data instead of properties", () => {
    const state = createSubagentState();
    applySubagentEvent(state, {
      type: "session.created",
      data: {
        sessionID: "ses_child_v2", parentID: "ses_parent", title: "V2 task"
      },
      created: 1_000
    });
    applySubagentEvent(state, {
      type: "session.execution.failed",
      data: { sessionID: "ses_child_v2", error: { message: "failed" } }
    });
    expect(renderSubagentFooter(state, "ses_parent", { now: 2_000 })).toBe("Subagents 0 running · 0 done · 1 error");
  });

  test("renders the active parent session children in the sidebar", () => {
    const state = createSubagentState();

    applySubagentEvent(state, {
      type: "session.updated",
      properties: {
        info: {
          id: "ses_child_running",
          parentID: "ses_parent",
          title: "Review tests and inspect flaky build logs",
          time: { created: 1_000, updated: 3_000 },
          tokens: { input: 100, output: 25, reasoning: 10, cache: { read: 5, write: 1 } }
        }
      }
    });
    applySubagentEvent(state, {
      type: "session.updated",
      properties: {
        info: {
          id: "ses_child_done",
          parentID: "ses_parent",
          title: "Run build",
          time: { created: 2_000, completed: 5_000 },
          tokens: { input: 20, output: 5 }
        }
      }
    });
    applySubagentEvent(state, {
      type: "session.updated",
      properties: {
        info: {
          id: "ses_other_child",
          parentID: "ses_other_parent",
          title: "Should not show",
          time: { created: 2_000 }
        }
      }
    });

    expect(renderSubagentSidebar(state, "ses_parent", { now: 6_000 })).toBe(
      [
        "Subagents",
        "1 running · 1 done · 0 error",
        "Review tests and ...flaky build logs",
        "00:05 · ctx 141 tokens",
        "Run build",
        "00:03 · ctx 25 tokens"
      ].join("\n")
    );
    expect(renderSubagentFooter(state, "ses_parent", { now: 6_000 })).toBe(
      "Subagents 1 running · 1 done · 0 error"
    );
  });

  test("keeps existing subagents running through idle status until terminal events", () => {
    const state = createSubagentState();

    applySubagentEvent(state, {
      type: "session.created",
      properties: {
        info: {
          id: "ses_child_1",
          parentID: "ses_parent",
          title: "Audit implementation",
          time: { created: 1_000 }
        }
      }
    });
    applySubagentEvent(state, {
      type: "session.status",
      properties: {
        sessionID: "ses_child_1",
        status: { type: "busy" }
      }
    });

    expect(renderSubagentFooter(state, "ses_parent", { now: 2_000 })).toBe(
      "Subagents 1 running · 0 done · 0 error"
    );

    applySubagentEvent(state, {
      type: "session.idle",
      properties: {
        sessionID: "ses_child_1"
      }
    });

    expect(renderSubagentFooter(state, "ses_parent", { now: 5_000 })).toBe(
      "Subagents 1 running · 0 done · 0 error"
    );
    expect(getSubagentSidebarModel(state, "ses_parent", { now: 5_000 })?.rows[0]).toMatchObject({
      status: "running",
      subtitle: "00:04"
    });

    applySubagentEvent(state, {
      type: "session.error",
      properties: {
        sessionID: "ses_child_1"
      }
    });

    expect(renderSubagentFooter(state, "ses_parent", { now: 5_000 })).toBe(
      "Subagents 0 running · 0 done · 1 error"
    );
  });

  test("keeps child subagent running after completed assistant message update", () => {
    const state = createSubagentState();

    applySubagentEvent(state, { type: "session.created", created: 1_000, data: { sessionID: "ses_child_1", parentID: "ses_parent", title: "Say hi (@general subagent)" } });

    applySubagentEvent(state, { type: "session.step.ended", created: 4_700, data: { sessionID: "ses_child_1", tokens: { input: 75, output: 7, reasoning: 2, cache: { read: 33_408, write: 0 } } } });

    expect(getSubagentSidebarModel(state, "ses_parent", { now: 5_000 })).toEqual({
      title: "Subagents",
      summary: "1 running · 0 done · 0 error",
      rows: [
        {
          id: "ses_child_1",
          title: "Say hi (@general subagent)",
          subtitle: "00:04 · ctx 33,492 tokens",
          status: "running"
        }
      ]
    });
  });

  test("uses parent task tool completion as authoritative subagent status", () => {
    const state = createSubagentState();

    applySubagentEvent(state, {
      type: "session.tool.called",
      data: {
        sessionID: "ses_parent",
        id: "task_1",
        input: { description: "Say hi", subagent_type: "general" },
        metadata: { parentSessionId: "ses_parent", sessionId: "ses_child_1" }
      }
    });

    expect(getSubagentSidebarModel(state, "ses_parent", { now: 2_000 })).toMatchObject({
      summary: "1 running · 0 done · 0 error",
      rows: [{ id: "ses_child_1", title: "General: Say hi", status: "running" }]
    });

    applySubagentEvent(state, {
      type: "session.tool.success", created: 4_700,
      data: {
        sessionID: "ses_parent",
        id: "task_1",
        metadata: { parentSessionId: "ses_parent", sessionId: "ses_child_1" },
        content: [{ type: "text", text: "hi" }]
      }
    });

    expect(getSubagentSidebarModel(state, "ses_parent", { now: 5_000 })).toMatchObject({
      title: "Subagents",
      summary: "0 running · 1 done · 0 error",
      rows: [{ id: "ses_child_1", status: "done" }]
    });
  });

  test("omits the sidebar for parents without subagents", () => {
    const state = createSubagentState();

    applySubagentEvent(state, {
      type: "session.updated",
      properties: {
        info: {
          id: "ses_child_1",
          parentID: "ses_parent",
          title: "Review tests",
          time: { created: 1_000 }
        }
      }
    });

    expect(renderSubagentSidebar(state, "ses_other_parent")).toBe("");
    expect(renderSubagentFooter(state, "ses_other_parent")).toBe("");
  });

  test("keeps session.updated idle payloads running", () => {
    const state = createSubagentState();

    applySubagentEvent(state, {
      type: "session.updated",
      properties: {
        info: {
          id: "ses_child_1",
          parentID: "ses_parent",
          title: "Review tests",
          status: "idle",
          time: { created: 1_000, updated: 4_000 }
        }
      }
    });

    expect(renderSubagentFooter(state, "ses_parent", { now: 5_000 })).toBe(
      "Subagents 1 running · 0 done · 0 error"
    );
    expect(renderSubagentSidebar(state, "ses_parent", { now: 5_000 })).toBe(
      ["Subagents", "1 running · 0 done · 0 error", "Review tests", "00:04"].join("\n")
    );
  });

  test("formats subagent row as title and subtitle using agent display name", () => {
    const state = createSubagentState();

    applySubagentEvent(state, {
      type: "session.updated",
      properties: {
        info: {
          id: "ses_child_1",
          parentID: "ses_parent",
          title: "✓General Task — Say hi subagent",
          time: { created: 1_000, updated: 4_000 },
          tokens: { input: 12, output: 8 }
        }
      }
    });

    expect(getSubagentSidebarModel(state, "ses_parent", { now: 6_000 })).toEqual({
      title: "Subagents",
      summary: "1 running · 0 done · 0 error",
      rows: [
        {
          id: "ses_child_1",
          title: "General Task: Say hi subagent",
          subtitle: "00:05 · ctx 20 tokens",
          status: "running"
        }
      ]
    });
  });

  test("prunes closed subagents after three idle minutes", () => {
    const state = createSubagentState();

    applySubagentEvent(state, {
      type: "session.updated",
      properties: {
        info: {
          id: "ses_done_recent",
          parentID: "ses_parent",
          title: "Recent done",
          time: { created: 1_000, completed: 120_000 }
        }
      }
    });
    applySubagentEvent(state, {
      type: "session.updated",
      properties: {
        info: {
          id: "ses_done_stale",
          parentID: "ses_parent",
          title: "Stale done",
          time: { created: 1_000, completed: 60_000 }
        }
      }
    });
    applySubagentEvent(state, {
      type: "session.updated",
      properties: {
        info: {
          id: "ses_running_old",
          parentID: "ses_parent",
          title: "Still running",
          time: { created: 1_000, updated: 60_000 }
        }
      }
    });

    expect(pruneStaleSubagents(state, { now: 240_001 })).toBe(true);
    expect(getSubagentSidebarModel(state, "ses_parent", { now: 240_001 })?.rows.map((row) => row.id)).toEqual([
      "ses_running_old",
      "ses_done_recent"
    ]);
  });
});

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
      "00:05 · ctx 20 tokens · 2 tool calls"
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
