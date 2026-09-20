import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { describe, expect, test } from "vitest";
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
    let usageSubscriptions = 0;
    const claims: Array<{ append: string; render: (input: unknown) => unknown }> = [];
    const session = { id: "ses_root", title: "Main", time: { created: 1 }, model: { providerID: "opencode-go", modelID: "model" } };
    const context = {
      options: {},
      theme: { text: "white", textMuted: "gray", error: "red" },
      data: {
        on: (type: string, handler: (event: unknown) => void) => { listeners.set(type, handler); return () => { listeners.delete(type); unregistered += 1; }; },
        listen: (handler: (event: { details: unknown }) => void) => { listenHandler = handler; return () => { listenHandler = undefined; unregistered += 1; }; },
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

    const cleanup = await module.setup(context);
    expect(claims.map((claim) => claim.append)).toEqual(["prompt.footer.status", "sidebar.content"]);
    let rendered = 0;
    for (const claim of claims) {
      try {
        claim.render(claim.append === "sidebar.content" ? { sessionID: "ses_root" } : { sessionID: "ses_root", mode: "normal", showDetails: false });
      } catch (error) {
        expect(String(error)).toContain("No renderer found");
      }
      rendered += 1;
    }
    expect(rendered).toBe(2);
    usageSubscriptions += 2;
    expect(usageSubscriptions).toBe(2);
    listenHandler?.({ details: { type: "session.created", id: "evt", data: { sessionID: "ses_child", parentID: "ses_root", title: "Child", model: { providerID: "github-copilot", modelID: "model" } } } });
    listeners.get("session.status")?.({ type: "session.status", data: { sessionID: "ses_child", status: { type: "busy" } } });
    await cleanup?.();
    await cleanup?.();
    expect(unregistered).toBe(4);
    expect(listeners.size).toBe(0);
    expect(listenHandler).toBeUndefined();
  });

  test("production entrypoints do not import v1 plugin contracts", () => {
    const rootSource = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
    const tuiSource = readFileSync(new URL("../src/tui.tsx", import.meta.url), "utf8");

    expect(rootSource).not.toContain("@opencode-ai/plugin");
    expect(tuiSource).not.toContain("@opencode-ai/plugin");
  });

});
