import { readFileSync } from "node:fs";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { createRoot } from "solid-js";
import defaultServer from "../src/index.js";

describe("plugin entrypoints", () => {
  test("exports a v2 server definition", () => {
    expect(defaultServer.id).toBe("opencode-insights");
    expect(typeof defaultServer.setup).toBe("function");
    expect(defaultServer).not.toHaveProperty("server");
    expect(defaultServer).not.toHaveProperty("tui");
  });

  test("exports a v2 tui definition", () => {
    const source = readFileSync(new URL("../src/tui.tsx", import.meta.url), "utf8");

    expect(source).toContain('from "@opencode/plugin/tui"');
    expect(source).toContain('const id = "opencode-insights-tui"');
    expect(source).toContain("Plugin.define({ id, setup })");
    expect(source).toContain("export default");
  });

  test("built TUI entrypoint is a runtime v2 definition", async () => {
    execFileSync("npm", ["run", "build"], { stdio: "ignore" });
    const module = await import("../dist/tui.js");
    expect(module.default.id).toBe("opencode-insights-tui");
    expect(typeof module.default.setup).toBe("function");
  });

  test("runs setup with a v2 context harness and cleans listeners and slots once", async () => {
    execFileSync("npm", ["run", "build"], { stdio: "ignore" });
    const module = await import("../dist/tui.js");
    const listeners = new Map<string, (event: unknown) => void>();
    let listenHandler: ((event: { details: unknown }) => void) | undefined;
    let unregistered = 0;
    const dataDir = mkdtempSync(join(tmpdir(), "opencode-insights-tui-"));
    writeFileSync(join(dataDir, "config.jsonc"), JSON.stringify({
      goUsage: { enabled: true, cookie: "cookie", workspaceID: "workspace", refreshMs: 0 }
    }));
    const claims: Array<{ append: string; render: (input: unknown) => unknown }> = [];
    const session = { id: "ses_root", title: "Main", time: { created: 1 }, model: { providerID: "opencode-go", modelID: "model" } };
    const assistantTool = { type: "tool", id: "tool_1", name: "task", state: { status: "running", input: { description: "Child task", subagent_type: "general" }, metadata: { sessionId: "ses_child", parentSessionId: "ses_root" }, time: { created: 1_000 } } };
    const context = {
      options: { dataDir },
      theme: { text: "white", textMuted: "gray", error: "red" },
      data: {
        on: (type: string, handler: (event: unknown) => void) => { listeners.set(type, handler); return () => { listeners.delete(type); unregistered += 1; }; },
       listen: (handler: (event: { details: unknown }) => void) => { listenHandler = handler; return () => { unregistered += 1; }; },
        session: {
          list: () => [session], get: (id: string) => id === session.id ? session : undefined, status: () => "idle",
           message: { list: () => [{ id: "msg_root", type: "assistant", time: { created: 900, completed: 1_600 }, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, content: [assistantTool] }], get: () => undefined }
        }
      },
      ui: {
        slot: (claim: { append: string; render: (input: unknown) => unknown }) => { claims.push(claim); return () => { unregistered += 1; }; },
        dialog: { show: () => undefined }, router: { navigate: () => undefined }
      }
    } as unknown as Parameters<typeof module.setup>[0];

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      return new Response(JSON.stringify({ rollingUsage: { usagePercent: 1, resetInSec: 10 }, weeklyUsage: { usagePercent: 2, resetInSec: 20 }, monthlyUsage: { usagePercent: 3, resetInSec: 30 } }), { status: 200, headers: { "content-type": "application/json" } });
    };
    let cleanup: (() => Promise<void> | void) | undefined;
    try {
      cleanup = await module.setup(context);
      expect(claims.map((claim) => claim.append)).toEqual(["prompt.footer.status", "sidebar.content"]);
      const sidebar = claims.find((claim) => claim.append === "sidebar.content")!;
      listenHandler?.({ details: { type: "session.created", id: "evt_created", created: 1_000, data: { sessionID: "ses_child", parentID: "ses_root", title: "Child", model: { providerID: "github-copilot", id: "model" } } } });
      listenHandler?.({ details: { type: "session.text.delta", id: "evt_delta", created: 1_050, data: { sessionID: "ses_root", assistantMessageID: "msg_root", ordinal: 0, delta: "hello" } } });
      listenHandler?.({ details: { type: "session.tool.called", id: "evt_called", created: 1_100, data: { sessionID: "ses_root", assistantMessageID: "msg_root", id: "tool_1", input: {}, executed: false } } });
      listenHandler?.({ details: { type: "session.tool.failed", id: "evt_failed", created: 1_200, data: { sessionID: "ses_root", assistantMessageID: "msg_root", id: "tool_1", error: { type: "error", message: "failed" }, content: [], executed: true } } });
      listenHandler?.({ details: { type: "session.compaction.ended", id: "evt_compact", created: 1_300, data: { sessionID: "ses_root", reason: "auto", text: "summary", recent: "recent" } } });
      listenHandler?.({ details: { type: "session.step.ended", id: "evt_step", created: 1_400, data: { sessionID: "ses_root", assistantMessageID: "msg_root", finish: "stop", cost: 0, tokens: { input: 1, output: 2, reasoning: 0, cache: { read: 0, write: 0 } } } } });
      const runtimeBeforeUsage = (cleanup as (() => Promise<void>) & { __insightsState?: { metrics: { sessionTokenUsageByID: Record<string, unknown> } } }).__insightsState!;
      expect(runtimeBeforeUsage.metrics.sessionTokenUsageByID.ses_root).toBeUndefined();
      listenHandler?.({ details: { type: "session.usage.updated", id: "evt_usage", created: 1_500, data: { sessionID: "ses_root", cost: 0, tokens: { input: 10, output: 7, reasoning: 2, cache: { read: 3, write: 1 } } } } });
      const runtime = (cleanup as (() => Promise<void>) & { __insightsState?: { activity: { bySessionID: Record<string, { warnings: number; autoCompacts: number; steps: number }> }; subagents: { children: Record<string, unknown> }; metrics: { sessionTokenUsageByID: Record<string, { responseCount: number; outputTokens: number }> }; render: (sessionID: string) => string } }).__insightsState!;
      expect(runtime.activity.bySessionID.ses_root).toMatchObject({ warnings: 1, autoCompacts: 1, steps: 1 });
      expect(runtime.subagents.children.ses_child).toBeDefined();
      expect(runtime.metrics.sessionTokenUsageByID.ses_root).toMatchObject({ responseCount: 1, inputTokens: 10, outputTokens: 7, reasoningTokens: 2 });
      expect(runtime.render("ses_root")).toContain("1 warning");
      expect(runtime.render("ses_root")).toContain("1 auto-compact");
      expect(runtime.render("ses_root")).toContain("1 subagent");
      await new Promise((resolve) => setTimeout(resolve, 50));
      let renderBoundary = "";
      try {
        claims.find((claim) => claim.append === "sidebar.content")?.render({ sessionID: "ses_root" });
      } catch (error) {
        renderBoundary = String(error);
      }
      expect(renderBoundary).toContain("No renderer found");
      const preCleanup = {
        activity: JSON.stringify(runtime.activity),
        metrics: JSON.stringify(runtime.metrics),
        subagents: JSON.stringify(runtime.subagents),
        renderBoundary
      };
      (cleanup as (() => Promise<void>) & { __insightsPreCleanup?: typeof preCleanup }).__insightsPreCleanup = preCleanup;
    } finally {
      globalThis.fetch = originalFetch;
      rmSync(dataDir, { recursive: true, force: true });
    }
    expect(listenHandler).toBeDefined();
    const preCleanup = (cleanup as (() => Promise<void>) & { __insightsPreCleanup: { activity: string; metrics: string; subagents: string; renderBoundary: string } }).__insightsPreCleanup;
    await cleanup?.();
    listenHandler?.({ details: { type: "session.compaction.ended", id: "after_cleanup", created: 2_000, data: { sessionID: "ses_root", reason: "auto", text: "late", recent: "late" } } });
    const runtimeAfterCleanup = (cleanup as (() => Promise<void>) & { __insightsState: { activity: unknown; metrics: unknown; subagents: unknown } }).__insightsState;
    expect(JSON.stringify(runtimeAfterCleanup.activity)).toBe(preCleanup.activity);
    expect(JSON.stringify(runtimeAfterCleanup.metrics)).toBe(preCleanup.metrics);
    expect(JSON.stringify(runtimeAfterCleanup.subagents)).toBe(preCleanup.subagents);
    let postCleanupBoundary = "";
    try {
      claims.find((claim) => claim.append === "sidebar.content")?.render({ sessionID: "ses_root" });
    } catch (error) {
      postCleanupBoundary = String(error);
    }
    expect(postCleanupBoundary).toBe(preCleanup.renderBoundary);
    await cleanup?.();
    expect(unregistered).toBe(3);
    expect(listeners.size).toBe(0);
    expect(listenHandler).toBeDefined();
  });

  test("production entrypoints do not import v1 plugin contracts", () => {
    const rootSource = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
    const tuiSource = readFileSync(new URL("../src/tui.tsx", import.meta.url), "utf8");

    expect(rootSource).not.toContain("@opencode-ai/plugin");
    expect(tuiSource).not.toContain("@opencode-ai/plugin");
  });

});
