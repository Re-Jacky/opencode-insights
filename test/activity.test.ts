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
