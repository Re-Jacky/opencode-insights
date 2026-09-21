# OpenCode V2 Migration (TUI-only) — Design

**Date:** 2026-09-21
**Status:** Draft (awaiting review)

## Problem

`@rejacky/opencode-insights` is built against the OpenCode **V1** plugin API and no longer
runs on V2. V1 plugin implementations do not run in V2: the entrypoint, hooks, TUI API, and
server API all changed. The local OpenCode is `v2.0.11`; `@opencode/plugin` and
`@opencode/client` are also `2.0.11`.

Rather than port every subsystem, the scope is being reduced deliberately: keep only the
**TUI features** (the ones actually used), drop the server-side capture plugin, the SQLite
store, the web viewer, and the CLI.

Goal: ship a V2-only, **CLI-only TUI plugin** that preserves the existing sidebar
functionality — token usage/TPS, Session Analysis, Subagents, Go Usage, Copilot Usage, and
the prompt-right metrics row — with no capture/storage/CLI surface.

## Verified mechanics (investigation, 2026-09-21)

Local OpenCode `v2.0.11`. V2 API facts confirmed by reading the published type definitions
(`@opencode/plugin@2.0.11`, `@opencode/client@2.0.11`, `@opencode/theme@2.0.11`):

- **Entrypoint.** A CLI plugin default-exports
  `Plugin.define({ id, setup(context) })` from `@opencode/plugin/tui`. `setup` may return a
  cleanup; registrations and slot claims are scoped to the plugin.
- **Context.** `setup` receives a `Context` with: `options`, `location`, `app`, `renderer`
  (`CliRenderer`), `client` (`OpenCodeClient`), `data`, `attention`, `theme`
  (`ResolvedTheme`), `themeMode`, `markdown`, `keymap`, `storage`, `ui`.
- **Events.** `context.data.on(type, handler)` returns an unsubscribe; `context.data.listen`
  receives every event. V2 event names/shapes differ entirely from V1 (see mapping below).
- **Session data.** `context.data.session.list()`, `.get()`, `.status(id): "idle" | "running"`,
  `.message.list(id)` / `.message.sync(id)`. `SessionInfo` carries `parentID`, `title`,
  `model: ModelRef`, `tokens: TokenUsageInfo`, `cost`, `time`.
- **Slots.** `context.ui.slot({ append: "sidebar.content", render })` and
  `append: "prompt.footer.status"`. Slot `render` receives reactive input
  (`{ sessionID }` and `{ sessionID?, mode, showDetails }` respectively).
- **Navigation/dialog.** `context.ui.router.navigate({ type: "session", sessionID })`;
  `context.ui.dialog.show(() => JSX)` + `context.ui.dialog.set({ size })` + `.clear()`.
- **Theme.** `context.theme` exposes resolved tokens: `text.base`, `text.muted`,
  `text.feedback.{error,success}.base`, `background.raised.base` (replacing V1
  `theme.current.text`, `.textMuted`, `.error`, `.success`, `.backgroundElement`).
- **Distribution.** CLI-only plugins are configured in `~/.config/opencode/cli.json`
  (`plugins` array) and remain active against remote servers. The package is exposed through
  the `./tui` export.

## Scope

### Keep

- Token Usage sidebar (session tokens, TPS/avg/ttft/prompt-right metrics, subagent totals).
- Session Analysis sidebar + dialog (tools, skills, steps, compactions, child sessions).
- Subagents sidebar (status, elapsed, tokens, hover highlight, click-through to session).
- Go Usage sidebar (opt-in, per-session provider gate).
- Copilot Usage sidebar (opt-in, per-session provider gate).
- Collapsible section headers; prompt-right metrics row.
- `~/.opencode-insights/config.jsonc` for `promptRightMetrics`, `goUsage`, `copilotUsage`.

### Remove

- Server plugin (`src/index.ts`), all capture/normalization/store code.
- SQLite + JSONL storage and the `bettersqlite3` / `sql.js` dependencies.
- `src/inspect.ts`, `src/viewer.ts` (web viewer).
- `src/cli.ts`, `src/cli-shim.ts`, the `bin` entry, `postinstall`, and every CLI command
  (`debug`, `revert`, `uninstall`, `recent`, `history`, `sessions`, `show`, `export`,
  `serve`, `open`, `doctor`, `vacuum`).
- `src/listeners.ts`, `src/render-state.ts` (obsoleted by reactive rendering).
- `dbPath` / `retentionDays` config fields.

## Architecture

### Package & entrypoint

- Version `1.0.0` (breaking: V2-only, major bump).
- Name unchanged: `@rejacky/opencode-insights`.
- `src/tui.tsx` default-exports `Plugin.define({ id: "opencode-insights", async setup(context) { … } })`.
- `package.json`:
  - `exports`: `{ "./tui": { types: "./dist/tui.d.ts", import: "./dist/tui.js" } }` only.
  - Remove `main`/`types`/`bin`/`postinstall`.
  - `dependencies`: `@opencode/plugin`, `jsonc-parser`.
  - `peerDependencies`: `@opentui/core`, `@opentui/solid`, `solid-js` (per the CLI plugin guide).
  - Keep JSX import source `@opentui/solid`.
