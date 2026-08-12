# AGENTS.md

OpenCode plugin `@rejacky/opencode-insights` — local, unredacted capture of OpenCode hook/event data with a TUI sidebar (TPS, token usage, subagents), a web viewer, and a CLI. ESM-only; requires Node >= 22.13.

## Commands

- `npm run verify` — the release gate: `typecheck && test && build`. CI and `prepublishOnly` run this; run it before finishing any change.
- `npm run typecheck` — `tsc --noEmit` (strict + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`).
- `npm test` — `vitest run` (tests live in `test/**/*.test.ts`, `restoreMocks: true`).
- `npm run build` — tsup, ESM-only, three entries (`index`, `tui`, `cli`). `@opencode-ai/plugin`, `@opentui/*`, `solid-js` are externalized.
- `npm run debug` — builds then runs `node dist/cli.js debug`; requires a build first.
- No linter or formatter is configured.
- `postinstall` runs `npm rebuild better-sqlite3` (native module). `prepack` runs the build.

## Conventions

- NodeNext ESM: all relative imports need explicit `.js` extensions (`import … from "../src/index.js"`), including in tests. Do not use `ts`-less paths.
- Tests import from `src/` directly, never from `dist/`.
- `exactOptionalPropertyTypes` is on: optional fields are explicitly `T | undefined`, and records are built with `compactUndefined()` in capture.ts to strip `undefined` keys before storage.
- `test/entrypoints.test.ts` verifies TUI behavior by reading `src/tui.tsx` as text and asserting on identifiers (function names, string literals like `api.route.navigate("session", …)`). Renaming those breaks the test.
- JSX uses `@opentui/solid` as import source (set in both tsconfig.json and tsup.config.ts).

## Architecture

- `src/index.ts` — server plugin entrypoint. Default export is `{ id, server }` only; `tui` is a separate named export that lazy-imports `./tui.js`. Do NOT put `tui` in the default export — a test enforces it. `id` is `"opencode-insights"`.
- `src/tui.tsx` — TUI plugin with its own `id = "opencode-insights-tui"` (SolidJS + @opentui). Sidebar sections: Token Usage, Go Usage, Subagents, Session Analysis; collapsible via section-header click.
- `src/capture.ts` — normalizes every hook payload (`chat.*`, `event`, `tool.execute.*`) into a `CaptureRecord` and persists via `SqliteCaptureStore`. SQLite (better-sqlite3, lazily `import()`ed) with fallback to a `.jsonl` append store when unavailable. `openDatabase` tries better-sqlite3 then sql.js.
- `src/inspect.ts` — reconstructs sessions from raw captures; `src/metrics.ts` — TPS/cache metrics and `promptRightMetrics`; `src/subagents.ts` — subagent tracking; `src/go-usage.ts` — opt-in Go usage fetch from opencode.ai (cookie + workspaceID); `src/viewer.ts` — local web viewer server; `src/cli.ts` + `src/cli-shim.ts` — CLI and the `~/.local/bin` shim.
- `src/activity.ts` — session activity metrics (tool calls, skills, auto-compactions, steps) with per-metric keyed dedup; `src/activity-hydrate.ts` — history backfill via `session.list()`/`session.messages()`.
- `src/listeners.ts` / `src/render-state.ts` — tiny shared helpers for listener registries and state.

## Operational rules

- Plugin hooks are best-effort: capture and store failures are swallowed; never let the plugin throw or block OpenCode sessions.
- Storage defaults to `~/.opencode-insights/insights.sqlite` with `config.jsonc` beside it; `dbPath`/`retentionDays` are read from the config file (a legacy `config.json` is honored when the jsonc is absent). One day of retention by default.
- Privacy model is intentional: nothing is redacted — captured data can include prompts, API keys, headers, and reasoning.
- Design docs for new features live in `docs/superpowers/specs/` (e.g. the Go Usage design).

## Release

Pushing to `main` triggers `.github/workflows/publish.yml`: it runs `npm run verify`, then publishes to npm with provenance only if that version isn't already published. To release: bump `version` in package.json and push. Commit messages use `feat:`/`fix:`/`style:` prefixes; release commits are titled `Release <version>`.
