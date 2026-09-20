import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import plugin from "../src/index.js";
import { openDatabase, SqliteCaptureStore } from "../src/capture.js";

type TestContext = {
  options: { dataDir: string; cliShim: boolean };
  event: {
    subscribe: (options: { signal: AbortSignal }) => AsyncGenerator<unknown, void, undefined>;
  };
  session: {
    hook: (name: string, listener: (event: unknown) => Promise<void>) => void;
  };
  tool: {
    hook: (name: string, listener: (event: unknown) => Promise<void>) => void;
  };
  storage: { close: () => Promise<void> };
  readonly eventSignal: AbortSignal | undefined;
  emitEvent: (event: unknown) => Promise<void>;
  invokeSession: (name: string, event: unknown) => Promise<void>;
  invokeTool: (name: string, event: unknown) => Promise<void>;
  pushEvent: (event: unknown) => void;
};

function createTestContext(): TestContext {
  let eventListener: ((event: unknown) => Promise<void> | void) | undefined;
  let eventResolve: ((event: unknown) => void) | undefined;
  let eventSignal: AbortSignal | undefined;
  const eventQueue: unknown[] = [];
  let eventQueueResolve: (() => void) | undefined;
  const sessionHooks = new Map<string, (event: unknown) => Promise<void>>();
  const toolHooks = new Map<string, (event: unknown) => Promise<void>>();
  const context = {
    options: { dataDir: "", cliShim: false },
    event: {
      subscribe: vi.fn((options: { signal: AbortSignal }) => (async function* () {
              eventSignal = options.signal;
        while (!options.signal.aborted) {
          if (eventQueue.length === 0) {
            await new Promise<void>((resolve) => {
              eventQueueResolve = resolve;
              options.signal.addEventListener("abort", () => resolve(), { once: true });
            });
          }
          const event = eventQueue.shift();
          if (!options.signal.aborted && event !== undefined) yield event;
        }
      })())
    },
    session: {
      hook: vi.fn((name: string, listener: (event: unknown) => Promise<void>) => {
        sessionHooks.set(name, listener);
      })
    },
    tool: {
      hook: vi.fn((name: string, listener: (event: unknown) => Promise<void>) => {
        toolHooks.set(name, listener);
      })
    },
    storage: { close: vi.fn(async () => {}) },
    get eventSignal() {
      return eventSignal;
    },
    emitEvent: async (event: unknown) => {
      eventQueue.push(event);
      eventQueueResolve?.();
      await eventListener?.(event);
      await Promise.resolve();
    },
    invokeSession: async (name: string, event: unknown) => sessionHooks.get(name)?.(event),
    invokeTool: async (name: string, event: unknown) => toolHooks.get(name)?.(event),
    pushEvent: (event: unknown) => {
      eventQueue.push(event);
      eventQueueResolve?.();
    }
  } satisfies TestContext;
  return context;
}

