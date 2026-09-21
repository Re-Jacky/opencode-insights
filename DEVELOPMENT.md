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

   This builds, then adds this repository's `dev/` plugin directory to `plugins`
   in `~/.config/opencode/cli.json` (backing the file up to `cli.json.bak` and
   preserving formatting). Preview without writing with
   `npm run debug -- --dry-run`. Point it at another config with
   `npm run debug -- --config /path/to/cli.json`.

   Why `cli.json` and `dev/`: this is a TUI-only plugin, and OpenCode V2 loads
   TUI-only plugins from the CLI config (`opencode plugin add` routes a package
   with a `tui` entrypoint but no server entrypoint here). A plugin directory in
   `opencode.json(c)` `plugins` is dropped unless it exposes a `server`/`index`
   entrypoint. `dev/tui.ts` re-exports `dist/tui.js`, so `dev/` mirrors the
   published package's layout.

2. Restart OpenCode.

3. Open a session and confirm the sidebar sections render: `Token Usage`, `Subagents`, and `Session Analysis`. `Go Usage`/`Copilot Usage` appear only when enabled in `~/.opencode-insights/config.jsonc` and the session uses the matching provider. Confirm the prompt-right metrics row appears in the prompt footer.

4. When you are done, restore the published package:

   ```bash
   npm run revert-debug
   ```

   This removes the local path and adds `@rejacky/opencode-insights@latest`.

## Layout

- `src/tui.tsx` — the plugin entrypoint and all Solid components.
- `dev/` — dev-only plugin directory for `npm run debug`; `tui.ts` re-exports `dist/tui.js`. Not published.
- `src/events.ts` — pure V2 event → state bridge (unit-tested).
- `src/config.ts` — `config.jsonc` parsing.
- `src/metrics.ts`, `src/activity.ts`, `src/subagents.ts`, `src/go-usage.ts`, `src/copilot-usage.ts` — pure logic.
- `src/activity-hydrate.ts` — history backfill from the V2 data API.

## Tests

Tests live in `test/**/*.test.ts` and import from `src/` directly. `test/tui.test.ts` is a source-level smoke test over `src/tui.tsx`, so renaming the identifiers it asserts on breaks it.