- `tsup.config.ts`: one entry (`tui`); externalize `@opencode/plugin`, `@opencode/plugin/*`,
  `@opentui/*`, `solid-js`.
- Install surface: `~/.config/opencode/cli.json` → `plugins: ["@rejacky/opencode-insights"]`.

### File layout

| File | Action |
|------|--------|
| `src/tui.tsx` | Rewrite: V2 entrypoint + reactive JSX components |
| `src/config.ts` | New: config types, parsing, `resolveCopilotToken` (extracted from `capture.ts`) |
| `src/events.ts` | New: V2 event → state bridge |
| `src/metrics.ts` | Keep (pure, unchanged) |
| `src/activity.ts` | Keep (pure, unchanged) |
| `src/go-usage.ts` | Keep; import config types from `./config.js` |
| `src/copilot-usage.ts` | Keep; import config types from `./config.js` |
| `src/subagents.ts` | Rewrite event extractors for V2 shapes; keep render/model functions |
| `src/activity-hydrate.ts` | Rewrite to the `Data` API |
| `src/index.ts`, `src/capture.ts`, `src/inspect.ts`, `src/viewer.ts`, `src/cli.ts`, `src/cli-shim.ts`, `src/bun-sqlite.d.ts`, `src/listeners.ts`, `src/render-state.ts` | Delete |

### Reactive state model

`setup` owns plain state objects plus Solid primitives:

- Plain state (unchanged modules): `createMetricsState()`, `createActivityState()`,
  `createSubagentState(activity)`, `createGoProviderTracker()`, `createCopilotProviderTracker()`,
  `createGoUsageRefresher()`, `createCopilotUsageRefresher()`.
- `createSignal`s: one shared `now` signal ticked every 1s; per-domain revision signals
  (`metricsRev`, `subagentsRev`, `activityRev`, `goRev`, `copilotRev`) and the config/provider
  signals.
- Event handlers mutate the plain state and bump the relevant revision.
- Components consume `createMemo`s that read the revision + `now` + `context.data.session.status(id)`
  and recompute their rendered model. This replaces the V1 listener registries, per-component
  `setInterval(sync, 1000)`, `hasRenderStateChanged` dedup, and imperative `TextRenderable`
  assignment + `renderer.requestRender()`.

### Event bridge (`src/events.ts`)

Subscribe once in `setup` and translate V2 events. This mapping is the highest-risk part and
gets focused unit tests.

| V2 event | Fields used | Effect |
|----------|-------------|--------|
| `session.text.delta` | `data.sessionID`, `data.assistantMessageID`, `data.delta`, `created` | `recordAssistantDelta` (TPS/streaming) |
| `session.reasoning.delta` | as above | (optional) reasoning stream sample |
| `session.step.started` | `data.sessionID`, `data.assistantMessageID`, `data.started` | remember start time; `recordStep` |
| `session.step.ended` | `data.sessionID`, `data.assistantMessageID`, `data.tokens`, `data.finish`, `data.cost`, `created` | `recordAssistantMessage` (tokens/TPS/completion) |
| `session.usage.updated` | `data.sessionID`, `data.tokens`, `data.cost` | session + subagent token totals |
| `session.tool.input.started` | `data.sessionID`, `data.assistantMessageID`, `data.name`, `data.id` | `recordToolActivity` + `recordToolPart` (running) |
| `session.tool.called` | `data.id`, `data.input`, `data.executed` | `recordToolPart` (running) |
| `session.tool.success` / `session.tool.failed` | `data.id`, `data.content`/`data.error` | `recordToolPart` (done/error) |
| `session.compaction.started` | `data.sessionID`, `data.reason`, `id` | `recordCompaction(..., reason === "auto")` |
| `session.compaction.ended` | `data.sessionID`, `data.tokens`, `data.cost` | compaction completion/tokens |
| `session.created` | `data.sessionID`, `data.parentID`, `data.title`, `data.agent`, `data.model` | `recordChild` + provider trackers + subagent row |
| `session.renamed` | `data.sessionID`, `data.title` | title update |
| `session.status` | `data.sessionID`, `data.status.type` | subagent running/idle; prompt-right idle check |
| `session.idle` | `data.sessionID` | subagent done |
| `session.execution.failed` | `data.sessionID`, `data.error` | subagent error |

Subagent token totals are refreshed from `session.usage.updated` and `session.step.ended`
(`data.tokens`). Prompt-right idle state is read directly from
`context.data.session.status(sessionID)`, not from an event.

Provider tracking for Go/Copilot reads `ModelRef.providerID` from `session.created`
(`data.model`), `session.step.started` (`data.model`), and hydration (below).

### Hydration (`src/activity-hydrate.ts`)

