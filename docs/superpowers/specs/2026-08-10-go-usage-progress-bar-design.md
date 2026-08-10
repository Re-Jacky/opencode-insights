# Go Usage Progress Bar — Design

**Date:** 2026-08-10
**Status:** Approved (design presented to user 2026-08-10, user confirmed)

## Problem

The Go Usage sidebar rows render a fixed 4-character progress bar:

```
Rolling  12% █░░░ 2h 33m
Monthly   1% █░░░ 1d 16h
```

Each block equals 25%, and the fill is computed with `Math.ceil`, so even
1% shows a full block. The bar is too short and too coarse — a 1% usage
reads as 25% at a glance.

## Design

### `src/go-usage.ts`

New pure, exported helper:

```ts
export function formatUsageBar(usagePercent: number, width = 10): string
```

- Clamp `usagePercent` to `[0, 100]`.
- Total steps = `width × 8` (80 for the default width); each full block is
  8 steps; the remainder renders as one of the 8-step partial block
  characters `▏▎▍▌▋▊▉`.
- Filled steps = `Math.round(usagePercent / 100 × steps)`, clamped to
  `[0, steps]`.
- Render: `width` characters — `█` per full block, the partial character
  if any remainder, then `░` for the rest.

Examples (width 10):

| percent | bar            |
|---------|----------------|
| 0%      | `░░░░░░░░░░`   |
| 1%      | `▏░░░░░░░░░`   |
| 12%     | `█▎░░░░░░░░`   |
| 27%     | `██▊░░░░░░░`   |
| 50%     | `█████░░░░░`   |
| 100%    | `██████████`   |
| >100%   | `██████████`   |

### `formatGoUsageRow`

Unchanged signature; the bar becomes `formatUsageBar(row.usagePercent)`:

```
Rolling  12% █▎░░░░░░░░ 2h 33m
Monthly   1% ▏░░░░░░░░░ 1d 16h
```

Label/percentage/reset layout untouched. Row line length grows from
~24 to ~30 characters.

### TUI

No changes: `renderGoUsageSidebar` (src/tui.tsx) already calls
`formatGoUsageRow`. Partial block characters render in standard terminal
fonts; `░` and `█` are already used today.

## Testing

`test/go-usage.test.ts`:

- New `formatUsageBar` describe block: 0%, 1% (sliver), 12% (partial
  second char), 27%, 50%, 100% (full), and >100% clamping.
- Update the three existing `formatGoUsageRow` expectations to the new
  bar strings (12% → `█▎░░░░░░░░`, 27% → `██▊░░░░░░░`, 100% →
  `██████████`).
