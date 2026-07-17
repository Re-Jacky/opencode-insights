import type { Plugin } from "@opencode-ai/plugin";
import type { TuiPlugin } from "@opencode-ai/plugin/tui";
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
import { ensureCliShim } from "./cli-shim.js";

type OpenCodeInsightsOptions = InsightsOptions & {
  cliShim?: boolean | undefined;
};

export const OpenCodeInsights: Plugin = async (_input, options?: OpenCodeInsightsOptions) => {
  if (options?.cliShim !== false) {
    void ensureCliShim().catch(() => undefined);
  }

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
    event: async ({ event }: { event: unknown }) => {
      await capture(normalizeEventCapture(event));
    },
    "chat.message": async (input: unknown, output: unknown) => {
      await capture(normalizeChatMessageCapture(input, output));
    },
    "chat.params": async (input: unknown, output: unknown) => {
      await capture(normalizeChatParamsCapture(input, output));
    },
    "chat.headers": async (input: unknown, output: unknown) => {
      await capture(normalizeChatHeadersCapture(input, output));
    },
    "experimental.chat.messages.transform": async (input: unknown, output: unknown) => {
      await capture(normalizeExperimentalChatMessagesTransformCapture(input, output));
    },
    "experimental.chat.system.transform": async (input: unknown, output: unknown) => {
      await capture(normalizeExperimentalChatSystemTransformCapture(input, output));
    },
    "tool.execute.before": async (input: unknown, output: unknown) => {
      await capture(normalizeToolCapture("tool.execute.before", input, output));
    },
    "tool.execute.after": async (input: unknown, output: unknown) => {
      await capture(normalizeToolCapture("tool.execute.after", input, output));
    }
  };
};

export const server = OpenCodeInsights;
const rootTui: TuiPlugin = async (...args) => {
  const mod = await import("./tui.js");
  return mod.tui(...args);
};
export const id = "opencode-insights";
export { rootTui as tui };
export default { id, server };
export * from "./capture.js";
export * from "./metrics.js";
export * from "./subagents.js";
