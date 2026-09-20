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
