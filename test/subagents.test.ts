import { describe, expect, test } from "vitest";
import {
  applySubagentEvent,
  createSubagentState,
  getSubagentSidebarModel,
  pruneStaleSubagents,
  renderSubagentFooter,
  renderSubagentSidebar,
  renderSubagentStatus
} from "../src/subagents.js";

describe("subagent status", () => {
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

    expect(renderSubagentStatus(state, { now: 5_000 })).toBe(
      "0 running · 1 done · 1 failed · 2 total · Run build 00:03 · Review tests 00:03 ctx 125 tokens"
    );
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

    applySubagentEvent(state, {
      type: "session.created",
      properties: {
        sessionID: "ses_child_1",
        info: {
          id: "ses_child_1",
          parentID: "ses_parent",
          title: "Say hi (@general subagent)",
          agent: "general",
          time: { created: 1_000, updated: 1_000 },
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
        }
      }
    });

    applySubagentEvent(state, {
      type: "message.updated",
      properties: {
        sessionID: "ses_child_1",
        info: {
          id: "msg_child_assistant",
          sessionID: "ses_child_1",
          parentID: "msg_child_user",
          role: "assistant",
          time: { created: 2_000, completed: 4_700 },
          finish: "stop",
          tokens: { input: 75, output: 7, reasoning: 2, cache: { read: 33_408, write: 0 } }
        }
      }
    });

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
      type: "message.part.updated",
      properties: {
        sessionID: "ses_parent",
        part: {
          type: "tool",
          tool: "task",
          state: {
            status: "running",
            title: "Say hi",
            input: { description: "Say hi", subagent_type: "general" },
            metadata: {
              parentSessionId: "ses_parent",
              sessionId: "ses_child_1"
            },
            time: { start: 1_000 }
          }
        }
      }
    });

    expect(getSubagentSidebarModel(state, "ses_parent", { now: 2_000 })).toMatchObject({
      summary: "1 running · 0 done · 0 error",
      rows: [{ id: "ses_child_1", title: "General: Say hi", status: "running" }]
    });

    applySubagentEvent(state, {
      type: "message.part.updated",
      properties: {
        sessionID: "ses_parent",
        part: {
          type: "tool",
          tool: "task",
          state: {
            status: "completed",
            input: { description: "Say hi", subagent_type: "general" },
            output: "<task id=\"ses_child_1\" state=\"completed\">hi</task>",
            metadata: {
              parentSessionId: "ses_parent",
              sessionId: "ses_child_1"
            },
            title: "Say hi",
            time: { start: 1_000, end: 4_700 }
          }
        }
      }
    });

    applySubagentEvent(state, {
      type: "session.updated",
      properties: {
        sessionID: "ses_child_1",
        info: {
          id: "ses_child_1",
          parentID: "ses_parent",
          title: "Say hi (@general subagent)",
          agent: "general",
          time: { created: 1_000, updated: 4_900 },
          tokens: { input: 75, output: 7, reasoning: 2, cache: { read: 33_408, write: 0 } }
        }
      }
    });

    expect(getSubagentSidebarModel(state, "ses_parent", { now: 5_000 })).toEqual({
      title: "Subagents",
      summary: "0 running · 1 done · 0 error",
      rows: [
        {
          id: "ses_child_1",
          title: "General: Say hi",
          subtitle: "00:03 · ctx 33,492 tokens",
          status: "done"
        }
      ]
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
