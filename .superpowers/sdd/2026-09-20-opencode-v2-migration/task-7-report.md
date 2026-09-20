# Task 7 Report

## Status

Complete on `feature/opencode-v2-migration`.

## Changes

- Added a production-source static scan in `test/entrypoints.test.ts` rejecting v1 plugin imports, v1 TUI APIs, v1 lifecycle/navigation APIs, v1 hook contracts, legacy TUI config references, and legacy config aliases.
- Removed the legacy `config.json` fallback and resolver from `src/capture.ts`.
- Removed CLI writes and cleanup for `cli.json(c)` and `tui.json(c)`, dead TUI subpath aliases, and obsolete unsupported-flag warning code from `src/cli.ts`.
- Removed obsolete compatibility tests for legacy config and auxiliary config writers.
- Updated `README.md` to document only v2 installation, automatic TUI loading, `cli.json(c)` semantics, config/data paths, viewer commands, and unredacted capture.
- Added `DEVELOPMENT.md` with v2-only development, configuration, runtime data, CLI/viewer, and testing guidance.

## Tests And Output

- `npm test -- test/entrypoints.test.ts test/capture.test.ts test/cli.test.ts`: **34 passed** across 3 files.
- `npm test`: **172 passed** across 14 files.
- `npm run typecheck`: passed with no diagnostics.
- `npm run verify`: passed: typecheck, 172 tests, and tsup ESM build.
- `git diff --check`: passed.

## Commit

- `a47081a refactor: remove OpenCode v1 plugin surface`

## Concerns

- Two pre-existing untracked migration artifacts remain untouched: `docs/superpowers/plans/2026-09-20-opencode-v2-migration.md` and `docs/superpowers/specs/2026-09-20-opencode-v2-migration-design.md`.
- Uninstall intentionally cleans only the main `opencode.json(c)` v2 plugin array; obsolete TUI subpath entries are not treated as supported configuration and are left untouched.

## Round 1 Fix

Restored the approved migration-residue cleanup: `revert` and `uninstall` now inspect `cli.json(c)` and legacy `tui.json(c)`, remove recognized string and `{ package, options }` Insights entries, preserve unrelated entries and JSONC comments, and never insert the official package into auxiliary files. The static v1-removal scan remains focused on runtime contracts and does not reject cleanup of legacy config files.

### Round 1 Verification Output

```text
$ npm test -- test/cli.test.ts test/entrypoints.test.ts
> @rejacky/opencode-insights@0.4.1 test
> vitest run test/cli.test.ts test/entrypoints.test.ts

Test Files  2 passed (2)
Tests  18 passed (18)

$ npm run typecheck
> @rejacky/opencode-insights@0.4.1 typecheck
> tsc --noEmit

$ npm run verify
> @rejacky/opencode-insights@0.4.1 verify
> npm run typecheck && npm run test && npm run build

> @rejacky/opencode-insights@0.4.1 typecheck
> tsc --noEmit

> @rejacky/opencode-insights@0.4.1 test
> vitest run

Test Files  14 passed (14)
Tests  174 passed (174)

> @rejacky/opencode-insights@0.4.1 build
> tsup

CLI Building entry: {"index":"src/index.ts","tui":"src/tui.tsx","cli":"src/cli.ts"}
CLI Using tsconfig: tsconfig.json
CLI tsup v8.5.1
CLI Using tsup config: /Users/zyao/Desktop/opencode-insights/tsup.config.ts
CLI Target: es2022
CLI Cleaning output folder
ESM Build start
ESM dist/index.js          3.72 KB
ESM dist/tui.js            26.45 KB
ESM dist/cli.js            76.37 KB
ESM dist/chunk-23M2YYIE.js 31.38 KB
ESM dist/chunk-4GSWCCSB.js 22.81 KB
ESM Build success in 10ms
DTS Build start
DTS Build success in 1597ms
DTS dist/cli.d.ts              3.47 KB
DTS dist/index.d.ts            4.21 KB
DTS dist/tui.d.ts              301.00 B
DTS dist/capture-CQqhKpP_.d.ts 8.08 KB
```
