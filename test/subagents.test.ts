import { describe, expect, test } from "vitest";
import { createActivityState, recordToolPart } from "../src/activity.js";
import { getSubagentSidebarModel, subagentStatus, sumSubagentTokens, type SubagentSession } from "../src/subagents.js";

function session(overrides: Partial<SubagentSession> = {}): SubagentSession {
  return {
    id: "ses_child",
    title: "Review tests",
    status: "running",
    time: { created: 1_000 },
    ...overrides
  };
}

describe("subagent status from the native session store", () => {
  test("maps native status and outcome onto the row status", () => {
    expect(subagentStatus(session({ status: "running" }))).toBe("running");
    expect(subagentStatus(session({ status: "idle" }))).toBe("done");
    expect(subagentStatus(session({ status: "idle", outcome: "succeeded" }))).toBe("done");
    expect(subagentStatus(session({ status: "idle", outcome: "interrupted" }))).toBe("done");
    expect(subagentStatus(session({ status: "idle", outcome: "failed" }))).toBe("error");
    // The host store owns liveness: a stale outcome never overrides "running".
    expect(subagentStatus(session({ status: "running", outcome: "failed" }))).toBe("running");
  });

  test("a finished subagent stops ticking and keeps its final duration", () => {
    const child = session({ status: "idle", outcome: "succeeded", time: { created: 1_000, idle: 4_000 } });

    const shortlyAfter = getSubagentSidebarModel([child], { now: 5_000 });
    const laterOn = getSubagentSidebarModel([child], { now: 100_000 });

    expect(shortlyAfter?.summary).toBe("0 running · 1 done · 0 error");
    expect(shortlyAfter?.rows[0]).toMatchObject({ id: "ses_child", status: "done", subtitle: "00:03" });
    // The same row minutes later: identical, because nothing counts up any more.
    expect(laterOn?.rows[0]?.subtitle).toBe("00:03");
  });

  test("counts up while the host reports the subagent running", () => {
    const child = session({ status: "running", time: { created: 1_000 } });

    expect(getSubagentSidebarModel([child], { now: 6_000 })?.rows[0]?.subtitle).toBe("00:05");
    expect(getSubagentSidebarModel([child], { now: 9_000 })?.rows[0]?.subtitle).toBe("00:08");
  });

  test("prefers the native idle stamp and falls back to the first observed idle time", () => {
    const stamped = session({ status: "idle", time: { created: 1_000, idle: 3_000 } });
    expect(getSubagentSidebarModel([stamped], { now: 5_000, observedIdleAt: () => 4_500 })?.rows[0]?.subtitle).toBe("00:02");

    const unstamped = session({ status: "idle", time: { created: 1_000 } });
    expect(getSubagentSidebarModel([unstamped], { now: 5_000, observedIdleAt: () => 4_000 })?.rows[0]?.subtitle).toBe("00:03");
  });

  test("shows no duration rather than a wrong one when no end is known", () => {
    const child = session({ status: "idle", time: { created: 1_000 }, tokens: { input: 12, output: 8 } });

    expect(getSubagentSidebarModel([child], { now: 5_000 })?.rows[0]?.subtitle).toBe("20 tokens");
  });

  test("sorts running first, then errors, then the newest", () => {
    const children = [
      session({ id: "ses_done_old", status: "idle", time: { created: 1_000, idle: 2_000 } }),
      session({ id: "ses_running_old", status: "running", time: { created: 1_000 } }),
      session({ id: "ses_error", status: "idle", outcome: "failed", time: { created: 1_500, idle: 2_500 } }),
      session({ id: "ses_running_new", status: "running", time: { created: 3_000 } })
    ];

    const model = getSubagentSidebarModel(children, { now: 3_500 });

    expect(model?.summary).toBe("2 running · 1 done · 1 error");
    expect(model?.rows.map((row) => row.id)).toEqual(["ses_running_new", "ses_running_old", "ses_error", "ses_done_old"]);
  });

  test("prunes finished subagents after three idle minutes and keeps running ones", () => {
    const children = [
      session({ id: "ses_done_recent", status: "idle", time: { created: 1_000, idle: 120_000 } }),
      session({ id: "ses_done_stale", status: "idle", time: { created: 1_000, idle: 60_000 } }),
      session({ id: "ses_running_old", status: "running", time: { created: 1_000 } })
    ];

    expect(getSubagentSidebarModel(children, { now: 240_001 })?.rows.map((row) => row.id)).toEqual([
      "ses_running_old",
      "ses_done_recent"
    ]);
  });

  test("omits the section when there are no child sessions", () => {
    expect(getSubagentSidebarModel([], { now: 1 })).toBeUndefined();
  });

  test("titles a row with the native agent and task", () => {
    const child = session({ title: "Review tests", agent: "general" });
    expect(getSubagentSidebarModel([child], { now: 6_000 })?.rows[0]?.title).toBe("general: Review tests");

    const suffixed = session({ title: "Final performance review (@general subagent)", agent: "general" });
    expect(getSubagentSidebarModel([suffixed], { now: 6_000 })?.rows[0]?.title).toBe("general: Final performance review");

    const long = session({ title: "Review tests and inspect the flaky build logs", agent: "general" });
    const title = getSubagentSidebarModel([long], { now: 6_000 })?.rows[0]?.title ?? "";
    expect(title.length).toBeLessThanOrEqual(36);
    expect(title).toContain("...");
  });
});

describe("subagent token totals", () => {
  test("sums either the native token fields or a plain input/output pair", () => {
    expect(sumSubagentTokens([session({ tokens: { input: 12, output: 8 } })])).toBe(20);
    expect(
      sumSubagentTokens([
        session({ tokens: { input: 1, output: 2, reasoning: 3, cache: { read: 4, write: 5 } } }),
        session({ id: "ses_b" })
      ])
    ).toBe(15);
  });

  test("shows the native total abbreviated next to the duration", () => {
    const small = session({ tokens: { input: 100, output: 25, reasoning: 10, cache: { read: 5, write: 1 } } });
    expect(getSubagentSidebarModel([small], { now: 6_000 })?.rows[0]?.subtitle).toBe("00:05 · 141 tokens");

    const large = session({ tokens: { input: 12_345, output: 1 } });
    expect(getSubagentSidebarModel([large], { now: 6_000 })?.rows[0]?.subtitle).toBe("00:05 · 12.3k tokens");
  });

  test("omits the token part when the host reports none", () => {
    const child = session({ time: { created: 1_000 } });
    expect(getSubagentSidebarModel([child], { now: 6_000 })?.rows[0]?.subtitle).toBe("00:05");
  });
});

describe("subagent activity suffix", () => {
  test("appends the activity recorded for that child session", () => {
    const activity = createActivityState();
    recordToolPart(activity, "ses_child", { id: "prt_1", tool: "bash" });
    recordToolPart(activity, "ses_child", { id: "prt_2", tool: "read" });

    const child = session({ tokens: { input: 12, output: 8 } });
    const model = getSubagentSidebarModel([child], { now: 6_000, activity: (id) => activity.bySessionID[id] });

    expect(model?.rows[0]?.subtitle).toBe("00:05 · 20 tokens · 2 tool calls");
  });

  test("keeps the subtitle unchanged when the subagent has no activity", () => {
    const child = session({ tokens: { input: 12, output: 8 } });
    const model = getSubagentSidebarModel([child], { now: 6_000, activity: () => undefined });

    expect(model?.rows[0]?.subtitle).toBe("00:05 · 20 tokens");
  });
});
