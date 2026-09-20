import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { createListenerRegistry } from "../src/listeners.js";
import { hasRenderStateChanged } from "../src/render-state.js";

describe("TUI listener registry", () => {
  test("notifies only listeners registered with the matching registry", () => {
    const metrics = createListenerRegistry();
    const subagents = createListenerRegistry();
    let metricUpdates = 0;
    let subagentUpdates = 0;

    metrics.subscribe(() => metricUpdates++);
    subagents.subscribe(() => subagentUpdates++);

    metrics.notify();

    expect(metricUpdates).toBe(1);
    expect(subagentUpdates).toBe(0);
  });

  test("detects only visual sidebar state changes", () => {
    const state = { content: "Subagents", visible: true, height: "auto" as const };

    expect(hasRenderStateChanged(state, { ...state })).toBe(false);
    expect(hasRenderStateChanged(state, { ...state, content: "Subagents\n1 running" })).toBe(true);
  });
});

describe("v2 TUI contract", () => {
  test("uses v2 context APIs and does not retain v1 APIs", () => {
    const source = readFileSync(new URL("../src/tui.tsx", import.meta.url), "utf8");

    expect(source).toContain("context.data.on");
    expect(source).toContain("context.ui.slot");
    expect(source).toContain("context.ui.router.navigate");
    expect(source).toContain("context.ui.dialog");
    expect(source).toContain("return async () =>");
    expect(source).not.toContain("@opencode-ai/plugin/tui");
    expect(source).not.toContain("api.slots.register");
    expect(source).not.toContain("api.route.navigate");
    expect(source).not.toContain("api.lifecycle.onDispose");
    expect(source).not.toMatch(/slot\.(input|sidebar|footer|prompt)/);
  });
});
