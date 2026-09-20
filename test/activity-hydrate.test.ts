import { describe, expect, test } from "vitest";
import { createActivityState } from "../src/activity.js";
import { hydrateActivity, type ActivityClient } from "../src/activity-hydrate.js";

function makeClient(
  sessions: Array<{ id: string; parentID?: string; title?: string }> = [],
  messages: (sessionID: string) => Array<{ parts?: Array<Record<string, unknown>> }> = () => []
): ActivityClient {
  return { session: { list: () => sessions }, message: { list: messages } };
}

describe("hydrateActivity", () => {
  test("hydrates through the v2 data cache session methods", async () => {
    const state = createActivityState();
    await hydrateActivity(makeClient([{ id: "ses_root" }], () => [{ parts: [{ id: "prt_t1", type: "tool", tool: "bash" }] }]), state, "ses_root");
    expect(state.bySessionID["ses_root"]?.toolCalls).toBe(1);
  });

  test("preserves the v2 tool name and activity breakdown during hydration", async () => {
    const state = createActivityState();
    await hydrateActivity(makeClient([{ id: "ses_root" }], () => [{ parts: [{ id: "prt_t1", type: "tool", tool: "bash", state: { status: "completed" } }] }]), state, "ses_root");
    expect(state.bySessionID["ses_root"]?.toolBreakdown).toEqual({ bash: 1 });
  });

  test("seeds childrenByParent and titles", async () => {
    const state = createActivityState();
    await hydrateActivity(makeClient([
      { id: "ses_root", title: "Main" },
      { id: "ses_a", parentID: "ses_root", title: "T3" },
      { id: "ses_b", parentID: "ses_a", title: "child" }
    ]), state, "ses_root");
    expect(state.childrenByParent["ses_root"]).toEqual(["ses_a"]);
    expect(state.childrenByParent["ses_a"]).toEqual(["ses_b"]);
    expect(state.titles["ses_a"]).toBe("T3");
  });

  test("backfills tool, compaction, and step counts", async () => {
    const state = createActivityState();
    await hydrateActivity(makeClient([
      { id: "ses_root" }, { id: "ses_a", parentID: "ses_root" }
    ], (sessionID) => sessionID === "ses_a" ? [{ parts: [
      { id: "prt_t1", type: "tool", tool: "bash" },
      { id: "prt_c1", type: "compaction", reason: "auto" },
      { id: "prt_s1", type: "step" }
    ] }] : []), state, "ses_root");
    expect(state.bySessionID["ses_a"]?.toolCalls).toBe(1);
    expect(state.bySessionID["ses_a"]?.autoCompacts).toBe(1);
    expect(state.bySessionID["ses_a"]?.steps).toBe(1);
    expect(state.hydrated.has("ses_a")).toBe(true);
  });

  test("does not double count parts seen live before backfill", async () => {
    const state = createActivityState();
    state.bySessionID["ses_a"] = { toolCalls: 1, toolBreakdown: { bash: 1 }, warnings: 0, warningDetails: [], skills: {}, autoCompacts: 0, steps: 0 };
    state.seenKeys["ses_a"] = new Set(["tool:prt_t1"]);
    await hydrateActivity(makeClient([{ id: "ses_root" }, { id: "ses_a", parentID: "ses_root" }], () => [{ parts: [{ id: "prt_t1", type: "tool", tool: "bash" }] }]), state, "ses_root");
    expect(state.bySessionID["ses_a"]?.toolCalls).toBe(1);
  });

  test("backfills warning messages from tool part state", async () => {
    const state = createActivityState();
    await hydrateActivity(makeClient([{ id: "ses_root" }, { id: "ses_a", parentID: "ses_root" }], () => [{ parts: [{ id: "prt_e1", type: "tool", tool: "bash", state: { status: "error", error: "command exited with code 1" } }] }]), state, "ses_root");
    expect(state.bySessionID["ses_a"]?.warnings).toBe(1);
  });

  test("hydrates v2 compaction reason and completed step parts without double counting", async () => {
    const state = createActivityState();
    await hydrateActivity(makeClient([{ id: "ses_root" }], () => [{ parts: [
      { id: "cmp_1", type: "compaction", reason: "auto", status: "completed" },
      { id: "step_1", type: "step", status: "completed" }
    ] }]), state, "ses_root");
    expect(state.bySessionID["ses_root"]).toMatchObject({ autoCompacts: 1, steps: 1 });
  });

  test("skips already hydrated sessions", async () => {
    const state = createActivityState();
    state.hydrated.add("ses_root");
    let calls = 0;
    await hydrateActivity(makeClient([{ id: "ses_root" }], () => { calls += 1; return []; }), state, "ses_root");
    expect(calls).toBe(0);
  });

  test("marks loading during the fetch and clears it after", async () => {
    const state = createActivityState();
    await hydrateActivity(makeClient([{ id: "ses_root" }], () => { expect(state.loading.has("ses_root")).toBe(true); return []; }), state, "ses_root");
    expect(state.loading.size).toBe(0);
    expect(state.hydrated.has("ses_root")).toBe(true);
  });

  test("does not mark hydrated when messages fail", async () => {
    const state = createActivityState();
    await hydrateActivity(makeClient([{ id: "ses_root" }], () => { throw new Error("boom"); }), state, "ses_root");
    expect(state.hydrated.has("ses_root")).toBe(false);
    expect(state.loading.size).toBe(0);
  });

  test("ignores non-session root ids", async () => {
    const state = createActivityState();
    let calls = 0;
    await hydrateActivity(makeClient([], () => { calls += 1; return []; }), state, "not-a-session");
    expect(calls).toBe(0);
  });
});
