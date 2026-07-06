import type { Plugin } from "@opencode-ai/plugin";
import {
  createCaptureStore,
  normalizeChatHeadersCapture,
  normalizeChatMessageCapture,
  normalizeChatParamsCapture,
  normalizeEventCapture,
  normalizeToolCapture,
  type InsightsOptions
} from "./capture.js";

export const OpenCodeInsights: Plugin = async (_input, options?: InsightsOptions) => {
  const store = createCaptureStore(options);

  async function capture(record: Parameters<typeof store.append>[0]) {
    try {
      await store.append(record);
    } catch {
      // Observability must never interrupt the coding session.
    }
  }

  return {
    dispose: async () => {
      await store.close?.();
    },
    event: async ({ event }) => {
      await capture(normalizeEventCapture(event));
    },
    "chat.message": async (input, output) => {
      await capture(normalizeChatMessageCapture(input, output));
    },
    "chat.params": async (input, output) => {
      await capture(normalizeChatParamsCapture(input, output));
    },
    "chat.headers": async (input, output) => {
      await capture(normalizeChatHeadersCapture(input, output));
    },
    "tool.execute.before": async (input, output) => {
      await capture(normalizeToolCapture("tool.execute.before", input, output));
    },
    "tool.execute.after": async (input, output) => {
      await capture(normalizeToolCapture("tool.execute.after", input, output));
    }
  };
};

export default OpenCodeInsights;
export * from "./capture.js";
export * from "./metrics.js";
export * from "./subagents.js";

