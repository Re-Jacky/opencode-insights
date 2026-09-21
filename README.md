# opencode-insights

Live OpenCode TUI sidebars for token/TPS metrics, session analysis, subagent status, and provider usage.

## Compatibility

| opencode-insights   | OpenCode            | Status                                                                 |
| ------------------- | ------------------- | ---------------------------------------------------------------------- |
| **1.0.0 and above** | **V2 (`2.0.0+`)**   | Built for OpenCode V2 as a TUI-only plugin. Actively maintained.        |
| `1.0.0-alpha.N`, `1.0.0-beta.N` | **V2 (`2.0.0+`)** | Prereleases of the same V2-only line, published under the `beta` npm dist-tag. |
| `0.4.x` and below   | V1                  | Legacy server plugin. Frozen: no V2 support, no longer maintained.      |

**`1.0.0` is the first V2-only release, and every release from `1.0.0` on — prereleases included — targets OpenCode V2.**
It is built against `@opencode/plugin` v2 and loads through OpenCode's V2 CLI plugin API, so it
does not run on V1.

> **npm dist-tags.** `latest` still points at the `0.4.x` V1 line, so a bare
> `opencode plugin add @rejacky/opencode-insights` installs the V1 plugin. The V2
> prereleases live under the `beta` tag until `1.0.0` is published for real; use
> `@beta` or an exact version to try them.

- OpenCode **V2** required (`opencode` 2.0.0 or newer; developed against 2.0.11).
- Node.js **>= 22.13** to build from source. OpenCode supplies the runtime.
- Peers, bundled with OpenCode: `@opentui/core` >= 0.5.10, `@opentui/solid` >= 0.5.10, `solid-js` >= 1.9.0.

## Install

`opencode-insights` is a **TUI-only** plugin: the published package exposes one TUI
entrypoint (`./tui`) and no server entrypoint. Install it with:

```bash
opencode plugin add @rejacky/opencode-insights
```

OpenCode inspects the package, finds the TUI entrypoint, and adds it to the CLI
config, printing:

```text
TUI plugin "@rejacky/opencode-insights" installed and added to ~/.config/opencode/cli.json
```

Or add it manually:

```jsonc
// ~/.config/opencode/cli.json
{
  "plugins": ["@rejacky/opencode-insights"]
}
```

Pin an exact version with `"@rejacky/opencode-insights@<version>"`.

Then restart OpenCode (or reopen the TUI) to load the plugin.

### Try the 1.0.0 prerelease

The V2 line ships as a prerelease first, so issues surface before `latest` moves:

```bash
opencode plugin add @rejacky/opencode-insights@beta
```

Or pin the exact version:

```jsonc
// ~/.config/opencode/cli.json
{
  "plugins": ["@rejacky/opencode-insights@1.0.0-beta.1"]
}
```

Prereleases require OpenCode V2. They are published under the `beta` npm dist-tag,
so `latest` keeps resolving to the `0.4.x` V1 plugin until `1.0.0` is published for
real.

### Why `cli.json` and not `opencode.json(c)`

OpenCode V2 has two plugin lists, and this plugin belongs to the second one:

- `opencode.json(c)` → `plugins` — packages that expose a **server** entrypoint. Their TUI components are loaded automatically by the CLI.
- `cli.json` → `plugins` — CLI/TUI-only plugins. They run locally in the terminal and stay active even when the CLI is connected to a remote server.

`opencode-insights` has no server entrypoint, so `opencode plugin add` writes it to
`cli.json`. A package with no server entrypoint that is added to `opencode.json(c)`
is not loaded.

## Update

```bash
opencode plugin check    # list configured plugin packages that are outdated
opencode plugin update   # update them
```

If a version still looks stale, remove the entry from `cli.json`, restart OpenCode,
and add it again. For local development builds, install a directory path instead —
see [DEVELOPMENT.md](./DEVELOPMENT.md).

Once `1.0.0` is published, move off the prerelease by changing `@beta` (or the pinned
prerelease version) to `latest` in `cli.json` and restarting OpenCode.

## What You Get

