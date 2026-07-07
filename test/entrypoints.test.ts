import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import defaultServer, { id, server } from "../src/index.js";

describe("plugin entrypoints", () => {
  test("exports server plugin as default module with id and named server", () => {
    expect(id).toBe("opencode-insights");
    expect(typeof server).toBe("function");
    expect(defaultServer).toEqual({ id, server });
  });

  test("exports tui plugin as default module with id and named tui", () => {
    const source = readFileSync(new URL("../src/tui.tsx", import.meta.url), "utf8");

    expect(source).toContain('const id = "opencode-insights-tui"');
    expect(source).toContain("export { id, tui }");
    expect(source).toContain("export default { id, tui }");
  });
});