describe("plugin definitions", () => {
  test("exposes a callable server setup", () => {
    expect(plugin.id).toBe("opencode-insights");
    expect(typeof plugin.setup).toBe("function");
  });

  test("registers v2 hooks and captures each callback kind", async () => {
    const context = createTestContext();
    const dataDir = await mkdtemp(join(tmpdir(), "opencode-insights-plugin-"));
    context.options.dataDir = dataDir;
    const cleanup = await plugin.setup(context as unknown as Parameters<typeof plugin.setup>[0]);

    await context.emitEvent({ type: "session.created", properties: { sessionID: "event" } });
    await context.invokeSession("prompt", { sessionID: "prompt" });
    await context.invokeSession("context", { sessionID: "context" });
    await context.invokeSession("model.request", { sessionID: "model" });
    await context.invokeTool("execute.before", { sessionID: "before" });
    await context.invokeTool("execute.after", { sessionID: "after" });

    expect(context.event.subscribe).toHaveBeenCalledOnce();
    expect(context.session.hook).toHaveBeenCalledWith("prompt", expect.any(Function));
    expect(context.session.hook).toHaveBeenCalledWith("context", expect.any(Function));
    expect(context.session.hook).toHaveBeenCalledWith("model.request", expect.any(Function));
    expect(context.tool.hook).toHaveBeenCalledWith("execute.before", expect.any(Function));
    expect(context.tool.hook).toHaveBeenCalledWith("execute.after", expect.any(Function));

    await new Promise((resolve) => setTimeout(resolve, 10));
    await cleanup?.();
    const db = await openDatabase(join(dataDir, "insights.sqlite"), true);
    const records = db?.all("select kind from captures order by timestamp, id") as Array<{ kind: string }>;
    db?.close();
    expect(records.map((record) => record.kind)).toEqual([
      "event",
      "prompt",
      "context",
      "model.request",
      "tool.execute.before",
      "tool.execute.after"
    ]);
  });

  test("cleanup aborts the event stream and closes storage", async () => {
    const context = createTestContext();
    const dataDir = await mkdtemp(join(tmpdir(), "opencode-insights-plugin-"));
    context.options.dataDir = dataDir;
    const close = vi.spyOn(SqliteCaptureStore.prototype, "close");
    const cleanup = await plugin.setup(context as unknown as Parameters<typeof plugin.setup>[0]);

    await cleanup?.();
    await cleanup?.();

    expect(context.eventSignal?.aborted).toBe(true);
    expect(close).toHaveBeenCalledOnce();
  });

  test("does not await rejected storage writes from hooks", async () => {
    const context = createTestContext();
    const dataDir = await mkdtemp(join(tmpdir(), "opencode-insights-plugin-"));
    context.options.dataDir = dataDir;
    const append = vi.spyOn(SqliteCaptureStore.prototype, "append").mockRejectedValue(new Error("storage down"));
    const cleanup = await plugin.setup(context as unknown as Parameters<typeof plugin.setup>[0]);

    await expect(context.invokeSession("prompt", { sessionID: "rejected" })).resolves.toBeUndefined();
    expect(append).toHaveBeenCalledOnce();
    await cleanup?.();
  });

  test("continues consuming events after an append failure", async () => {
    const context = createTestContext();
    const dataDir = await mkdtemp(join(tmpdir(), "opencode-insights-plugin-"));
    context.options.dataDir = dataDir;
    const append = vi.spyOn(SqliteCaptureStore.prototype, "append");
    append.mockRejectedValueOnce(new Error("first event failed"));
    const cleanup = await plugin.setup(context as unknown as Parameters<typeof plugin.setup>[0]);

    context.pushEvent({ type: "session.created", properties: { sessionID: "failed" } });
    context.pushEvent({ type: "session.updated", properties: { sessionID: "survived" } });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(append).toHaveBeenCalledTimes(2);
    await cleanup?.();
  });

  test("closes storage without waiting for an abort-insensitive subscriber", async () => {
    const context = createTestContext();
    const dataDir = await mkdtemp(join(tmpdir(), "opencode-insights-plugin-"));
    context.options.dataDir = dataDir;
    const close = vi.spyOn(SqliteCaptureStore.prototype, "close");
    context.event.subscribe = vi.fn(() => (async function* () {
      await new Promise<void>(() => {});
      yield { type: "never" };
    })());
    const cleanup = await plugin.setup(context as unknown as Parameters<typeof plugin.setup>[0]);

    await expect(Promise.race([
      Promise.resolve(cleanup?.()).then(() => "closed"),
      new Promise((resolve) => setTimeout(() => resolve("timed out"), 20))
    ])).resolves.toBe("closed");
    expect(close).toHaveBeenCalledOnce();
  });

  test("continues setup when store initialization fails", async () => {
    const context = createTestContext();
    const dataDir = await mkdtemp(join(tmpdir(), "opencode-insights-plugin-"));
    context.options.dataDir = dataDir;
    vi.spyOn(SqliteCaptureStore.prototype, "initialize").mockRejectedValue(new Error("storage unavailable"));

    const cleanup = await plugin.setup(context as unknown as Parameters<typeof plugin.setup>[0]);

    expect(context.event.subscribe).toHaveBeenCalledOnce();
    expect(context.session.hook).toHaveBeenCalledWith("prompt", expect.any(Function));
    await cleanup?.();
  });
});
