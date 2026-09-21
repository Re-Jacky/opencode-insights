import { transformAsync } from "@babel/core";
import presetTypeScript from "@babel/preset-typescript";
import presetSolid from "babel-preset-solid";

/**
 * Compiles a TSX source file with `babel-preset-solid` in universal mode.
 *
 * esbuild's own JSX runtime emits plain prop values, which Solid only reads
 * once; every `Show`/`For`/`when`/`each`/dynamic prop would then be frozen and
 * clicking a section could never re-render it. The `@opentui/solid` Bun plugin
 * applies this same transform to `.tsx` plugin sources at load time, so we run
 * it here at build time to ship getter props.
 */
export function transformSolidJsx(code, filename) {
  return transformAsync(code, {
    filename,
    configFile: false,
    babelrc: false,
    presets: [
      [presetSolid, { moduleName: "@opentui/solid", generate: "universal" }],
      [presetTypeScript]
    ]
  }).then((result) => result?.code ?? code);
}
