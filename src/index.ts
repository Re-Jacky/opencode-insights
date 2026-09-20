import { Plugin } from "@opencode/plugin";
import {
  createCaptureStore,
  insightsOptionsFromConfig,
  normalizeContextCapture,
  normalizeEventCapture,
  normalizeModelRequestCapture,
  normalizePromptCapture,
  normalizeToolCapture,
  readInsightsConfig,
  type CaptureStore
} from "./capture.js";

const id = "opencode-insights";

type V2Context = {
  options: Readonly<Record<string, unknown>>;
  event: { subscribe: (options: { signal: AbortSignal }) => AsyncIterable<unknown> };
  session: { hook: (name: "prompt" | "context" | "model.request", callback: (event: unknown) => Promise<void> | void) => unknown };
  tool: { hook: (name: "execute.before" | "execute.after", callback: (event: unknown) => Promise<void> | void) => unknown };
};

const setup = async (ctx: V2Context) => {
  const rawOptions = ctx.options as Record<string, unknown>;
  const dataDir = typeof rawOptions.dataDir === "string" ? rawOptions.dataDir : undefined;
  const config = await readInsightsConfig({ dataDir });
  const storeOptions = insightsOptionsFromConfig(config, dataDir);
  const store = createCaptureStore(storeOptions);
  try {
    await store.initialize?.();
  } catch {}

  let captureQueue = Promise.resolve();
  let acceptingCaptures = true;
  const captureSafely = (record: Parameters<CaptureStore["append"]>[0]) => {
    if (!acceptingCaptures) return;
    const capture = captureQueue.then(async () => {
      try {
        await store.append(record);
      } catch {}
    });
    captureQueue = capture.catch(() => {});
    void capture;
  };

  const controller = new AbortController();
  const subscriber = (async () => {
    try {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        captureSafely(normalizeEventCapture(event));
      }
    } catch {}
  })();

  ctx.session.hook("prompt", (event: unknown) => {
    captureSafely(normalizePromptCapture(event));
  });
  ctx.session.hook("context", (event: unknown) => {
    captureSafely(normalizeContextCapture(event));
  });
  ctx.session.hook("model.request", (event: unknown) => {
    captureSafely(normalizeModelRequestCapture(event));
  });
  ctx.tool.hook("execute.before", (event: unknown) => {
    captureSafely(normalizeToolCapture("tool.execute.before", event));
  });
  ctx.tool.hook("execute.after", (event: unknown) => {
    captureSafely(normalizeToolCapture("tool.execute.after", event));
  });

  let cleanedUp = false;
  return async () => {
    if (cleanedUp) return;
    cleanedUp = true;
    acceptingCaptures = false;
    controller.abort();
    await captureQueue;
    await store.close?.();
  };
};

export default Plugin.define({ id, setup });

export * from "./capture.js";
export * from "./metrics.js";
export * from "./subagents.js";
