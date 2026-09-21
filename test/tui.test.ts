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
    expect(source()).toContain('prepend: "sidebar.content"');
    expect(source()).toContain('append: "session.composer.top"');
  });

  test("does not use the removed V1 plugin API", () => {
    const text = source();
    expect(text).not.toContain("@opencode-ai/plugin");
    expect(text).not.toContain("api.event.on");
    expect(text).not.toContain("api.theme.current");
  });

  test("spaces the prepended sidebar sections like the native ones", () => {
    // The host applies gap 1 between sidebar.content contributions; the single
    // wrapper box this slot returns has to reproduce that between its sections.
    expect(source()).toContain("gap={1}");
  });

  test("renders prompt-right metrics and token usage", () => {
    expect(source()).toContain("PromptRight");
    expect(source()).toContain("renderPromptRightMetricsText");
    expect(source()).toContain("renderSessionTokenUsage");
    expect(source()).toContain('justifyContent="flex-end"');
  });

  test("renders the session analysis sidebar and dialog", () => {
    const text = source();
    expect(text).toContain("SessionAnalysisSection");
    expect(text).toContain("SessionAnalysisDialog");
    expect(text).toContain("buildSessionAnalysisRows");
    expect(text).toContain("context.ui.dialog.show(");
    expect(text).toContain("selectDialogSize(");
    expect(text).toContain("visibleAnalysisRowCount(");
    // dialog.show() resets the presentation options, so the size only sticks when
    // it is applied from inside the dialog component, after show().
    expect(text.indexOf("context.ui.dialog.set({ size: selectDialogSize(")).toBeGreaterThan(
      text.indexOf("context.ui.dialog.show(")
    );
  });

  test("renders subagents from the native session store with router navigation and hover", () => {
    const text = source();
    expect(text).toContain("SubagentsSection");
    expect(text).toContain("getSubagentSidebarModel");
    // Liveness and identity come from the host's session store, not from an
    // event-derived status machine.
    expect(text).toContain("context.data.session.list()");
    expect(text).toContain("context.data.session.status(");
    expect(text).toContain("parentID === props.sessionID");
    expect(text).toContain('context.ui.router.navigate({ type: "session", sessionID: row.id })');
    expect(text).toContain("onMouseMove");
    expect(text).toContain("theme.background.raised.base");
  });

  test("renders provider-gated Go and Copilot usage sections", () => {
    const text = source();
    expect(text).toContain("GoUsageSection");
    expect(text).toContain("CopilotUsageSection");
    expect(text).toContain("goUsageSectionVisible");
    expect(text).toContain("copilotUsageSectionVisible");
    expect(text).toContain("goProviders");
    expect(text).toContain("usesOpenCodeGo(");
    expect(text).toContain("copilotProviders");
    expect(text).toContain("usesCopilot(");
  });
});
