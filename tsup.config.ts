import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    tui: "src/tui.tsx",
    cli: "src/cli.ts"
  },
  format: ["esm"],
  dts: true,
  clean: true,
  sourcemap: false,
  external: [
    "@opencode-ai/plugin",
    "@opencode-ai/plugin/tui",
    "@opentui/core",
    "@opentui/solid",
    "solid-js"
  ],
  esbuildOptions(options) {
    options.jsx = "automatic";
    options.jsxImportSource = "@opentui/solid";
  }
});
