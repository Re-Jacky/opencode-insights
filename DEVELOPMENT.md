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

1. Deploy the local build into your OpenCode plugin list:

   ```bash
   npm run debug
   ```

   This builds, then adds this repository's absolute path to `plugins` in
   `~/.config/opencode/opencode.jsonc` (backing the file up to `opencode.jsonc.bak`
   and preserving comments). Preview without writing with
   `npm run debug -- --dry-run`. Point it at another config with
   `npm run debug -- --config /path/to/opencode.jsonc`.

2. Restart OpenCode.

3. Open a session and confirm the sidebar sections render: `Token Usage`, `Subagents`, and `Session Analysis`. `Go Usage`/`Copilot Usage` appear only when enabled in `~/.opencode-insights/config.jsonc` and the session uses the matching provider. Confirm the prompt-right metrics row appears in the prompt footer.

4. When you are done, restore the published package:

   ```bash
   npm run revert-debug
   ```

   This removes the local path and adds `@rejacky/opencode-insights@latest`.

If V2 refuses the local folder, the fallback is a local plugin file: create
`~/.config/opencode/plugins/opencode-insights-dev.ts` containing
`export { default } from "/absolute/path/to/opencode-insights/dist/tui.js";`
and remove the local entry from `opencode.jsonc`.

## Layout

- `src/tui.tsx` — the plugin entrypoint and all Solid components.
- `src/events.ts` — pure V2 event → state bridge (unit-tested).
- `src/config.ts` — `config.jsonc` parsing.
- `src/metrics.ts`, `src/activity.ts`, `src/subagents.ts`, `src/go-usage.ts`, `src/copilot-usage.ts` — pure logic.
- `src/activity-hydrate.ts` — history backfill from the V2 data API.

## Tests

Tests live in `test/**/*.test.ts` and import from `src/` directly. `test/tui.test.ts` is a source-level smoke test over `src/tui.tsx`, so renaming the identifiers it asserts on breaks it.
