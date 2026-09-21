import { describe, expect, test } from "vitest";
import { createActivityState } from "../src/activity.js";
import { createCopilotProviderTracker } from "../src/copilot-usage.js";
import { applyInsightEvent, createInsightState } from "../src/events.js";
import { createGoProviderTracker } from "../src/go-usage.js";
import { createMetricsState } from "../src/metrics.js";
import { createSubagentState } from "../src/subagents.js";

function state() {
  const activity = createActivityState();
  const subagents = createSubagentState(activity);
  return {
    state: createInsightState({
      metrics: createMetricsState(),
      activity,
      subagents,
      goProviders: createGoProviderTracker(),
      copilotProviders: createCopilotProviderTracker()
    }),
    activity,
    subagents
  };
}

describe("applyInsightEvent", () => {
  test("records text deltas as metrics", () => {
    const { state: s } = state();
    const result = applyInsightEvent(s, {
      type: "session.text.delta",
      created: 100,
      data: { sessionID: "ses_a", assistantMessageID: "msg_1", delta: "hello world" }
    });
    expect(result.metrics).toBe(true);
    expect(s.metrics.streamSamplesByMessageID["msg_1"]?.length).toBe(1);
  });

  test("records reasoning deltas so the thinking phase is measured", () => {
    const { state: s } = state();
    applyInsightEvent(s, {
      type: "session.step.started",
      created: 1_000,
      data: { sessionID: "ses_a", assistantMessageID: "msg_1", started: 1_000 }
    });
    const result = applyInsightEvent(s, {
      type: "session.reasoning.delta",
      created: 1_400,
      data: { sessionID: "ses_a", assistantMessageID: "msg_1", delta: "thinking hard" }
    });

    expect(result.metrics).toBe(true);
    expect(s.metrics.streamSamplesByMessageID["msg_1"]?.length).toBe(1);
    // The first token of any kind starts TTFT, so reasoning time counts.
    expect(s.metrics.messageTimingByID["msg_1"]?.firstTokenAt).toBe(1_400);
  });

  test("averages over the step streaming window like the native prompt", () => {
    const { state: s } = state();
    applyInsightEvent(s, {
      type: "session.step.started",
      created: 1_000,
      data: { sessionID: "ses_a", assistantMessageID: "msg_1", started: 1_000 }
    });
    applyInsightEvent(s, {
      type: "session.text.delta",
      created: 4_000,
      data: { sessionID: "ses_a", assistantMessageID: "msg_1", delta: "x".repeat(50) }
    });
    applyInsightEvent(s, {
      type: "session.step.streamed",
      created: 5_000,
      data: { sessionID: "ses_a", assistantMessageID: "msg_1" }
    });
    applyInsightEvent(s, {
      type: "session.step.ended",
      created: 5_100,
      data: {
        sessionID: "ses_a",
        assistantMessageID: "msg_1",
        finish: "stop",
        tokens: { input: 10, output: 40, reasoning: 10, cache: { read: 0, write: 0 } }
      }
    });

    // 50 tokens over the 4s streaming window (step start 1000 -> streamed 5000),
    // with TTFT measured to the first token at 4000, not to the stream end.
    expect(s.metrics.messageMetricsByID["msg_1"]).toMatchObject({
      totalTokens: 50,
      durationMs: 4_000,
      ttftMs: 3_000
    });
  });

  test("keeps the first step start so a later step does not shift TTFT or the window", () => {
    const { state: s } = state();
    applyInsightEvent(s, {
      type: "session.step.started",
      created: 1_000,
      data: { sessionID: "ses_a", assistantMessageID: "msg_1", started: 1_000 }
    });
    applyInsightEvent(s, {
      type: "session.reasoning.delta",
      created: 1_400,
      data: { sessionID: "ses_a", assistantMessageID: "msg_1", delta: "thinking" }
    });
    applyInsightEvent(s, {
      type: "session.step.streamed",
      created: 2_000,
      data: { sessionID: "ses_a", assistantMessageID: "msg_1" }
    });
    // Tool step ends without completing the message, then the next step streams.
    applyInsightEvent(s, {
      type: "session.step.started",
      created: 3_000,
      data: { sessionID: "ses_a", assistantMessageID: "msg_1", started: 3_000 }
    });
    applyInsightEvent(s, {
      type: "session.step.streamed",
      created: 5_000,
      data: { sessionID: "ses_a", assistantMessageID: "msg_1" }
    });
    applyInsightEvent(s, {
      type: "session.step.ended",
      created: 5_100,
      data: {
        sessionID: "ses_a",
        assistantMessageID: "msg_1",
        finish: "stop",
        tokens: { input: 10, output: 40, reasoning: 10, cache: { read: 0, write: 0 } }
      }
    });

    // Window spans first step start -> stream end (1000 -> 5000), TTFT points at
    // the first token of any kind (1400 - 1000), exactly like the host's
    // `time.created`/`time.streamed` pair.
    expect(s.metrics.messageMetricsByID["msg_1"]).toMatchObject({
      durationMs: 4_000,
      ttftMs: 400
    });
  });

  test("does not double-count tokens across multiple steps of one assistant message", () => {
    const { state: s } = state();
    applyInsightEvent(s, {
      type: "session.step.started",
      created: 1,
      data: { sessionID: "ses_a", assistantMessageID: "msg_1", model: { providerID: "opencode-go" }, started: 1 }
    });
    applyInsightEvent(s, {
      type: "session.step.ended",
      created: 10,
      data: {
        sessionID: "ses_a",
        assistantMessageID: "msg_1",
        finish: "tool-calls",
        tokens: { input: 5, output: 3, reasoning: 1, cache: { read: 0, write: 0 } }
      }
    });
    applyInsightEvent(s, {
      type: "session.step.ended",
      created: 20,
      data: {
        sessionID: "ses_a",
        assistantMessageID: "msg_1",
        finish: "stop",
        tokens: { input: 8, output: 4, reasoning: 2, cache: { read: 1, write: 1 } }
      }
    });

    const usage = s.metrics.responseUsageByMessageID["msg_1"];
    expect(usage?.usage.outputTokens).toBe(7);
    expect(usage?.usage.reasoningTokens).toBe(3);
    expect(usage?.usage.inputTokens).toBe(8);
  });

  test("records usage for tool-call steps, which are their own assistant messages", () => {
    const { state: s } = state();
    applyInsightEvent(s, {
      type: "session.step.started",
      created: 1,
      data: { sessionID: "ses_a", assistantMessageID: "msg_tool", started: 1 }
    });
    applyInsightEvent(s, {
      type: "session.step.ended",
      created: 10,
      data: {
        sessionID: "ses_a",
        assistantMessageID: "msg_tool",
        finish: "tool-calls",
        tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 900, write: 0 } }
      }
    });

    expect(s.metrics.responseUsageByMessageID["msg_tool"]?.usage.outputTokens).toBe(20);
    expect(s.metrics.sessionTokenUsageByID["ses_a"]?.responseCount).toBe(1);
  });

  test("records skill hits from the tool input on session.tool.called", () => {
    const { state: s, activity } = state();
    applyInsightEvent(s, {
      type: "session.tool.input.started",
      created: 1,
      data: { sessionID: "ses_a", assistantMessageID: "msg_1", id: "call_1", name: "skill" }
    });
    applyInsightEvent(s, {
      type: "session.tool.called",
      created: 2,
      data: { sessionID: "ses_a", assistantMessageID: "msg_1", id: "call_1", input: { name: "writing-plans" } }
    });
    applyInsightEvent(s, {
      type: "session.tool.success",
      created: 3,
      data: { sessionID: "ses_a", assistantMessageID: "msg_1", id: "call_1", content: [], metadata: {} }
    });

    // In V2 a skill activation is a `skill` tool call; its input arrives on
    // `session.tool.called`, and the name is what makes it readable.
    expect(activity.bySessionID["ses_a"]?.skills).toEqual({ "writing-plans": 1 });
    expect(activity.bySessionID["ses_a"]?.toolCalls).toBe(1);
  });

  test("records tools and compactions as activity", () => {
    const { state: s, activity } = state();
    applyInsightEvent(s, {
      type: "session.tool.input.started",
      created: 1,
      data: { sessionID: "ses_a", assistantMessageID: "msg_1", id: "t1", name: "read" }
    });
    applyInsightEvent(s, {
      type: "session.tool.failed",
      created: 2,
      data: { sessionID: "ses_a", assistantMessageID: "msg_1", id: "t1", error: { type: "x", message: "denied" } }
    });
    applyInsightEvent(s, {
      type: "session.compaction.started",
      created: 3,
      id: "evt_compact",
      data: { sessionID: "ses_a", reason: "auto" }
    });

    expect(activity.bySessionID["ses_a"]?.toolCalls).toBe(1);
    expect(activity.bySessionID["ses_a"]?.warnings).toBe(1);
    expect(activity.bySessionID["ses_a"]?.autoCompacts).toBe(1);
  });

  test("records child sessions, titles, and providers on session.created", () => {
    const { state: s, activity, subagents } = state();
    const result = applyInsightEvent(s, {
      type: "session.created",
      created: 1,
      data: {
        sessionID: "ses_child",
        parentID: "ses_root",
        title: "Child",
        model: { providerID: "github-copilot" }
      }
    });

    expect(result.providers).toBe(true);
    expect(result.subagents).toBe(true);
    expect(activity.childrenByParent["ses_root"]).toEqual(["ses_child"]);
    expect(activity.titles["ses_child"]).toBe("Child");
    expect(subagents.children["ses_child"]?.status).toBe("running");
    expect(s.copilotProviders.usesCopilot("ses_child")).toBe(true);
    expect(s.goProviders.usesOpenCodeGo("ses_child")).toBe(false);
  });

  test("records skills from session.skill.activated", () => {
    const { state: s, activity } = state();
    const result = applyInsightEvent(s, {
      type: "session.skill.activated",
      created: 1,
      data: { sessionID: "ses_a", id: "sk1", name: "brainstorming", text: "" }
    });
    expect(result.activity).toBe(true);
    expect(activity.bySessionID["ses_a"]?.skills).toEqual({ brainstorming: 1 });
  });

  test("ignores malformed events without throwing", () => {
    const { state: s } = state();
    for (const bad of [
      undefined,
      {},
      { type: 3 },
      { type: "session.text.delta" },
      { type: "session.text.delta", data: {} },
      { type: "session.step.ended", data: { sessionID: "ses_a", assistantMessageID: "m" } }
    ]) {
      expect(() => applyInsightEvent(s, bad)).not.toThrow();
    }
  });
});