- **Prompt metrics** on their own line directly above the composer, configurable and ordered by `promptRightMetrics`. `tps` is a live estimate over a 5s window while the model streams (reasoning deltas included, so it shows while the model is thinking); `avg` reproduces the native message header's `tok/s` — Σ(output + reasoning) over every step of the current turn ÷ Σ(step `streamed − created` spans), reset when a new turn begins; `ttft` is the time to the first token of any kind.
- **Token Usage** sidebar: session-wide totals, response count, input/output/reasoning, cache read/write, and aggregate cache rate. It hydrates completed responses already present in the session and keeps updating live.
- **Go Usage** sidebar (opt-in): OpenCode Go rolling/weekly/monthly limits, shown only when the session uses the `opencode-go` provider.
- **Copilot Usage** sidebar (opt-in): GitHub Copilot premium-interaction quota, usage bar, and days until reset, shown only when the session uses the `github-copilot` provider.
- **Subagents** sidebar: native running/done/failed status, elapsed time, token totals, and per-subagent activity. Click a row to open that subagent session.
- **Session Analysis** sidebar: aggregated tool calls, skills, auto-compactions, model requests, warnings, and the subagent tree. Click the header to open a scrollable detail dialog.

Click any section header to collapse or expand it. Prompt `used` and `cache` values reflect the latest completed assistant response; the Token Usage sidebar aggregates the whole session.

## Configuration

On startup the plugin creates a JSONC config file:

```text
~/.opencode-insights/config.jsonc
```

```jsonc
{
  "promptRightMetrics": ["tps", "avg", "used", "cache"],
  "goUsage": { "enabled": false, "cookie": "", "workspaceID": "", "refreshMs": 300000 },
  "copilotUsage": { "enabled": false, "token": "", "refreshMs": 300000 }
}
```

`promptRightMetrics` controls both the fields and their order. Supported values are `tps`, `avg`, `ttft`, `used`, `cache`, `input`, `output`, and `reasoning`. Unrecognized values are ignored; an empty or invalid list falls back to the default. Restart OpenCode after editing.

A legacy `~/.opencode-insights/config.json` is honored when `config.jsonc` does not exist.

### Go Usage

```jsonc
"goUsage": {
  "enabled": true,         // set to true to activate
  "cookie": "Fe26.2**...", // auth session cookie from opencode.ai
  "workspaceID": "wrk_...", // visible in the console URL
  "refreshMs": 300000       // poll interval (min 60000)
}
```

To get the cookie, log in to `https://opencode.ai`, open the workspace `/go` page, then copy the `auth` cookie value from your browser's DevTools (Application → Cookies → `https://opencode.ai`). The cookie lasts up to a year; if the section shows an error, copy it again.

The section reads the usage widget from that workspace's `/go` console page, so it
only shows data for a workspace with an active Go subscription.

### Copilot Usage

```jsonc
"copilotUsage": {
  "enabled": true,    // set to true to activate
  "token": "",        // optional: manual token override
  "refreshMs": 300000 // poll interval (min 60000)
}
```

The `token` field is optional. If empty, the plugin reads the token from OpenCode's auth store (`~/.local/share/opencode/auth.json` → `github-copilot.access`). No manual setup is needed if you authenticate with Copilot through OpenCode.

```text
▼ Copilot
Premium   84%  ████████░░  7d
          2942 / 3500
```

## Deprecations

### Capture, viewer, and CLI removed in 1.0.0

**The capture feature is deprecated and removed in `1.0.0`.** The V2-only release
drops the whole V1 stack:

- ❌ the local capture store (SQLite capture database) — no capture, no database;
- ❌ the `opencode-insights` command-line interface;
- ❌ the web viewer UI;
- ❌ the V1 server plugin entrypoint (the package is TUI-only now).

The plugin is stateless: it reads OpenCode's in-process V2 data API and renders TUI
sidebars. `retentionDays` and `dbPath` in `~/.opencode-insights/config.jsonc` are
V1-only keys and are ignored if present.

If you need the capture stack, stay on the `0.4.x` line with OpenCode V1.

## Privacy

This plugin stores nothing. It reads session, message, and token data from OpenCode's in-process V2 data API and renders it in the TUI. No prompts, responses, or headers are captured or persisted.
