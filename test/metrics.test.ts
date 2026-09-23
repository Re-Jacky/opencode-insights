import { describe, expect, test } from "vitest";
import {
  createMetricsState,
  estimateStreamTokens,
  getTurnAverage,
  recordAssistantDelta,
  recordAssistantMessage,
  renderPromptRightMetricsText,
  renderResponseMetricsText,
  renderMetricsText,
  resetTurnAverage,
  getSessionTokenUsage,
  renderSessionTokenUsage,
  type MetricsState
} from "../src/metrics.js";

describe("metrics tracking", () => {
  test("estimates at least one token for every text delta", () => {
    expect(estimateStreamTokens("hi")).toBe(1);
    expect(estimateStreamTokens("1234567890")).toBe(2);
  });

  test("renders live TPS, average TPS, and TTFT for a session", () => {
    const state = createMetricsState();

    recordAssistantMessage(state, {
      sessionID: "ses_1",
      messageID: "msg_1",
      createdAt: 1_000
    });
    recordAssistantDelta(state, {
      sessionID: "ses_1",
      messageID: "msg_1",
      delta: "x".repeat(50),
      at: 1_500
    });
    recordAssistantDelta(state, {
      sessionID: "ses_1",
      messageID: "msg_1",
      delta: "x".repeat(50),
      at: 2_500
    });
    recordAssistantMessage(state, {
      sessionID: "ses_1",
      messageID: "msg_1",
      createdAt: 1_000,
      streamedAt: 3_000,
      completedAt: 3_000,
      outputTokens: 40,
      reasoningTokens: 10
    });

    expect(renderMetricsText(state, "ses_1", { now: 2_750, idle: false })).toBe(
      "TPS 16.0 TPS | AVG 25.0 | TTFT 0.5s"
    );
  });

  test("averages over the streamed step window like the native prompt", () => {
    const state = createMetricsState();

    recordAssistantMessage(state, {
      sessionID: "ses_1",
      messageID: "msg_1",
      createdAt: 1_000
    });
    recordAssistantDelta(state, {
      sessionID: "ses_1",
      messageID: "msg_1",
      delta: "x".repeat(50),
      at: 4_000
    });
    recordAssistantMessage(state, {
      sessionID: "ses_1",
      messageID: "msg_1",
      createdAt: 1_000,
      streamedAt: 5_000,
      completedAt: 5_100,
      outputTokens: 40,
      reasoningTokens: 10
    });

    // 50 tokens over the 4s streamed window (1000 -> 5000), TTFT to the first
    // token at 4000 - matching the native message header's tok/s.
    expect(renderPromptRightMetricsText(state, "ses_1", { idle: true, metrics: ["avg", "ttft"] })).toBe(
      "AVG 12.5 | TTFT 3.0s"
    );
  });

  test("renders a compact summary for the latest completed assistant response without cost", () => {
    const state = createMetricsState();

    recordAssistantMessage(state, {
      sessionID: "ses_1",
      messageID: "msg_1",
      createdAt: 1_000,
      completedAt: 3_000,
      inputTokens: 1_000,
      outputTokens: 200,
      reasoningTokens: 50,
      cacheReadTokens: 9_000,
      cacheWriteTokens: 100,
      finish: "stop"
    });

    expect(renderResponseMetricsText(state, "ses_1")).toBe(
      "10.4k total | 90.00% cache | 200 out | 50 think"
    );
    // A response with no `time.streamed` contributes no AVG, like the native
    // header (which needs the stream span to compute tok/s).
    expect(renderPromptRightMetricsText(state, "ses_1", { idle: true })).toBe(
      "TPS - | AVG - | 10.4k total | 90.00% cache"
    );
    expect(renderPromptRightMetricsText(state, "ses_1", { idle: true, metrics: ["total", "cache"] })).toBe(
      "10.4k total | 90.00% cache"
    );
    expect(renderPromptRightMetricsText(state, "ses_1", { idle: true, metrics: ["input"] })).toBe("10.1k in");
  });

  test("hides latest response metrics until the provider reports token usage", () => {
    const state = createMetricsState();

    recordAssistantMessage(state, {
      sessionID: "ses_1",
      messageID: "msg_1",
      createdAt: 1_000
    });

    expect(renderResponseMetricsText(state, "ses_1")).toBe("");
    expect(renderPromptRightMetricsText(state, "ses_1", { idle: true })).toBe(
      "TPS - | AVG - | - total | - cache"
    );
  });

  test("aggregates token usage across completed responses in a session", () => {
    const state = createMetricsState();

    for (const [messageID, usage] of [
      ["msg_1", { inputTokens: 100, outputTokens: 20, reasoningTokens: 5, cacheReadTokens: 900, cacheWriteTokens: 10 }],
      ["msg_2", { inputTokens: 40, outputTokens: 10, reasoningTokens: 0, cacheReadTokens: 60, cacheWriteTokens: 0 }]
    ] as const) {
      recordAssistantMessage(state, { sessionID: "ses_1", messageID, createdAt: 1_000, completedAt: 2_000, ...usage });
    }

    expect(getSessionTokenUsage(state, "ses_1")).toEqual({
      inputTokens: 140,
      outputTokens: 30,
      reasoningTokens: 5,
      cacheReadTokens: 960,
      cacheWriteTokens: 10,
      totalTokens: 1_145,
      responseCount: 2
    });
    expect(renderSessionTokenUsage(state, "ses_1")).toEqual([
      "Token Usage",
      "1.1k total · 2 responses",
      "140 input",
      "30 output",
      "5 reasoning",
      "960 cache read",
      "10 cache write",
      "87.27% cache rate"
    ].join("\n"));

    recordAssistantMessage(state, {
      sessionID: "ses_1",
      messageID: "msg_1",
      createdAt: 1_000,
      completedAt: 2_000,
      inputTokens: 100,
      outputTokens: 20,
      reasoningTokens: 5,
      cacheReadTokens: 900,
      cacheWriteTokens: 10
    });

    expect(getSessionTokenUsage(state, "ses_1")?.totalTokens).toBe(1_145);
  });

  test("includes subagent tokens in grand total and shows subagent row", () => {
    const state = createMetricsState();

    recordAssistantMessage(state, {
      sessionID: "ses_1",
      messageID: "msg_1",
      createdAt: 1_000,
      completedAt: 2_000,
      inputTokens: 100,
      outputTokens: 20,
      reasoningTokens: 5,
      cacheReadTokens: 900,
      cacheWriteTokens: 10
    });

    expect(renderSessionTokenUsage(state, "ses_1", 3_200)).toEqual([
      "Token Usage",
      "4.2k total · 1 responses",
      "3.2k used by subagents",
      "100 input",
      "20 output",
      "5 reasoning",
      "900 cache read",
      "10 cache write",
      "90.00% cache rate"
    ].join("\n"));
  });

  test("omits subagent row when subagent tokens are zero", () => {
    const state = createMetricsState();

    recordAssistantMessage(state, {
      sessionID: "ses_1",
      messageID: "msg_1",
      createdAt: 1_000,
      completedAt: 2_000,
      inputTokens: 100,
      outputTokens: 20
    });

    const result = renderSessionTokenUsage(state, "ses_1", 0);
    expect(result).not.toContain("used by subagents");
  });
});

