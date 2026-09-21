# Development

## Commands

- `npm run verify` — the release gate: `typecheck && test && build`.
- `npm run typecheck` — `tsc --noEmit`.
- `npm test` — `vitest run`.
- `npm run build` — tsup, ESM-only, one entry (`dist/tui.js`).

## Requirements

- Node >= 22.13.
- OpenCode V2 (`@opencode/plugin@2.x`) for manual verification.

## Manual verification

The plugin only runs inside OpenCode V2. To try a local build:

1. Build it:

   ```bash
   npm run build
   ```

2. Point OpenCode at the local build by adding its absolute `dist/tui.js` path to `~/.config/opencode/cli.json`:

   ```jsonc
   {
     "plugins": ["/absolute/path/to/opencode-insights/dist/tui.js"]
   }
   ```

3. Restart OpenCode.

4. Open a session and confirm the sidebar sections render: `Token Usage`, `Subagents`, and `Session Analysis`. `Go Usage`/`Copilot Usage` appear only when enabled in `~/.opencode-insights/config.jsonc` and the session uses the matching provider.

5. Confirm the prompt-right metrics row appears in the prompt footer.

Restore the published package by removing the local path from `cli.json` and adding `"@rejacky/opencode-insights"` back.

## Layout

- `src/tui.tsx` — the plugin entrypoint and all Solid components.
- `src/events.ts` — pure V2 event → state bridge (unit-tested).
- `src/config.ts` — `config.jsonc` parsing.
- `src/metrics.ts`, `src/activity.ts`, `src/subagents.ts`, `src/go-usage.ts`, `src/copilot-usage.ts` — pure logic.
- `src/activity-hydrate.ts` — history backfill from the V2 data API.

## Tests

Tests live in `test/**/*.test.ts` and import from `src/` directly. `test/tui.test.ts` is a source-level smoke test over `src/tui.tsx`, so renaming the identifiers it asserts on breaks it.
