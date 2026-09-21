import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { transformSolidJsx } from "../scripts/solid-jsx.js";

const tuiSource = () => readFileSync(new URL("../src/tui.tsx", import.meta.url), "utf8");

describe("Solid JSX build transform", () => {
  test("emits accessor props so the renderer can track them", async () => {
    const code = await transformSolidJsx(
      `function Thing(props: { on: boolean }) {
        return <Show when={!props.on}><text>on</text></Show>;
      }`,
      "thing.tsx"
    );

    expect(code).toContain("get when()");
    expect(code).not.toContain("<Show");
  });

  test("compiles the plugin source into getter props", async () => {
    const code = await transformSolidJsx(tuiSource(), "tui.tsx");

    // Without these getters every Show/For/dynamic prop is read once and stays
    // frozen, so collapsing sections and live metrics silently stop working.
    expect(code).toContain("get when()");
    expect(code).toContain("get collapsed()");
    expect(code).toContain("get onMouseUp()");
    expect(code).not.toMatch(/<box[\s>]/);
  });
});
