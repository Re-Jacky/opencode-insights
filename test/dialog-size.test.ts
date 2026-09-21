import { describe, expect, test } from "vitest";
import { selectAnalysisDialogLayout, selectDialogSize } from "../src/dialog-size.js";

describe("selectDialogSize", () => {
  test("uses the smallest size for short content", () => {
    expect(selectDialogSize(0)).toBe("medium");
    expect(selectDialogSize(10)).toBe("medium");
  });

  test("uses large for medium content", () => {
    expect(selectDialogSize(11)).toBe("large");
    expect(selectDialogSize(24)).toBe("large");
  });

  test("uses xlarge for long content", () => {
    expect(selectDialogSize(25)).toBe("xlarge");
    expect(selectDialogSize(1000)).toBe("xlarge");
  });

  test("treats negative counts as empty", () => {
    expect(selectDialogSize(-3)).toBe("medium");
  });
});

describe("selectAnalysisDialogLayout", () => {
  // The host renders dialogs inside a full-height overlay that starts at
  // height / 4, so the box hugs its content and only caps what would overflow.
  test("hugs short content", () => {
    expect(selectAnalysisDialogLayout(3, 40)).toEqual({ rowHeight: 3, scrollHeight: 5, height: 7 });
  });

  test("grows with content", () => {
    expect(selectAnalysisDialogLayout(12, 40)).toEqual({ rowHeight: 12, scrollHeight: 14, height: 16 });
  });

  test("caps long content so the scrollbox handles the rest", () => {
    expect(selectAnalysisDialogLayout(100, 40)).toEqual({ rowHeight: 23, scrollHeight: 25, height: 27 });
  });

  test("keeps a single usable row on a tiny terminal", () => {
    expect(selectAnalysisDialogLayout(10, 8)).toEqual({ rowHeight: 1, scrollHeight: 3, height: 5 });
    expect(selectAnalysisDialogLayout(10, 1)).toEqual({ rowHeight: 1, scrollHeight: 3, height: 5 });
  });

  test("treats negative counts as a single row", () => {
    expect(selectAnalysisDialogLayout(-4, 40)).toEqual({ rowHeight: 1, scrollHeight: 3, height: 5 });
  });
});
