import { describe, expect, test } from "vitest";
import {
  buildSessionAnalysisRows,
  createActivityState,
  emptyActivity,
  formatActivityBrief,
  formatActivitySuffix,
  formatSubagentCount,
  hasActivity,
  mergeActivity,
  recordChild,
  recordCompaction,
  recordStep,
  recordToolPart,
  treeActivity,
  treeLoading,
  treeSubagentCount
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
      { text: "▾ Tools (2)", header: true },
      { text: "  bash 1", header: false },
      { text: "  read 1", header: false },
      { text: "▾ Auto-compactions", header: true },
      { text: "  1", header: false },
      { text: "▾ Model calls (steps)", header: true },
      { text: "  1", header: false },
      { text: "▾ Subagents", header: true },
      { text: "  · T3: tightly-coupled fixtures  1 call · 1 auto-compact", header: false },
      { text: "    · child-of-T3", header: false }
    ]);
  });

  test("buildSessionAnalysisRows omits zero sections and errors section", () => {
    const state = createActivityState();
    state.titles["ses_root"] = "Main";
    recordToolPart(state, "ses_root", { id: "p1", tool: "bash", state: { status: "error", input: {} } });
    expect(buildSessionAnalysisRows(state, "ses_root")).toEqual([
      { text: "▾ Tools (1)", header: true },
      { text: "  bash 1", header: false },
      { text: "▾ Tool errors", header: true },
      { text: "  1", header: false }
    ]);
  });

  test("treeSubagentCount counts descendants and formatSubagentCount pluralizes", () => {
    const state = createActivityState();
    expect(treeSubagentCount(state, "ses_root")).toBe(0);
    recordChild(state, "ses_a", "ses_root");
    recordChild(state, "ses_b", "ses_a");
    expect(treeSubagentCount(state, "ses_root")).toBe(2);
    expect(treeSubagentCount(state, "ses_a")).toBe(1);
    expect(formatSubagentCount(0)).toBe("");
    expect(formatSubagentCount(1)).toBe("1 subagent");
    expect(formatSubagentCount(2)).toBe("2 subagents");
  });
});
