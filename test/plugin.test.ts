import { describe, expect, test } from "vitest";
import plugin from "../src/index.js";

describe("plugin definitions", () => {
  test("exposes a callable server setup", () => {
    expect(plugin.id).toBe("opencode-insights");
    expect(typeof plugin.setup).toBe("function");
  });
});
