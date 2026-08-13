import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import defaultServer, { id, server, tui } from "../src/index.js";

describe("plugin entrypoints", () => {
  test("exports server-only default module with id and named server", () => {
    expect(id).toBe("opencode-insights");
    expect(typeof server).toBe("function");
    expect(typeof tui).toBe("function");
    expect(defaultServer).toEqual({ id, server });
    expect(defaultServer).not.toHaveProperty("tui");
  });

  test("exports tui plugin as default module with id and named tui", () => {
    const source = readFileSync(new URL("../src/tui.tsx", import.meta.url), "utf8");

    expect(source).toContain('const id = "opencode-insights-tui"');
    expect(source).toContain("export { id, tui }");
    expect(source).toContain("export default { id, tui }");
  });

  test("opens a subagent row in OpenCode's native session route", () => {
    const source = readFileSync(new URL("../src/tui.tsx", import.meta.url), "utf8");

    expect(source).toContain('api.route.navigate("session", { sessionID: row.id })');
    expect(source).toContain("onMouseUp={openSubagent}");
  });

  test("highlights the hovered subagent row", () => {
    const source = readFileSync(new URL("../src/tui.tsx", import.meta.url), "utf8");

    expect(source).toContain("onMouseMove={hoverSubagent}");
    expect(source).toContain("onMouseOut={clearHoveredSubagent}");
    expect(source).toContain("api.theme.current.backgroundElement");
  });

  test("renders session-wide token usage in the sidebar", () => {
    const source = readFileSync(new URL("../src/tui.tsx", import.meta.url), "utf8");

    expect(source).toContain("function TokenUsageSidebar");
    expect(source).toContain("renderSessionTokenUsage");
    expect(source).toContain("api.client.session.messages");
    expect(source).toContain("toggleTokenUsage");
    expect(source).toContain("onMouseDown={toggleTokenUsage}");
  });

  test("renders the session analysis sidebar and dialog", () => {
    const source = readFileSync(new URL("../src/tui.tsx", import.meta.url), "utf8");

    expect(source).toContain("function SessionAnalysisSidebar");
    expect(source).toContain('"Session Analysis"');
    expect(source).toContain("api.ui.dialog.replace");
    expect(source).toContain("function SessionAnalysisDialog");
    expect(source).toContain("buildSessionAnalysisRows");
    expect(source).toContain("treeActivity");
  });

  test("session analysis dialog does not force the scrollbar visible", () => {
    const source = readFileSync(new URL("../src/tui.tsx", import.meta.url), "utf8");
    const dialog = source.slice(source.indexOf("function SessionAnalysisDialog"));

    expect(dialog).toContain("<scrollbox");
    expect(dialog).not.toContain("verticalScrollbarOptions={{ visible: true }}");
  });
});
