import { readFile } from "node:fs/promises";
import { defineConfig, type Options } from "tsup";
import { transformSolidJsx } from "./scripts/solid-jsx.js";

/**
 * Build the JSX with babel-preset-solid instead of esbuild's JSX runtime.
 * esbuild emits plain prop values, which Solid reads once, so collapsed state
 * and every live metric would freeze. `jsx: "preserve"` makes a build that
 * accidentally skips this step fail loudly instead of shipping frozen props.
 */
const solidJsx = {
  name: "solid-jsx",
  setup(build: {
    onLoad: (
      options: { filter: RegExp },
      callback: (args: { path: string }) => Promise<{ contents: string; loader: "js" }>
    ) => void;
  }) {
    build.onLoad({ filter: /\.tsx$/ }, async (args) => ({
      contents: await transformSolidJsx(await readFile(args.path, "utf8"), args.path),
      loader: "js"
    }));
  }
};

export default defineConfig({
  entry: { tui: "src/tui.tsx" },
  format: ["esm"],
  dts: true,
  clean: true,
  sourcemap: false,
  external: ["@opencode/plugin", "@opencode/plugin/tui", "@opentui/core", "@opentui/solid", "solid-js"],
  esbuildPlugins: [solidJsx as NonNullable<Options["esbuildPlugins"]>[number]],
  esbuildOptions(options) {
    options.jsx = "preserve";
  }
});
