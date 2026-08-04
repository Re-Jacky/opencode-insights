import { describe, expect, test } from "vitest";
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
