# Task 3 Report: V2 Server Plugin Lifecycle

## Status

Implemented and verified on `feature/opencode-v2-migration`.

## Files

- `src/index.ts`
  - Reads `ctx.options.dataDir` and the existing insights config during setup.
  - Initializes a capture store and registers the v2 event subscriber, session hooks, and tool hooks.
  - Captures `event`, `prompt`, `context`, `model.request`, `tool.execute.before`, and `tool.execute.after` records best-effort.
  - Serializes capture writes and returns cleanup that aborts the event stream, waits for pending captures, and closes storage.
- `src/capture.ts`
  - Extends setup option typing with the v2 `cliShim` option.
- `test/plugin.test.ts`
  - Adds a test-only v2 context harness and lifecycle/capture assertions.

## Tests

Test-first sequence:

- `npm test -- test/plugin.test.ts` initially failed because setup was empty and no lifecycle registrations existed.
- `npm test -- test/plugin.test.ts` passed: 3 tests passed.
- `npm run typecheck` passed with no errors.

## Output

```text
Test Files  1 passed (1)
Tests       3 passed (3)

tsc --noEmit
completed successfully with no errors
```

## Commit

`4765c93` (`feat: register captures through OpenCode v2 hooks`).

## Concerns

- The test harness uses a temporary capture directory and inspects the resulting SQLite rows; the production capture store is intentionally not replaced with a mock.
- The `cliShim` option is accepted by the setup context type but is not used by Task 3, as required by the v2 lifecycle brief.

## Round 1 Fix

- Hook and event capture is now fire-and-forget. Writes remain serialized through one promise queue, while every append failure is swallowed and every detached promise has a rejection sink.
- Cleanup is idempotent, aborts the event controller, and closes storage without awaiting an iterator that ignores abort. Pending background writes are intentionally not awaited during shutdown so cleanup cannot block on storage or the event stream.
- Added tests for rejected storage writes, event-stream continuation after an append failure, abort-insensitive subscriber cleanup, repeated cleanup, and best-effort initialization failure.
- Initialization failures are swallowed so hook registration and event subscription remain available when storage cannot initialize; normal programming errors in setup/configuration are not broadly caught.

## Round 1 Tests and Output

- `npm test -- test/plugin.test.ts`: PASS, 7 tests passed.
- `npm run typecheck`: PASS.
- `npm run verify`: PASS, 14 test files and 179 tests passed; build completed successfully.

## Round 1 Commit

`38d20a7` (`fix: harden v2 capture lifecycle`).
