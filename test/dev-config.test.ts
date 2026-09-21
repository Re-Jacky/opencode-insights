import { describe, expect, test } from "vitest";
import { addLocalPlugin, readPluginSpecs, revertLocalPlugin } from "../scripts/dev-config.js";

const LOCAL = "/Users/me/opencode-insights";
const OFFICIAL = "@rejacky/opencode-insights@latest";

describe("dev deploy config transforms", () => {
  test("adds the local path, removes published insights specs, and preserves other entries", () => {
    const source = [
      "{",
      "  // my plugins",
      '  "plugins": ["superpowers@git+https://github.com/obra/superpowers.git", "@rejacky/opencode-insights"],',
      '  "theme": { "mode": "dark" }',
      "}",
      ""
    ].join("\n");

    const result = addLocalPlugin(source, LOCAL);

    expect(result.plugins).toEqual(["superpowers@git+https://github.com/obra/superpowers.git", LOCAL]);
    expect(result.changed).toBe(true);
    expect(result.source).toContain("// my plugins");
    expect(result.source).toContain('"theme"');
  });

  test("addLocalPlugin is idempotent", () => {
    const once = addLocalPlugin('{\n  "plugins": []\n}\n', LOCAL);
    const twice = addLocalPlugin(once.source, LOCAL);
    expect(twice.plugins).toEqual([LOCAL]);
    expect(twice.changed).toBe(false);
  });

  test("revert removes the local path and restores the official spec", () => {
    const debugged = addLocalPlugin('{\n  "plugins": ["superpowers@x"]\n}\n', LOCAL).source;
    const result = revertLocalPlugin(debugged, LOCAL, OFFICIAL);
    expect(result.plugins).toEqual(["superpowers@x", OFFICIAL]);
    expect(result.changed).toBe(true);
  });

  test("readPluginSpecs reads string entries only", () => {
    expect(readPluginSpecs('{\n  "plugins": ["a", 2, "b"]\n}\n')).toEqual(["a", "b"]);
    expect(readPluginSpecs('{\n  "other": true\n}\n')).toEqual([]);
  });
});
