import { readFileSync } from "node:fs";
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
    const module = await import("../dist/tui.js");
    expect(module.default.id).toBe("opencode-insights-tui");
    expect(typeof module.default.setup).toBe("function");
  });

  test("production entrypoints do not import v1 plugin contracts", () => {
    const rootSource = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
    const tuiSource = readFileSync(new URL("../src/tui.tsx", import.meta.url), "utf8");

    expect(rootSource).not.toContain("@opencode-ai/plugin");
    expect(tuiSource).not.toContain("@opencode-ai/plugin");
  });

});
