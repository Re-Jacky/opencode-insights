# Storage Config in config.jsonc — Design

**Date:** 2026-08-10
**Status:** Approved (design presented to user 2026-08-10, user confirmed)

## Problem

`dbPath` and `retentionDays` are currently plugin params configured in `opencode.json` /
`opencode.jsonc` (the `["@rejacky/opencode-insights", { "dbPath": …, "retentionDays": … }]`
entry). Storage settings belong with the rest of the plugin's configuration — the existing
`~/.opencode-insights/config.json` (holds `promptRightMetrics`, `goUsage`) — so there is a
single source of truth for how the plugin stores data.

Additionally, the config file moves from `.json` to `.jsonc` so users can comment out
properties they don't want (e.g. leave `dbPath` commented to use the default).

## Goals

1. `dbPath` + `retentionDays` are read from the config file — the only source.
2. Config file is `config.jsonc`; parsing supports comments and trailing commas.
3. Legacy `config.json` files keep working (fallback read).
4. CLI `--db`, `--data-dir`, `--retention-days` flags removed — no overrides.
5. First-run setup creates `config.jsonc` with `dbPath` commented out and
   `retentionDays: 1` (the default).

## Config file

Primary path: `~/.opencode-insights/config.jsonc` (i.e. `join(dataDir, "config.jsonc")`
where `dataDir` defaults to `~/.opencode-insights/`).

Legacy path: `~/.opencode-insights/config.json` — read as a fallback when `config.jsonc`
does not exist.

Resolution order in `readInsightsConfig`:

1. `config.jsonc` exists → parse it (jsonc).
2. Else `config.json` exists → parse it (jsonc parser handles strict JSON too).
3. Else → write the default `config.jsonc`, return defaults.

Schema (all keys optional except where noted):

```jsonc
{
  // Database file. Default: ~/.opencode-insights/insights.sqlite
  // "dbPath": "/absolute/path/to/insights.sqlite",
  "retentionDays": 1,
  "promptRightMetrics": ["tps", "avg", "ttft", "used", "cache", "input", "output", "reasoning"],
  "goUsage": { "enabled": false, "cookie": "", "workspaceID": "", "refreshMs": 300000 }
}
```

- `dbPath` — absolute path to the SQLite database. Shipped commented out in the
  first-run default file; uncomment + edit to relocate. Absent/commented → default
  `~/.opencode-insights/insights.sqlite` (derived from `defaultDataDir()`).
- `retentionDays` — days of captures to keep; absent → `1`; `0` disables auto-cleaning.
  Validation matches current `resolveRetentionDays` (non-finite or negative → default).
- `promptRightMetrics`, `goUsage` — unchanged behavior.
- Unknown/invalid values ignored (same as today).

## Module: `src/capture.ts`

- `InsightsConfig` gains optional `dbPath: string` and `retentionDays: number`; the
  internal `insightsConfigFrom` parses them.
- `resolveInsightsConfigPath(options)` → `join(dataDir, "config.jsonc")` — derived from
  the data dir only, no longer from `dirname(dbPath)`. `dataDir` = `options.dataDir ??
  defaultDataDir()`.
- New `resolveLegacyInsightsConfigPath(options)` → `join(dataDir, "config.json")`.
- `readInsightsConfig(options)` implements the 3-step resolution above; parses with
  `jsonc-parser` (`parse`, already a dependency used by `src/cli.ts`).
- New `defaultInsightsConfigJsonc()` — the commented template above (written on first
  run).
- New `insightsOptionsFromConfig(config, dataDir)` → `InsightsOptions` with only the
  defined keys (`dbPath`, `retentionDays`, `dataDir`; `undefined` keys stripped —
  `exactOptionalPropertyTypes`).
- `resolveCapturePath`, `createCaptureStore`, `resolveRetentionDays` signatures
  unchanged. `InsightsOptions` keeps `dbPath`/`dataDir`/`retentionDays` as internal
  plumbing types (values now always sourced from config).

## Plugin entrypoint: `src/index.ts`

- `OpenCodeInsightsOptions` narrows to `{ cliShim?: boolean; dataDir?: string }`.
  `dataDir` remains a param only to locate the config file (and for test isolation);
  it cannot live in the config itself.
- Startup: `const config = await readInsightsConfig(options)` →
  `createCaptureStore(insightsOptionsFromConfig(config, options.dataDir))`.
- Old `{ dbPath, retentionDays }` plugin params in existing `opencode.json` files are
  silently ignored (documented in README).

## CLI: `src/cli.ts`

- Remove `--db`, `--data-dir`, `--retention-days` flags and the corresponding
  `CliOptions` fields. `--config-dir` stays (locates opencode.json for
  `uninstall`/`debug`).
- `main` reads the config once (`readInsightsConfig()` at the default data dir) and
  threads the resolved `dbPath` into options so every command
  (`recent`/`history`/`sessions`/`show`/`export`/`serve`/`open`/`doctor`/`vacuum`/
  `uninstall`) resolves the configured database. `retentionDays` is not consumed by any
  read command.
- `debug` command: writes `dbPath` (uncommented) and `retentionDays` into
  `config.jsonc` using jsonc-parser `modify`/`applyEdits` (preserves user comments);
  the opencode.json plugin entry becomes a plain string (no params block).
  `debugServerOptions` removed.

## Viewer / TUI

- `src/viewer.ts` and `src/inspect.ts` unchanged — they receive options with `dbPath`
  already resolved by the caller.
- `src/tui.tsx` already calls `readInsightsConfig(options ?? {})` — unchanged; the
  config location is now data-dir-based.

## Testing

- `test/capture.test.ts`:
  - First run creates `config.jsonc` (not `.json`) with `dbPath` commented and
    `retentionDays: 1`; parse of that file yields defaults.
  - Legacy `config.json` is read when `config.jsonc` is absent.
  - `config.jsonc` wins when both exist.
  - `dbPath`/`retentionDays` from config drive `createCaptureStore` resolution.
- `test/plugin.test.ts`: plugin started with `{ dataDir, cliShim: false }`; new test —
  config.jsonc with `dbPath` in a temp data dir directs storage there.
- `test/cli.test.ts`: `parseOptions` no longer exposes `dbPath`/`dataDir`/
  `retentionDays`; `debug` writes `config.jsonc` (with comments preserved) and the
  opencode.json plugin entry has no params; `uninstall` resolves the DB from config.
- `test/viewer.test.ts`, `test/inspect.test.ts`: unchanged (they pass explicit
  `dbPath`).

## Docs

- `README.md` Storage section: replace the opencode.json params example with the
  `config.jsonc` example; document the commented-`dbPath` first-run file and that old
  plugin params are ignored.
- `AGENTS.md`: update the operational-rule line (`config.json` → `config.jsonc`; storage
  settings are config-file-based).
