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
});
