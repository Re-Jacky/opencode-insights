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
    const context = {
      options: { dataDir },
      theme: { text: "white", textMuted: "gray", error: "red" },
      data: {
        on: (type: string, handler: (event: unknown) => void) => { listeners.set(type, handler); return () => { listeners.delete(type); unregistered += 1; }; },
       listen: (handler: (event: { details: unknown }) => void) => { listenHandler = handler; return () => { unregistered += 1; }; },
        session: {
          list: () => [session], get: (id: string) => id === session.id ? session : undefined, status: () => "idle",
          message: { list: () => [], get: () => undefined }
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
      for (let index = 0; index < 2; index += 1) {
        createRoot((dispose) => {
          try {
            sidebar.render({ sessionID: "ses_root" });
          } catch (error) {
            expect(String(error)).toContain("No renderer found");
          }
          dispose();
        });
      }
      listenHandler?.({ details: { type: "session.created", id: "evt_created", created: 1_000, data: { sessionID: "ses_child", parentID: "ses_root", title: "Child", model: { providerID: "github-copilot", id: "model" } } } });
      listenHandler?.({ details: { type: "session.tool.called", id: "evt_called", created: 1_100, data: { sessionID: "ses_root", assistantMessageID: "msg_root", id: "tool_1", input: {}, executed: false } } });
      listenHandler?.({ details: { type: "session.tool.failed", id: "evt_failed", created: 1_200, data: { sessionID: "ses_root", assistantMessageID: "msg_root", id: "tool_1", error: { type: "error", message: "failed" }, content: [], executed: true } } });
      listenHandler?.({ details: { type: "session.compaction.ended", id: "evt_compact", created: 1_300, data: { sessionID: "ses_root", reason: "auto", text: "summary", recent: "recent" } } });
      listenHandler?.({ details: { type: "session.step.ended", id: "evt_step", created: 1_400, data: { sessionID: "ses_root", assistantMessageID: "msg_root", finish: "stop", cost: 0, tokens: { input: 1, output: 2, reasoning: 0, cache: { read: 0, write: 0 } } } } });
      await new Promise((resolve) => setTimeout(resolve, 50));
    } finally {
      globalThis.fetch = originalFetch;
      await cleanup?.();
      rmSync(dataDir, { recursive: true, force: true });
    }
    expect(listenHandler).toBeDefined();
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
