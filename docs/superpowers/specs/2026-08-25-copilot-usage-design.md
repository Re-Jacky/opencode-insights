# Copilot Usage Sidebar — Design

**Date:** 2026-08-25
**Status:** Draft

## Problem

GitHub Copilot (business/enterprise plans) enforces a monthly premium-interaction quota.
The only way to view current usage is the GitHub billing page or the VS Code Copilot
status bar. There is no built-in way to see Copilot quota from the OpenCode TUI.

Goal: surface premium-interaction usage (used/total, progress bar, days until reset) in
the opencode-insights TUI right sidebar when the current session uses the `github-copilot`
provider.

## Verified mechanics (investigation, 2026-08-25)

- Endpoint: `GET https://api.github.com/copilot_internal/user`
- Auth: Bearer token from OpenCode's auth store (`~/.local/share/opencode/auth.json`,
  key `github-copilot.access` or `.refresh`). Same token the Copilot CLI uses.
- Response (live-tested with a real token, 2026-08-25):
  ```json
  {
    "login": "zyao_mstr",
    "copilot_plan": "business",
    "quota_reset_date_utc": "2026-09-01T00:00:00.000Z",
    "token_based_billing": true,
    "quota_snapshots": {
      "premium_interactions": {
        "entitlement": 3500,
        "remaining": 558,
        "quota_remaining": 558.3,
        "percent_remaining": 15.9,
        "credits_used": 2930,
        "overage_permitted": true,
        "unlimited": false,
        "has_quota": true
      },
      "chat": { "unlimited": true, "entitlement": 0 },
      "completions": { "unlimited": true, "entitlement": 0 }
    }
  }
  ```
- Only `premium_interactions` has a finite quota on paid plans. `chat` and `completions`
  are unlimited — skip when `unlimited: true`.
- `quota_reset_date_utc` is an absolute ISO 8601 timestamp. Days remaining computed as
  `ceil((resetDate - now) / 86400000)`, clamped to `>= 0`.
- The endpoint is internal/undocumented but stable since mid-2025, used by VS Code Copilot
  extension, Copilot CLI, and multiple third-party tools.

## Config

File: `~/.opencode-insights/config.jsonc` (existing file).

Default generated on first run (when no config exists):
```jsonc
{
  "promptRightMetrics": ["tps", "avg", "used", "cache"],
  "goUsage": {
    "enabled": false,
    "cookie": "",
    "workspaceID": "",
    "refreshMs": 300000
  },
  "copilotUsage": {
    "enabled": false,
    "token": "",
    "refreshMs": 300000
  }
}
```

- **`copilotUsage.enabled` — opt-in switch, defaults to `false`.**
- **`copilotUsage.token` — optional manual fallback.** If empty or absent, the plugin
  reads the token from `~/.local/share/opencode/auth.json` → `github-copilot.access`
  (falling back to `.refresh`). If both sources are empty, the section is hidden.
- `copilotUsage.refreshMs` — poll interval; default `300000` (5 min), clamped to `>= 60000`.
- Unknown/invalid values are ignored (same behavior as `promptRightMetrics`).

## Token resolution

Priority order:
1. `~/.local/share/opencode/auth.json` → `github-copilot.access` (or `.refresh`)
2. `copilotUsage.token` from insights config
3. Both empty → section hidden

Token is read once at startup (in `readInsightsConfig` or lazily on first fetch), not
on every refresh tick.

## Provider gate

Section only visible when the current session's provider is `"github-copilot"`.
Same pattern as Go Usage: a `createCopilotProviderTracker()` that records provider per
session, with `usesCopilot(sessionID)` check.

Tracker recording:
- On `message.updated` events where `info.providerID === "github-copilot"`.
- During `hydrateSessionMetrics` from existing message info (so the section appears
  immediately for sessions that already used Copilot before the TUI opened).

`copilotUsageSectionVisible(config, token, usesCopilot)`:
```typescript
function copilotUsageSectionVisible(
  config: InsightsConfig,
  token: string,
  usesCopilot: boolean
): boolean {
  return usesCopilot && config.copilotUsage.enabled && token.length > 0;
}
```

Visibility rule: `copilotUsage.enabled && token.length > 0 && usesCopilot(sessionID)`

The Copilot tracker and Go tracker are independent — they share no state. Both are
created in the TUI module scope and passed to their respective sidebar components.

## Module: `src/copilot-usage.ts`

Pure functions, no side effects:

- `fetchCopilotUsage(token: string, fetchImpl?): Promise<CopilotUsage>`
  - `GET https://api.github.com/copilot_internal/user`
  - Headers: `Authorization: Bearer <token>`, `Accept: application/json`.
  - 401/403 → throws `CopilotUsageError("token expired or invalid; update token in config or re-authenticate")`.
  - Non-200 → throws `CopilotUsageError("copilot API request failed with status <code>")`.
  - Malformed JSON → throws `CopilotUsageError("could not parse copilot usage response")`.
  - `fetchImpl` injectable for tests (defaults to global `fetch`).
- `copilotUsageRow(data: CopilotUsage, now: number): CopilotUsageRow | undefined`
  - Extracts `premium_interactions` from `quota_snapshots`.
  - Returns `undefined` if `unlimited: true`.
  - Computes `used = entitlement - remaining`, `percentUsed = 100 - percent_remaining`.
  - Computes `daysRemaining = ceil((resetDate - now) / 86400000)`, clamped `>= 0`.
  - Returns `{ used, total, percentUsed, daysRemaining, creditsUsed }`.
