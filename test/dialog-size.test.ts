import { describe, expect, test } from "vitest";
import { selectDialogSize } from "../src/dialog-size.js";

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
