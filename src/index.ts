import type { Plugin, PluginModule } from "@opencode-ai/plugin";
import {
  createCaptureStore,
  normalizeChatHeadersCapture,
  normalizeChatMessageCapture,
  normalizeChatParamsCapture,
  normalizeEventCapture,
  normalizeExperimentalChatMessagesTransformCapture,
  normalizeExperimentalChatSystemTransformCapture,
  normalizeToolCapture,
  type InsightsOptions
} from "./capture.js";

export const OpenCodeInsights: Plugin = async (_input, options?: InsightsOptions) => {
  const store = createCaptureStore(options);

  try {
    await store.initialize?.();
  } catch {
    // Capture is best-effort; plugin startup should not block OpenCode.
  }

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
    "experimental.chat.messages.transform": async (input, output) => {
      await capture(normalizeExperimentalChatMessagesTransformCapture(input, output));
    },
    "experimental.chat.system.transform": async (input, output) => {
      await capture(normalizeExperimentalChatSystemTransformCapture(input, output));
    },
    "tool.execute.before": async (input, output) => {
      await capture(normalizeToolCapture("tool.execute.before", input, output));
    },
    "tool.execute.after": async (input, output) => {
      await capture(normalizeToolCapture("tool.execute.after", input, output));
    }
  };
};

export const server = OpenCodeInsights;
export const id = "opencode-insights";
export default { id, server } satisfies PluginModule;
export * from "./capture.js";
export * from "./metrics.js";
export * from "./subagents.js";
