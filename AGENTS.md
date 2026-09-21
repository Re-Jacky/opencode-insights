# AGENTS.md

OpenCode V2 TUI plugin `@rejacky/opencode-insights` — reactive sidebar sections for live token/TPS metrics, session analysis, subagent status, and provider (Go/Copilot) usage. ESM-only; requires Node >= 22.13.

## Commands

- `npm run verify` — the release gate: `typecheck && test && build`. CI and `prepublishOnly` run this; run it before finishing any change.
- `npm run typecheck` — `tsc --noEmit` (strict + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`).
- `npm test` — `vitest run` (tests live in `test/**/*.test.ts`, `restoreMocks: true`).
- `npm run build` — tsup, ESM-only, one entry (`tui`). `@opencode/plugin`, `@opentui/*`, `solid-js` are externalized.
- No linter or formatter is configured.

## Conventions

- NodeNext ESM: all relative imports need explicit `.js` extensions (`import … from "../src/activity.js"`), including in tests. Do not use `ts`-less paths.
- Tests import from `src/` directly, never from `dist/`.
- `exactOptionalPropertyTypes` is on: optional fields are explicitly `T | undefined`, and optional JSX/object props are built with conditional spreads (`{...(cond ? { x } : {})}`) rather than passing `undefined`.
- `test/tui.test.ts` verifies TUI wiring by reading `src/tui.tsx` as text and asserting on identifiers and literals (`Plugin.define({`, `context.data.listen(`, `append: "sidebar.content"`, `context.ui.router.navigate({ type: "session", sessionID: row.id })`, …). Renaming those breaks the test.
- JSX uses `@opentui/solid` as import source (set in both tsconfig.json and tsup.config.ts).

## Architecture

- `src/tui.tsx` — the whole plugin: `Plugin.define({ id: "opencode-insights", setup })` from `@opencode/plugin/tui`. `setup` owns plain state, subscribes once with `context.data.listen`, registers the `sidebar.content` and `prompt.footer.status` slots, and returns a cleanup that unsubscribes and clears the ticker. Components are Solid reactive (`createMemo`/`createSignal`/`Show`/`For`); a shared 1s `now()` ticker drives time-based recomputation.
- `src/events.ts` — pure V2 event bridge: maps `OpenCodeEvent`s onto metrics/activity/subagents/provider state and reports which domains changed. Unit-tested with V2-shaped fixtures.
- `src/config.ts` — `~/.opencode-insights/config.jsonc` parsing (`promptRightMetrics`, `goUsage`, `copilotUsage`) and `resolveCopilotToken`.
- `src/metrics.ts` — TPS/cache metrics, `promptRightMetrics`, and session token usage rendering.
- `src/activity.ts` — session activity metrics (tool calls, skills, auto-compactions, steps) with per-metric keyed dedup; `src/activity-hydrate.ts` — history backfill via `context.data.session.list()` / `message.sync()` / `message.list()`.
- `src/subagents.ts` — subagent tracking from V2 session events (`session.created`/`renamed`/`status`/`idle`/`execution.failed`/`usage.updated`); `src/go-usage.ts` — opt-in Go usage; `src/copilot-usage.ts` — GitHub Copilot premium-interaction quota.

## Operational rules

- Plugin code is best-effort: the event handler and hydration swallow errors; never let the plugin throw or block OpenCode sessions.
- Config lives at `~/.opencode-insights/config.jsonc` (a legacy `config.json` is honored when the jsonc is absent). There is no capture store, no database, and no CLI.
- Design docs for new features live in `docs/superpowers/specs/` (e.g. the Go Usage design).

## Release

Pushing to `main` triggers `.github/workflows/publish.yml`: it runs `npm run verify`, then publishes to npm with provenance only if that version isn't already published. To release: bump `version` in package.json and push. Commit messages use `feat:`/`fix:`/`style:` prefixes; release commits are titled `Release <version>`.
