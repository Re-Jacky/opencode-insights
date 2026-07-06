import { describe, expect, test } from "vitest";
import {
  createMetricsState,
  estimateStreamTokens,
  recordAssistantDelta,
  recordAssistantMessage,
  renderMetricsText
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
      completedAt: 3_000,
      outputTokens: 40,
      reasoningTokens: 10
    });

    expect(renderMetricsText(state, "ses_1", { now: 2_750, idle: false })).toBe(
      "TPS 16.0 TPS | AVG 33.3 | TTFT 0.5s"
    );
  });
});
