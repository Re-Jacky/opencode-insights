import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

const source = () => readFileSync(new URL("../src/tui.tsx", import.meta.url), "utf8");

describe("V2 TUI plugin shell", () => {
  test("defines the plugin with the stable id", () => {
    expect(source()).toContain("Plugin.define({");
    expect(source()).toContain('id: "opencode-insights"');
  });

  test("subscribes to V2 events and registers both slots", () => {
    expect(source()).toContain("context.data.listen(");
    expect(source()).toContain('append: "sidebar.content"');
    expect(source()).toContain('append: "prompt.footer.status"');
  });

  test("does not use the removed V1 plugin API", () => {
    const text = source();
    expect(text).not.toContain("@opencode-ai/plugin");
    expect(text).not.toContain("api.event.on");
    expect(text).not.toContain("api.theme.current");
  });

  test("renders prompt-right metrics and token usage", () => {
    expect(source()).toContain("PromptRight");
    expect(source()).toContain("renderPromptRightMetricsText");
    expect(source()).toContain("renderSessionTokenUsage");
  });

  test("renders the session analysis sidebar and dialog", () => {
    const text = source();
    expect(text).toContain("SessionAnalysisSection");
    expect(text).toContain("SessionAnalysisDialog");
    expect(text).toContain("buildSessionAnalysisRows");
    expect(text).toContain("context.ui.dialog.show(");
    expect(text).toContain('context.ui.dialog.set({ size: "large" })');
  });
});