describe("turn-average AVG (native message-header parity)", () => {
  /** One completed step of a turn: tokens over its `time.streamed - time.created` span. */
  function step(state: MetricsState, messageID: string, createdAt: number, streamedAt: number, outputTokens: number, reasoningTokens = 0) {
    recordAssistantMessage(state, {
      sessionID: "ses_1",
      messageID,
      createdAt,
      streamedAt,
      completedAt: streamedAt + 20,
      outputTokens,
      reasoningTokens
    });
  }

  const avg = (state: MetricsState) => renderPromptRightMetricsText(state, "ses_1", { idle: true, metrics: ["avg"] });

  test("reproduces the native turn figure for a real turn", () => {
    const state = createMetricsState();
    // One real turn from a live session: 19 steps, verified against the native
    // message header, which reports 6m 24s · 84.2 tok/s for it.
    const turn: Array<[tokens: number, streamMs: number]> = [
      [338, 4_245], [103, 2_742], [438, 3_645], [89, 3_225], [81, 3_210], [142, 3_736], [1_534, 10_163],
      [281, 3_902], [205, 3_961], [300, 3_278], [544, 5_234], [1_045, 7_878], [197, 4_276], [790, 6_438],
      [449, 5_044], [561, 4_955], [97, 2_710], [1_077, 20_552], [393, 3_727]
    ];
    let at = 1_000;
    for (const [index, [tokens, streamMs]] of turn.entries()) {
      step(state, `msg_${index}`, at, at + streamMs, tokens);
      at += streamMs;
    }

    expect(avg(state)).toBe("AVG 84.2");
  });

  test("averages every step of the turn, not just the latest step", () => {
    const state = createMetricsState();
    step(state, "msg_1", 1_000, 5_000, 40, 10); // 50 tok / 4.0s = 12.5
    step(state, "msg_2", 6_000, 8_000, 10, 0); // 10 tok / 2.0s = 5.0
    step(state, "msg_3", 9_000, 12_000, 300, 0); // 300 tok / 3.0s = 100.0

    // Σ tokens / Σ stream spans = 360 / 9s, not the latest step's 100.
    expect(avg(state)).toBe("AVG 40.0");
  });

  test("starts over when a new turn begins", () => {
    const state = createMetricsState();
    step(state, "msg_1", 1_000, 3_000, 50);

    expect(avg(state)).toBe("AVG 25.0");

    resetTurnAverage(state, "ses_1");
    expect(avg(state)).toBe("AVG -");

    step(state, "msg_2", 10_000, 12_000, 400);
    expect(avg(state)).toBe("AVG 200");
  });

  test("ignores steps without a streamed stamp", () => {
    const state = createMetricsState();
    recordAssistantMessage(state, {
      sessionID: "ses_1",
      messageID: "msg_wall",
      createdAt: 1_000,
      completedAt: 5_000,
      outputTokens: 400
    });
    expect(avg(state)).toBe("AVG -");

    step(state, "msg_streamed", 6_000, 7_000, 100);
    expect(avg(state)).toBe("AVG 100");
  });

  test("replaces a step's contribution when the same message is recorded again", () => {
    const state = createMetricsState();
    // A multi-step message, or a hydrated replay of a step the live stream already
    // recorded, must keep one entry: the turn must not count it twice, and the
    // latest values win.
    step(state, "msg_1", 1_000, 5_000, 40, 10);
    expect(avg(state)).toBe("AVG 12.5");

    step(state, "msg_1", 1_000, 6_000, 60, 10);

    expect(avg(state)).toBe("AVG 14.0");
  });

  test("reports no average before the first completed step", () => {
    const state = createMetricsState();
    recordAssistantMessage(state, { sessionID: "ses_1", messageID: "msg_1", createdAt: 1_000 });

    expect(avg(state)).toBe("AVG -");
    expect(getTurnAverage(state, "ses_1")).toBeUndefined();
  });
});
