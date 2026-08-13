# Debug / Revert Debug — Design

**Date:** 2026-08-13
**Status:** Pending review

## Problem

`npm run debug` sets up the OpenCode config files to point at the local build output.
Today `configureOpenCodeDebug` (src/cli.ts:321) replaces plugin entries via
`setSinglePluginSpec`, whose matcher `isInsightsPluginEntry` (src/cli.ts:470) only
recognizes the bare spec `@rejacky/opencode-insights`, tgz refs, the `/tui` subpath,
and local `dist/(index|tui).js` paths. It does NOT recognize version-suffixed specs
like `@rejacky/opencode-insights@latest` — the form used in real configs. Running
`debug` against such a config therefore *appends* the local path while *keeping* the
official entry, leaving two insights plugin entries.

There is also no way to switch back: once `debug` has pointed the configs at
`<repo>/dist/...`, the user must hand-edit the files to restore the official package.

## Goals

1. `debug` replaces any official insights spec (bare, `@latest`, `@<semver>`, `npm:`-prefixed)
   in the OpenCode config files with the local build path — no duplicate entries.
2. If no insights entry exists, `debug` appends the local path (unchanged behavior).
3. New `revert-debug` npm script (new `revert` CLI subcommand) swaps local dev-path
   entries back to the hardcoded official spec `@rejacky/opencode-insights@latest`.
4. Both commands preserve JSONC formatting/comments and support `--config-dir` and
   `--dry-run`.

## Approach

Extend `src/cli.ts` (single source of truth for config editing; the existing `debug`
and `uninstall` commands already live there):

- Fix the insights-entry matcher so version-suffixed and `npm:`-prefixed specs are
  recognized (this is the actual bug behind the duplicate entries).
- Keep `debug` semantics: replace all matched entries, append if none matched.
- Add a `revert` subcommand that replaces matched dev-path entries with the official
  spec; if none present, report and leave the file unchanged.

## Recognition rules

A plugin entry (string, or tuple `[spec, options]`) is an **insights entry** when its
spec matches any of:

- `@rejacky/opencode-insights` (bare)
- `@rejacky/opencode-insights@latest` or `@rejacky/opencode-insights@<semver>` (any
  version suffix on the package name)
- `npm:@rejacky/opencode-insights` and `npm:@rejacky/opencode-insights@…` variants
- `@rejacky/opencode-insights/tui` (subpath export)
- a `.tgz` reference containing `opencode-insights`
- a local path ending `/opencode-insights/dist/(index|tui).js`

For the tuple form, the options half is dropped when the entry is replaced (same as
today).

## Command behavior

### `debug` (unchanged entrypoint: `npm run build && node dist/cli.js debug`)

For each config file in turn:

- `opencode.json` / `opencode.jsonc` (existing `resolveOpenCodeConfigPath` resolution)
- `tui.json` (beside the opencode config)

Replace every matched insights entry with the local dev path — `resolve("dist/index.js")`
in the opencode config, `resolve("dist/tui.js")` in `tui.json`. If no entry matched,
append the dev path. Missing files are created with the dev path (as today).
`resolve("dist/index.js")` / `resolve("dist/tui.js")` must exist, else the command
fails with the existing "Missing dist output" error.

Unchanged incidental behavior kept for compatibility: ensures the insights
`config.jsonc` template exists (never modifies an existing one).

### `revert` (new: `node dist/cli.js revert`)

For each of `opencode.json`/`opencode.jsonc` and `tui.json`:

- File absent → report "config not found", skip (mirrors `uninstall`).
- Replace every matched **dev-path** entry (the local-path rule above) with the
  hardcoded `@rejacky/opencode-insights@latest`.
- No dev-path entry present → report "not present", leave file unchanged (not an error).
- No "Missing dist output" check — revert only edits config files; the repo build is
  not required.

Supports `--config-dir DIR` and `--dry-run`.

## npm scripts

```json
"debug": "npm run build && node dist/cli.js debug",
"revert-debug": "node dist/cli.js revert"
```

`revert-debug` needs `dist/cli.js` to run but does not rebuild.

## Docs

- `usage()` in src/cli.ts gains `opencode-insights revert [--config-dir DIR] [--dry-run]`.
- AGENTS.md command list updated (replace the `npm run debug` note with debug +
  revert-debug).

## Tests (test/cli.test.ts)

- `debug` against a config whose plugin is `["@rejacky/opencode-insights@latest"]`
  yields a single local dev-path entry (no duplicate).
- `debug` against `npm:@rejacky/opencode-insights` and a pinned `@0.2.0` spec replaces
  them (matcher coverage).
- `revert` swaps a dev-path entry back to `@rejacky/opencode-insights@latest` in both
  configs; comments preserved.
- `revert` with no dev-path entry leaves the file unchanged and reports it.
- `revert --dry-run` reports but writes nothing.
- `revert` with a missing config file skips it.

## Edge cases

- Tuple entries: `["@rejacky/opencode-insights@latest", {…}]` → replaced by the plain
  dev-path string (options dropped, as today).
- `tui.json` with a dev path from an older debug run at a different repo location —
  matched by the path pattern, not by cwd, so revert works from anywhere.
- Debug run twice: second run is a no-op replace (already dev paths) — single entry.

## Out of scope

- No state file / remembering the pre-debug spec — revert always writes
  `@rejacky/opencode-insights@latest`.
- No changes to `uninstall`, plugin runtime, or capture storage.
