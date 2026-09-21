import { defineConfig } from "tsup";

export default defineConfig({
  entry: { tui: "src/tui.tsx" },
  format: ["esm"],
  dts: true,
  clean: true,
  sourcemap: false,
  external: ["@opencode/plugin", "@opencode/plugin/tui", "@opentui/core", "@opentui/solid", "solid-js"],
  esbuildOptions(options) {
    options.jsx = "automatic";
    options.jsxImportSource = "@opentui/solid";
  }
});
