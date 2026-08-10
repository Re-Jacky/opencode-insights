# Go Usage Sidebar — Design

**Date:** 2026-08-04
**Status:** Approved (design presented to user 2026-08-04, user confirmed)

## Problem

OpenCode Go (subscription plan, `opencode-go` provider) applies rolling (5h), weekly, and
monthly usage limits to its API key. The only official way to view current usage is the
browser console (`https://opencode.ai/workspace/<workspaceID>/go`), which server-side renders
the values as SolidStart `$R[n]` serialized payloads in the HTML document.

Goal: surface rolling/weekly/monthly Go usage in the opencode-insights TUI right sidebar when
the current session uses the `opencode-go` provider.

## Verified mechanics (investigation, 2026-08-04)

- The page `https://opencode.ai/workspace/<workspaceID>/go` requires the `auth` httpOnly
  session cookie (SolidStart `useSession`, 365-day maxAge). Without it the server redirects
  to `auth.opencode.ai/authorize` (302) — detection: `redirect: "manual"` + 3xx status.
- The document contains (live-tested with a real cookie):
  ```
  ...rollingUsage:$R[36]={status:"ok",resetInSec:11619,usagePercent:12},weeklyUsage:$R[37]={status:"ok",resetInSec:489596,usagePercent:11},monthlyUsage:$R[38]={status:"ok",resetInSec:151717,usagePercent:27}...
  ```
- Serializer emits JS object literals (unquoted keys, `!0`/`!1`); the three usage objects are
  flat (no nesting). Response ~16KB.
- `resetInSec` is server-computed relative to its request time (rolling: last-update + 5h;
  weekly: calendar week end; monthly: subscription-month end).

## Config

File: `~/.opencode-insights/config.json` (existing file, holds `promptRightMetrics`).

```json
{
  "promptRightMetrics": ["tps", "avg", "used", "cache"],
  "goUsage": {
    "enabled": true,
    "cookie": "Fe26.2**...",
    "workspaceID": "wrk_...",
    "refreshMs": 300000
  }
}
```

- **`goUsage.enabled` — opt-in switch, defaults to `false`.** The section only activates when
  the user sets it to `true` explicitly. Without it, no Go-usage data is fetched and no
  section is rendered, even if cookie/workspaceID are present.
- `goUsage.cookie` + `goUsage.workspaceID` must both be set for the section to activate
  (in addition to `goUsage.enabled: true`).
- `goUsage.refreshMs` — poll interval; default `300000` (5 min), clamped to `>= 60000`.
- Unknown/invalid values are ignored (same behavior as `promptRightMetrics`).

## Module: `src/go-usage.ts`

Pure functions, no side effects:

- `parseGoUsageHtml(html: string): GoUsage | undefined`
  - Regex: `/(rollingUsage|weeklyUsage|monthlyUsage):\$R\[(\d+)\]=\{([^{}]*)\}/g`
  - Each object literal: wrap in `{}`, quote keys (`/([a-zA-Z]+):/g` → `"$1":`), `JSON.parse`.
  - `GoUsage = { rollingUsage, weeklyUsage, monthlyUsage }`, each
    `{ status: string; resetInSec: number; usagePercent: number }`.
  - Returns `undefined` unless all three parse.
- `fetchGoUsage(input: { cookie: string; workspaceID: string }, fetchImpl?): Promise<GoUsage>`
  - `GET https://opencode.ai/workspace/{workspaceID}/go`
  - Headers: `User-Agent: Mozilla/5.0`, `Cookie: auth=<cookie>`, `redirect: "manual"`.
  - Non-200 or 3xx redirect → throws `GoUsageError` (e.g. "auth required").
  - Parse failure → throws `GoUsageError`.
  - `fetchImpl` injectable for tests (defaults to global `fetch`).
- `formatReset(seconds: number): string` — `3h14m`, `5d16h`, `1d18m` style.

## TUI sidebar: `src/tui.tsx`

New `GoUsageSidebar` component in `sidebar_content`, between `TokenUsageSidebar` and
`SubagentSidebar`. Follows the existing collapsible-section pattern (text element + ref,
`subscribe`/`sync`, `createSignal` collapsed, `StyledText` chunks).

Visibility: per-session `usesOpenCodeGo` flag —
- set true on `message.updated` where `info.providerID === "opencode-go"` (and during
  `hydrateSessionMetrics` from message info),
- section rendered only when `usesOpenCodeGo` is true AND config has
  `goUsage.enabled: true` AND cookie + workspaceID.

Data/refresh:
- Module-level `GoUsageState` per TUI instance: `{ data?, error?, lastFetchAt }` +
  in-flight guard (no concurrent fetches).
- Initial fetch when the section first becomes visible; refetch every `goUsageRefreshMs`
  (setInterval, cleared on dispose). Failed fetches keep the previous `error` state and
  retry on the next tick.
- A 1s `sync` tick recomputes countdowns as `resetInSec − (now − lastFetchAt)/1000` (floored
  at 0) so the display ticks without refetching.

Rendering (collapsed title + 3 rows):

```
▼ Go Usage
  Rolling  12% ██░░ 3h14m
  Weekly   11% ██░░ 5d16h
  Monthly  27% ████ 1d18h
```

- Progress bar: 4 cells, `percent = floor(usagePercent / 25)` filled.
- Error state: single muted line `Go usage: auth expired — update cookie in config` (or
  generic fetch error message); section stays visible and keeps polling.

## Testing (vitest, `test/`)

- `go-usage.test.ts`:
  - `parseGoUsageHtml` — real captured HTML fixture (from live test), malformed/partial
    HTML → `undefined`.
  - `fetchGoUsage` — mocked `fetchImpl`: success, login redirect (3xx), non-200, parse
    failure, throws `GoUsageError`.
  - `formatReset` — boundary cases (0, 59s, 1h, 24h, multi-day).
- `tui.test.ts` — section visibility driven by `usesOpenCodeGo` + config completeness.

## Out of scope

- Automating cookie retrieval (CDP/Chrome) — user declined; cookie is copied manually.
- Display in the web viewer.
- Tracking usage server-side / estimating from local costs.