- `formatCopilotUsageRow(row: CopilotUsageRow): string`
  - Main row: `"Premium   84%  ████████░░  15d"`
  - Detail sub-row: `"          2930 / 3500"`
  - Uses same `formatUsageBar` from `go-usage.ts` (shared utility).
  - `Math.round(percentUsed)` for the percentage display (handles float `percent_remaining`).

Types:

```typescript
type CopilotUsage = {
  copilot_plan: string;
  quota_reset_date_utc: string;
  quota_snapshots: {
    premium_interactions: CopilotQuotaSnapshot;
    chat: CopilotQuotaSnapshot;
    completions: CopilotQuotaSnapshot;
    [key: string]: CopilotQuotaSnapshot;
  };
};

type CopilotQuotaSnapshot = {
  quota_id: string;
  unlimited: boolean;
  has_quota: boolean;
  entitlement: number;
  remaining: number;
  quota_remaining: number;
  percent_remaining: number;
  credits_used: number;
  overage_permitted: boolean;
  overage_count: number;
};

type CopilotUsageRow = {
  used: number;
  total: number;
  percentUsed: number;
  daysRemaining: number;
  creditsUsed: number;
};
```

Refresher follows the same pattern as `createGoUsageRefresher`: module-level state
with in-flight dedup, `refresh(now)` returning `Promise<boolean>`, error stored in
state for display.

## Data/refresh lifecycle in TUI

- Module-level `CopilotUsageState` per TUI instance: `{ data?, error?, lastFetchAt }` +
  in-flight guard (no concurrent fetches).
- Initial fetch when the section first becomes visible; refetch every `copilotUsageRefreshMs`
  (setInterval, cleared on dispose). Failed fetches keep the previous `error` state and
  retry on the next tick.
- A 1s `sync` tick recomputes `daysRemaining` from the stored `quota_reset_date_utc` and
  `Date.now()`. Unlike Go Usage (which ticks hours/minutes), Copilot days change infrequently,
  but the 1s tick is cheap and keeps the pattern consistent. The `daysRemaining` value is
  recomputed from the absolute timestamp on each tick, not accumulated.

## Overage handling

When `remaining <= 0` and `overage_permitted: true`, the user is in overage. Display:
- The progress bar fills to 100%+ (clamped by `formatUsageBar`).
- The percentage shows `>100%` (e.g. `"102%"`).
- No separate overage warning — the filled bar and high percentage communicate the state.

## TUI sidebar: `src/tui.tsx`

New `CopilotUsageSidebar` component, placed after `GoUsageSidebar` in the sidebar
column. Same collapsible-section pattern (text element + ref, subscribe/sync, createSignal
collapsed, StyledText chunks).

Visibility: per-session `usesCopilot` flag from the provider tracker, combined with
config enable + token presence.

Rendering (collapsed title + 2 rows):

```
▼ Copilot
Premium   84%  ████████░░  15d
          2930 / 3500
```

- Main row: label (padEnd 9), percentage (Math.round, padEnd 4), progress bar (10 chars),
  days remaining.
- Detail sub-row: indented to align under the bar, shows `used / total`.
- When `unlimited: true` (no premium quota), section hidden entirely.
- Error state: single muted line `Copilot: <error message>` (e.g. "Copilot: token expired
  or invalid — update token in config or re-authenticate"); section stays visible and keeps
  polling.

## Reuse from `src/go-usage.ts`

- `formatUsageBar(usagePercent, width)` — shared progress bar renderer.
- `formatReset` is NOT reused — Copilot uses absolute-date day countdown, not sec-based.

## Testing (vitest, `test/`)

- `copilot-usage.test.ts`:
  - `fetchCopilotUsage` — mocked fetchImpl: success (fixture JSON), non-200, malformed
    JSON. All throw `CopilotUsageError`.
  - `copilotUsageRow` — real fixture: extracts correct used/total/percent/days. Unlimited
    quotas return `undefined`. Edge cases: zero entitlement, past reset date (days=0).
  - `formatCopilotUsageRow` — aligns columns for 1-digit, 2-digit, 3-digit percentages.
    Rounds fractional percentUsed. Detail sub-row aligns under bar.
- Entry-point test in `test/entrypoints.test.ts` — add `CopilotUsageSidebar` identifier
  check alongside existing Go Usage checks.

## Files touched

| File | Change |
|------|--------|
| `src/capture.ts` | Add `CopilotUsageConfig` type, config parsing, defaults |
| `src/copilot-usage.ts` | New: fetch, parse, format, types |
| `src/tui.tsx` | Add `CopilotUsageSidebar` component, wire provider tracker |
| `test/copilot-usage.test.ts` | New: unit tests |
| `test/entrypoints.test.ts` | Add CopilotUsageSidebar identifier check |
| `test/fixtures/copilot-user.json` | New: API response fixture |

## Out of scope

- AI credit cost display (the `credits_used` field is shown raw, not as dollars).
- Chat/completions quota display (unlimited on all observed plans).
- Automating token retrieval — token comes from existing OpenCode auth store.
- Display in the web viewer.
