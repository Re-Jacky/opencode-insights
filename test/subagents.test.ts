import { describe, expect, test } from "vitest";
import { createActivityState, recordToolPart } from "../src/activity.js";
import {
  applySubagentEvent,
  createSubagentState,
  getSubagentSidebarModel,
  getSubagentSidebarRowAtLine,
  pruneStaleSubagents,
  renderSubagentFooter,
  renderSubagentSidebar,
  renderSubagentStatus
} from "../src/subagents.js";

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

  test("renames an existing subagent from session.renamed", () => {
    const state = createSubagentState();
    applySubagentEvent(state, created());
    expect(
      applySubagentEvent(state, { type: "session.renamed", created: 5, data: { sessionID: "ses_child", title: "New name" } })
    ).toBe(true);
    expect(state.children["ses_child"]?.title).toBe("New name");
  });

  test("ignores partial events without throwing", () => {
    const state = createSubagentState();
    expect(applySubagentEvent(state, { type: "session.idle" })).toBe(false);
    expect(applySubagentEvent(state, undefined)).toBe(false);
    expect(applySubagentEvent(state, { type: "session.created", data: { parentID: "ses_root" } })).toBe(false);
    expect(getSubagentSidebarModel(state, "ses_root")).toBeUndefined();
  });
});

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
      type: "session.created",
      created: 1_000,
      data: { sessionID: "ses_child_1", parentID: "ses_parent", title: "Review tests" }
    });
    applySubagentEvent(state, {
      type: "session.usage.updated",
      created: 4_000,
      data: { sessionID: "ses_child_1", tokens: { input: 100, output: 25 } }
    });
    applySubagentEvent(state, { type: "session.idle", created: 4_000, data: { sessionID: "ses_child_1" } });
    applySubagentEvent(state, {
      type: "session.created",
      created: 2_000,
      data: { sessionID: "ses_child_2", parentID: "ses_parent", title: "Run build" }
    });
    applySubagentEvent(state, { type: "session.execution.failed", created: 5_000, data: { sessionID: "ses_child_2" } });

    expect(renderSubagentStatus(state, { now: 5_000 })).toBe(
      "0 running · 1 done · 1 failed · 2 total · Run build 00:03 · Review tests 00:03 ctx 125 tokens"
    );
  });

  test("renders the active parent session children in the sidebar", () => {
    const state = createSubagentState();

    applySubagentEvent(state, {
      type: "session.created",
      created: 1_000,
      data: {
        sessionID: "ses_child_running",
        parentID: "ses_parent",
        title: "Review tests and inspect flaky build logs"
      }
    });
    applySubagentEvent(state, {
      type: "session.usage.updated",
      created: 3_000,
      data: {
        sessionID: "ses_child_running",
        tokens: { input: 100, output: 25, reasoning: 10, cache: { read: 5, write: 1 } }
      }
    });
    applySubagentEvent(state, {
      type: "session.created",
      created: 2_000,
      data: { sessionID: "ses_child_done", parentID: "ses_parent", title: "Run build" }
    });
    applySubagentEvent(state, {
      type: "session.usage.updated",
      created: 4_000,
      data: { sessionID: "ses_child_done", tokens: { input: 20, output: 5 } }
    });
    applySubagentEvent(state, { type: "session.idle", created: 5_000, data: { sessionID: "ses_child_done" } });
    applySubagentEvent(state, {
      type: "session.created",
      created: 2_000,
      data: { sessionID: "ses_other_child", parentID: "ses_other_parent", title: "Should not show" }
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

  test("omits the sidebar for parents without subagents", () => {
    const state = createSubagentState();

    applySubagentEvent(state, {
      type: "session.created",
      created: 1_000,
      data: { sessionID: "ses_child_1", parentID: "ses_parent", title: "Review tests" }
    });

    expect(renderSubagentSidebar(state, "ses_other_parent")).toBe("");
    expect(renderSubagentFooter(state, "ses_other_parent")).toBe("");
  });

  test("formats subagent row as title and subtitle using agent display name", () => {
    const state = createSubagentState();

    applySubagentEvent(state, {
      type: "session.created",
      created: 1_000,
      data: { sessionID: "ses_child_1", parentID: "ses_parent", title: "✓General Task — Say hi subagent" }
    });
    applySubagentEvent(state, {
      type: "session.usage.updated",
      created: 4_000,
      data: { sessionID: "ses_child_1", tokens: { input: 12, output: 8 } }
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
      type: "session.created",
      created: 1_000,
      data: { sessionID: "ses_done_recent", parentID: "ses_parent", title: "Recent done" }
    });
    applySubagentEvent(state, { type: "session.idle", created: 120_000, data: { sessionID: "ses_done_recent" } });
    applySubagentEvent(state, {
      type: "session.created",
      created: 1_000,
      data: { sessionID: "ses_done_stale", parentID: "ses_parent", title: "Stale done" }
    });
    applySubagentEvent(state, { type: "session.idle", created: 60_000, data: { sessionID: "ses_done_stale" } });
    applySubagentEvent(state, {
      type: "session.created",
      created: 1_000,
      data: { sessionID: "ses_running_old", parentID: "ses_parent", title: "Still running" }
    });
    applySubagentEvent(state, { type: "session.status", created: 60_000, data: { sessionID: "ses_running_old", status: { type: "busy" } } });

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
      type: "session.created",
      created: 1_000,
      data: { sessionID: "ses_child_1", parentID: "ses_parent", title: "Review tests" }
    });
    applySubagentEvent(state, {
      type: "session.usage.updated",
      created: 1_000,
      data: { sessionID: "ses_child_1", tokens: { input: 12, output: 8 } }
    });

    expect(getSubagentSidebarModel(state, "ses_parent", { now: 6_000 })?.rows[0]?.subtitle).toBe(
      "00:05 · ctx 20 tokens · 2 tool calls"
    );
  });

  test("keeps subtitle unchanged when the subagent has no activity", () => {
    const activity = createActivityState();
    const state = createSubagentState(activity);

    applySubagentEvent(state, {
      type: "session.created",
      created: 1_000,
      data: { sessionID: "ses_child_1", parentID: "ses_parent", title: "Review tests" }
    });
    applySubagentEvent(state, {
      type: "session.usage.updated",
      created: 1_000,
      data: { sessionID: "ses_child_1", tokens: { input: 12, output: 8 } }
    });

    expect(getSubagentSidebarModel(state, "ses_parent", { now: 6_000 })?.rows[0]?.subtitle).toBe(
      "00:05 · ctx 20 tokens"
    );
  });

  test("attaches a live activity record created on demand", () => {
    const activity = createActivityState();
    const state = createSubagentState(activity);

    applySubagentEvent(state, {
      type: "session.created",
      created: 1_000,
      data: { sessionID: "ses_child_1", parentID: "ses_parent", title: "X" }
    });

    expect(activity.bySessionID["ses_child_1"]).toBeDefined();
    expect(state.children["ses_child_1"]?.activity).toBe(activity.bySessionID["ses_child_1"]);
  });
});
