import { describe, expect, test } from "vitest";
import {
  createMetricsState,
  estimateStreamTokens,
  recordAssistantDelta,
  recordAssistantMessage,
  renderPromptRightMetricsText,
  renderResponseMetricsText,
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
      "10.4k used | 90% cache | 200 out | 50 think"
    );
    expect(renderPromptRightMetricsText(state, "ses_1", { idle: true })).toBe(
      "TPS - | AVG - | 10.4k used | 90% cache"
    );
    expect(renderPromptRightMetricsText(state, "ses_1", { idle: true, metrics: ["used", "cache"] })).toBe(
      "10.4k used | 90% cache"
    );
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
      "TPS - | AVG - | - used | - cache"
    );
  });
});
