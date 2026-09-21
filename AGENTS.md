# AGENTS.md

OpenCode V2 TUI plugin `@rejacky/opencode-insights` — reactive sidebar sections for live token/TPS metrics, session analysis, subagent status, and provider (Go/Copilot) usage. ESM-only; requires Node >= 22.13.

## Commands

- `npm run verify` — the release gate: `typecheck && test && build`. CI and `prepublishOnly` run this; run it before finishing any change.
- `npm run typecheck` — `tsc --noEmit` (strict + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`).
- `npm test` — `vitest run` (tests live in `test/**/*.test.ts`, `restoreMocks: true`).
- `npm run build` — tsup, ESM-only, one entry (`tui`). `@opencode/plugin`, `@opentui/*`, `solid-js` are externalized.
- `npm run debug` — builds, then points this repo's `dev/` plugin directory into `plugins` in `~/.config/opencode/cli.json` (dev only, `scripts/` and `dev/` are not published); `npm run revert-debug` restores `@rejacky/opencode-insights@latest`. Both accept `--dry-run` and `--config <path>`. This is a TUI-only plugin, so `cli.json` is its install target, not `opencode.json(c)`.
- No linter or formatter is configured.

## Conventions

- NodeNext ESM: all relative imports need explicit `.js` extensions (`import … from "../src/activity.js"`), including in tests. Do not use `ts`-less paths.
- Tests import from `src/` directly, never from `dist/`.
- `exactOptionalPropertyTypes` is on: optional fields are explicitly `T | undefined`, and optional JSX/object props are built with conditional spreads (`{...(cond ? { x } : {})}`) rather than passing `undefined`.
- `test/tui.test.ts` verifies TUI wiring by reading `src/tui.tsx` as text and asserting on identifiers and literals (`Plugin.define({`, `context.data.listen(`, `prepend: "sidebar.content"`, `context.ui.router.navigate({ type: "session", sessionID: row.id })`, …). Renaming those breaks the test.
- JSX is compiled by `babel-preset-solid` (`generate: "universal"`, module `@opentui/solid`) via `scripts/solid-jsx.js`, wired into `tsup.config.ts` as an esbuild `onLoad` plugin. Do **not** switch back to esbuild's JSX runtime: esbuild emits plain prop values, and Solid reads a plain prop once — every `Show`/`For`/`when`/`each`/dynamic prop then freezes (collapsing headers, hover, live metrics all stop updating). `babel-preset-solid` emits accessor getters, which is what the runtime tracks. `test/solid-jsx.test.ts` guards this. `jsxImportSource` in tsconfig.json only serves the `jsx: "preserve"` typecheck.
- The runtime applies the same Solid transform to `.tsx` plugin sources and rewrites bare `solid-js`/`@opentui/solid` to its own bundled client builds; keep those imports bare so the host can rewrite them.

## Architecture

- `src/tui.tsx` — the whole plugin: `Plugin.define({ id: "opencode-insights", setup })` from `@opencode/plugin/tui`. `setup` owns plain state, subscribes once with `context.data.listen`, registers the `sidebar.content` (prepended, so the block sits above the native `Context`/`MCP` sections) and `session.composer.top` slots, and returns a cleanup that unsubscribes and clears the ticker. Components are Solid reactive (`createMemo`/`createSignal`/`Show`/`For`); a shared 1s `now()` ticker drives time-based recomputation.
- `src/events.ts` — pure V2 event bridge: maps `OpenCodeEvent`s onto metrics/activity/provider state and reports which domains changed (subagents are flagged for a native re-read, never derived). Unit-tested with V2-shaped fixtures.
- `src/config.ts` — `~/.opencode-insights/config.jsonc` parsing (`promptRightMetrics`, `goUsage`, `copilotUsage`) and `resolveCopilotToken`.
- `src/metrics.ts` — TPS/cache metrics, `promptRightMetrics`, and session token usage rendering.
- `src/activity.ts` — session activity metrics (tool calls, skills, auto-compactions, steps) with per-metric keyed dedup; `src/activity-hydrate.ts` — history backfill via `context.data.session.list()` and the client's paged `message.list()` (`listAllMessages`). The host's `message.sync()` window is only the newest 20 messages, so session totals page the full history and fall back to that window only when paging is unavailable.
- `src/subagents.ts` — subagent rows built from the host's native session store (`data.session.list()` + `status()`, `SessionInfo.outcome`/`time`/`tokens`); `session.execution.*` events only flag a re-read, so nothing here derives status from the event stream. `src/go-usage.ts` — opt-in Go usage; `src/copilot-usage.ts` — GitHub Copilot premium-interaction quota.

## Operational rules

- Plugin code is best-effort: the event handler and hydration swallow errors; never let the plugin throw or block OpenCode sessions.
- Config lives at `~/.opencode-insights/config.jsonc` (a legacy `config.json` is honored when the jsonc is absent). There is no capture store, no database, and no CLI.
- Design docs for new features live in `docs/superpowers/specs/` (e.g. the Go Usage design).

## Release

Pushing to `master` (or `main`) triggers `.github/workflows/publish.yml`: it runs `npm run verify`, then publishes to npm with provenance only if that version isn't already published. To release: bump `version` in package.json and push. Commit messages use `feat:`/`fix:`/`style:` prefixes; release commits are titled `Release <version>`.

Prerelease versions publish under their prerelease identifier as the npm dist-tag (`1.0.0-beta.1` → `beta`), so `latest` keeps pointing at the newest stable release; the workflow derives the tag from the version and marks the GitHub release as a prerelease.