Replace `client.session.list()`/`client.session.messages()` with the `Data` API:

- `context.data.session.list()` → `SessionInfo[]` (id, `parentID`, `title`).
- `context.data.session.message.sync(sessionID)` then `.message.list(sessionID)` →
  `SessionMessageInfo[]`.
- Assistant content is `SessionMessageAssistant.content: Array<Text | Reasoning | Tool>`
  (replacing V1 `parts`); tools carry `name`, `state`, `time`. Tokens/finish/timing come from
  the assistant message (`tokens`, `time.created/completed`, `finish`, `model.providerID`).

### TUI components (`src/tui.tsx`)

Declarative JSX replaces imperative `TextRenderable` mutation and line arithmetic:

- Shared `<Section title collapsed onToggle>` component: header `<text onMouseDown=…>` with a
  `▶`/`▼` indicator plus `<Show when={!collapsed()}>` for the body.
- **Subagents**: each row is its own `<box>`/`<text>` with `onMouseMove` (hover highlight) and
  `onMouseUp` → `context.ui.router.navigate({ type: "session", sessionID })`. This removes
  `getSubagentSidebarRowAtLine` and all y-coordinate math.
- **Session Analysis**: sidebar header click →
  `context.ui.dialog.show(() => <SessionAnalysisDialog …/>)` + `context.ui.dialog.set({ size: "large" })`;
  each section header toggles via `onMouseUp`.
- **Slots**: one claim `append: "sidebar.content"` rendering the five sections in the current
  order (Session Analysis, Token Usage, Go Usage, Copilot, Subagents); one claim
  `append: "prompt.footer.status"` for prompt-right metrics (hide in `mode === "shell"`).
- **Theme**: read `context.theme` tokens; keep the existing pure format functions
  (`formatGoUsageRow`, `formatCopilotUsageRow`, `renderPromptRightMetricsText`,
  `formatActivityBriefRows`, `getSubagentSidebarModel`, `renderSessionTokenUsage`) as the text
  sources.
- **Usage refreshers**: trigger `refresh()` from a `createEffect` on section visibility plus
  the shared 1s tick, instead of during render.

### Config (`src/config.ts`)

Keep `~/.opencode-insights/config.jsonc` (existing user configs and secrets keep working).
Shape: `{ promptRightMetrics, goUsage, copilotUsage }`. Drop `dbPath`/`retentionDays`. Read
with `jsonc-parser`. Keep an optional `dataDir` plugin option to point at an alternate config
directory (used by tests). `resolveCopilotToken` stays file-based
(`~/.local/share/opencode/auth.json` → `github-copilot.access`/`.refresh`) with the explicit
`copilotUsage.token` fallback.

## Testing (vitest)

- **Delete:** `test/cli.test.ts`, `test/cli-shim.test.ts`, `test/viewer.test.ts`,
  `test/inspect.test.ts`, `test/capture.test.ts`, `test/plugin.test.ts`,
  `test/entrypoints.test.ts`, current `test/tui.test.ts`.
- **Keep:** `test/metrics.test.ts`, `test/activity.test.ts`, `test/go-usage.test.ts`,
  `test/copilot-usage.test.ts`.
- **Rewrite:** `test/subagents.test.ts`, `test/activity-hydrate.test.ts` against V2 shapes / the
  `Data` API.
- **Add:** `test/events.test.ts` (V2 event → state bridge, one case per row of the mapping
  table), `test/config.test.ts`, and a minimal entrypoint test asserting the `Plugin.define`
  id and cleanup behavior.

The release gate stays `npm run verify` (`typecheck && test && build`).

## Docs & release

- Update `README.md`, `DEVELOPMENT.md`, `AGENTS.md`: drop capture/viewer/CLI, document
  `cli.json` installation, the V2 reactive architecture, and the new command set.
- Bump `version` to `1.0.0`. `.github/workflows/publish.yml` is unchanged.

## Risks / verification items

1. **Copilot token discovery** — V2 may have moved `~/.local/share/opencode/auth.json`.
   Fall back to explicit `copilotUsage.token`; if the file is gone, consider the client
   integration API.
2. **`context.theme` reactivity** — the `Context` type exposes `theme` as a plain property; if
   it is not a getter, theme switches may not re-render until reload. Verify; read via
   `usePlugin()` inside components if needed.
3. **`@opencode/plugin` as dependency vs peerDependency** — the CLI plugin guide's publish
   example uses `dependencies`; confirm runtime resolution for a CLI-only package.
4. **Single `sidebar.content` claim stacking five sections** — verify rendering; fall back to
   five separate `append` claims if composition misbehaves.
5. **Go Usage HTML scraping** — opencode.ai console markup may change independently of this
   migration (out of scope, unchanged).

## Non-goals

- No server plugin, no capture/storage, no web viewer, no CLI.
- No V1 compatibility shim; V1 users stay on `0.4.x`.
- No new TUI features beyond parity with the listed sidebars/dialog/prompt-right row.
