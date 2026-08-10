# Go Usage Progress Bar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Go Usage sidebar's 4-char integer-block progress bar (25%/block) with a 10-char, 8-step-partial-block bar (80 steps, ~1.25%/step) so small percentages render honestly.

**Architecture:** Add a pure `formatUsageBar(usagePercent, width = 10)` helper in src/go-usage.ts that converts a percentage into a fixed-width string of full blocks (`█`), one 8-step partial block (`▏▎▍▌▋▊▉`), and empty fill (`░`). `formatGoUsageRow` composes it; the TUI is untouched.

**Tech Stack:** TypeScript (NodeNext ESM), vitest.

**Spec:** `docs/superpowers/specs/2026-08-10-go-usage-progress-bar-design.md`

## Global Constraints

- `formatUsageBar(usagePercent: number, width = 10): string` — percent clamped to `[0, 100]`; filled = `Math.round(percent / 100 × width × 8)`, clamped; render `width` chars.
- Partial block characters, in order: `▏▎▍▌▋▊▉` (1/8 through 7/8); `█` is a full block; `░` is empty.
- `formatGoUsageRow` signature and label/percent/reset layout unchanged — only the bar changes.
- NodeNext ESM: relative imports need explicit `.js` extensions; tests import from `src/` directly.
- Release gate: `npm run verify` (typecheck && test && build) must pass.

---

### Task 1: Finer Go Usage progress bar

**Files:**
- Modify: `src/go-usage.ts` (formatGoUsageRow at ~69-73; add formatUsageBar near it)
- Test: `test/go-usage.test.ts` (formatGoUsageRow describe at ~253-274)

**Interfaces:**
- Consumes: `GoUsageRow` (existing type in src/go-usage.ts).
- Produces: `formatUsageBar(usagePercent: number, width?: number): string` (exported).

- [ ] **Step 1: Write the failing tests**

Add this block to `test/go-usage.test.ts` (before the existing `describe("formatGoUsageRow", ...)` at line 253) and update the three row expectations inside the existing describe:

```ts
describe("formatUsageBar", () => {
  test("renders an empty bar at zero percent", () => {
    expect(formatUsageBar(0)).toBe("░░░░░░░░░░");
  });

  test("renders a sliver for one percent", () => {
    expect(formatUsageBar(1)).toBe("▏░░░░░░░░░");
  });

  test("renders partial blocks for fractional step counts", () => {
    expect(formatUsageBar(12)).toBe("█▎░░░░░░░░");
    expect(formatUsageBar(27)).toBe("██▊░░░░░░░░");
  });

  test("renders a half-filled bar at fifty percent", () => {
    expect(formatUsageBar(50)).toBe("█████░░░░░");
  });

  test("fills the bar completely at and above one hundred percent", () => {
    expect(formatUsageBar(100)).toBe("██████████");
    expect(formatUsageBar(150)).toBe("██████████");
  });

  test("honors a custom width", () => {
    expect(formatUsageBar(50, 4)).toBe("██░░");
  });
});
```

Inside the existing `describe("formatGoUsageRow", ...)`, update the three `expect(...).toBe(...)` strings (lines 255-257, 261-265, 270-272):

```ts
  test("aligns label, percentage, bar and reset with generous spacing", () => {
    expect(formatGoUsageRow({ label: "Rolling", usagePercent: 12, reset: "2h 33m" })).toBe(
      "Rolling  12% █▎░░░░░░░░ 2h 33m"
    );
  });

  test("keeps the percentage column aligned for single and double digit values", () => {
    expect(formatGoUsageRow({ label: "Weekly", usagePercent: 11, reset: "5d 15h" })).toBe(
      "Weekly   11% █▏░░░░░░░░ 5d 15h"
    );
    expect(formatGoUsageRow({ label: "Monthly", usagePercent: 27, reset: "1d 17h" })).toBe(
      "Monthly  27% ██▊░░░░░░░░ 1d 17h"
    );
  });

  test("fills the bar completely at 100 percent", () => {
    expect(formatGoUsageRow({ label: "Rolling", usagePercent: 100, reset: "0m" })).toBe(
      "Rolling  100% ██████████ 0m"
    );
  });
```

Add `formatUsageBar` to the import list at the top of `test/go-usage.test.ts` (it already imports `formatGoUsageRow` at line 8).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- go-usage.test.ts`
Expected: FAIL — "formatUsageBar is not defined" for the new describe; the three updated row expectations fail with the old 4-char bars.

- [ ] **Step 3: Implement in `src/go-usage.ts`**

Add the helper and update `formatGoUsageRow` (place `formatUsageBar` directly above `formatGoUsageRow`):

```ts
const BLOCK_PARTIALS = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"];

export function formatUsageBar(usagePercent: number, width = 10): string {
  const percent = Math.max(0, Math.min(100, usagePercent));
  const steps = width * 8;
  const filled = Math.min(steps, Math.max(0, Math.round((percent / 100) * steps)));
  const full = Math.floor(filled / 8);
  const remainder = filled % 8;
  const partial = BLOCK_PARTIALS[remainder] ?? "";
  const empty = Math.max(0, width - full - (partial.length > 0 ? 1 : 0));
  return "█".repeat(full) + partial + "░".repeat(empty);
}

export function formatGoUsageRow(row: GoUsageRow): string {
  const bar = formatUsageBar(row.usagePercent);
  return `${row.label.padEnd(9)}${`${row.usagePercent}%`.padEnd(3)} ${bar} ${row.reset}`;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- go-usage.test.ts`
Expected: PASS.

- [ ] **Step 5: Run typecheck and the full suite**

Run: `npm run typecheck && npm test`
Expected: typecheck PASS; full suite PASS.

- [ ] **Step 6: Commit**

```bash
git add src/go-usage.ts test/go-usage.test.ts
git commit -m "feat: finer go usage progress bar with partial blocks"
```
