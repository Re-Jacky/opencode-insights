# Final Fix Wave Report

## Findings Addressed

- Reworked `src/inspect.ts` and event identifier extraction for published OpenCode v2 envelopes: top-level `type`, `id`, `created`, and `data` now drive session metadata, assistant/user messages, text/reasoning/tool parts, timestamps, and identifiers. SQL viewer filtering uses the same v2 paths.
- Reworked viewer request detail rendering to display `payload.event`, `request.context`, and `request.modelRequest` with full-fidelity context, system/messages/options, headers/body/options, and raw payloads. Removed legacy input/output and transform/header-hook labels.
- Made server capture shutdown stateful: cleanup stops new captures, waits for accepted serialized appends, then closes storage. Hook and event callbacks remain non-blocking and best-effort.
- Added Solid `onCleanup` disposal for PromptRight, SessionAnalysis, TokenUsage, Subagents, and Sidebar subscriptions. Repeated real Solid-owner slot rendering is covered by the runtime harness.
- Added a queued-write cleanup regression and v2 envelope fixtures for inspection, viewer, capture, and plugin lifecycle tests.

## Verification

```text
npm test -- test/entrypoints.test.ts test/plugin.test.ts test/inspect.test.ts test/viewer.test.ts
Test Files  4 passed (4)
Tests       27 passed (27)

npm run typecheck
tsc --noEmit

npm run verify
PASS: typecheck, 14 test files, 176 tests, and tsup ESM/declaration build
```

`git diff --check` passed.

## Commit

Recorded after the fix-wave commit.

## Concerns

- OpenTUI native rendering remains unavailable in this Node test environment; the lifecycle harness validates component ownership and observes the expected renderer boundary.
- The approved migration spec and plan remain untracked working-tree artifacts and were not included in the fix-wave commit.

## Final Review Fix

- Retained the `Subagents` listener unsubscribe and registered it with Solid `onCleanup`.
- Strengthened repeated Solid-owner slot renders to assert stable `metrics`, `activity`, `subagents`, `go`, and `copilot` listener counts, zero counts after each owner disposal, zero counts after plugin cleanup, and idempotent cleanup.

## Final-Fix Verification

```text
npm test -- test/tui.test.ts test/entrypoints.test.ts test/plugin.test.ts
> @rejacky/opencode-insights@0.4.1 test
> vitest run test/tui.test.ts test/entrypoints.test.ts test/plugin.test.ts

 RUN  v4.1.10 /Users/zyao/Desktop/opencode-insights

 Test Files  3 passed (3)
 Tests       20 passed (20)

npm run typecheck
> @rejacky/opencode-insights@0.4.1 typecheck
> tsc --noEmit

npm run verify
> @rejacky/opencode-insights@0.4.1 verify
> npm run typecheck && npm run test && npm run build

> @rejacky/opencode-insights@0.4.1 typecheck
> tsc --noEmit

> @rejacky/opencode-insights@0.4.1 test
> vitest run

 RUN  v4.1.10 /Users/zyao/Desktop/opencode-insights

Test Files  3 passed (3)
Tests       20 passed (20)
 Test Files  14 passed (14)
 Tests       176 passed (176)
> @rejacky/opencode-insights@0.4.1 build
> tsup
CLI Building entry: {"index":"src/index.ts","tui":"src/tui.tsx","cli":"src/cli.ts"}
CLI Using tsconfig: tsconfig.json
CLI tsup v8.5.1
CLI Using tsup config: /Users/zyao/Desktop/opencode-insights/tsup.config.ts
CLI Target: es2022
CLI Cleaning output folder
ESM Build start
ESM dist/index.js          3.84 KB
ESM dist/tui.js            27.01 KB
ESM dist/chunk-4GSWCCSB.js 22.81 KB
ESM dist/chunk-CNNYQGRZ.js 31.43 KB
ESM dist/cli.js            75.06 KB
ESM ⚡️ Build success in 10ms
DTS Build start
DTS ⚡️ Build success in 1647ms
DTS dist/cli.d.ts              3.47 KB
DTS dist/index.d.ts            4.21 KB
DTS dist/tui.d.ts              301.00 B
DTS dist/capture-CQqhKpP_.d.ts 8.08 KB
git diff --check
passed
```
