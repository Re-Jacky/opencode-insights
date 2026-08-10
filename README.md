# opencode-insights

Local OpenCode observability for live TPS, subagent status, and full-fidelity request/session inspection.

## Install

Install globally with OpenCode's plugin manager:

```bash
opencode plugin @rejacky/opencode-insights --global
```

Restart OpenCode after installing the plugin.

On startup, the plugin creates a user-local `opencode-insights` command shim in:

```text
~/.local/bin
```

Make sure that directory is on your `PATH`, then run the CLI directly:

```bash
opencode-insights doctor
```

## Update

`opencode plugin` does not re-install or upgrade already-cached packages. To update to the latest version, clear the cached copy and reinstall:

```bash
rm -rf ~/.cache/opencode/packages/node_modules/@rejacky/opencode-insights
opencode plugin @rejacky/opencode-insights --global
```

Then restart OpenCode.

You can also run the latest published version directly via `npx` without reinstalling:

```bash
npx -y -p @rejacky/opencode-insights opencode-insights doctor
```

## Preview

![opencode-insights TUI](assets/tui.png)

Inspect captured sessions with the web viewer:

```bash
opencode-insights open
```

OpenCode Insights viewer listening at http://127.0.0.1:8765

![opencode-insights web viewer](assets/insights.png)

## Uninstall

Remove this plugin from `opencode.json` / `opencode.jsonc`, remove it from `tui.json`, and delete the local Insights database files:

```bash
opencode-insights uninstall
```

Preview the cleanup without changing files:

```bash
opencode-insights uninstall --dry-run
```

Keep captured data while removing only the plugin config entries:

```bash
opencode-insights uninstall --keep-data
```

Use a custom OpenCode config directory or data location:

```bash
opencode-insights uninstall --config-dir ~/.config/opencode --data-dir ~/.opencode-insights
```

After uninstalling, restart OpenCode. Packages installed with `opencode plugin ... --global` are stored under OpenCode's package cache. On macOS/Linux this is typically:

```text
~/.cache/opencode/packages
```

The `uninstall` command removes plugin config entries and local Insights data; it does not remove cached OpenCode package directories automatically.

## What You Get

- Configurable live metrics in the OpenCode session prompt zone.
- A collapsible session-wide `Token Usage` sidebar showing total tokens, response count, input/output/reasoning usage, cache read/write usage, and aggregate cache rate. It loads completed responses already present in the session and continues updating live.
- An opt-in `Go Usage` sidebar showing OpenCode Go rolling/weekly/monthly usage limits for sessions that use the `opencode-go` provider.
- Subagent status (running, done, failed, elapsed time, and token/context usage) in the sidebar.
- Local capture of OpenCode hook/event data without redaction.
- A local web viewer for reconstructed sessions, user turns, hidden request context, system/messages transforms, and assistant thinking/response sequences.
- Native OpenCode footer components (project directory and version) remain visible — the plugin does not override `sidebar_footer` or `home_prompt_right` slots.

The right sidebar contains the plugin sections: `Token Usage`, `Go Usage` (when enabled and the session uses `opencode-go`), and `Subagents`. Click any section header to collapse or expand it. Token usage is aggregated across the full session; prompt-right `used` and `cache` values continue to represent the latest completed assistant response.

## TUI Metrics Configuration

On TUI startup, Insights creates a configuration file beside its database:

```text
~/.opencode-insights/config.json
```

With a custom database path, the configuration file is created in that database's directory. The default keeps the prompt-right display compact:

```json
{
  "promptRightMetrics": ["tps", "avg", "used", "cache"]
}
```

`promptRightMetrics` controls both the fields and their order. Supported values are `tps`, `avg`, `ttft`, `used`, `cache`, `input`, `output`, and `reasoning`. Values that are not recognized are ignored; an empty or invalid configuration uses the default. Restart OpenCode after editing this file.

## Go Usage Configuration

The `Go Usage` sidebar shows the rolling (5 hour), weekly, and monthly usage limits of your OpenCode Go subscription for sessions that use the `opencode-go` provider. It is disabled by default and opt-in:

```json
{
  "goUsage": {
    "enabled": true,
    "cookie": "Fe26.2**...",
    "workspaceID": "wrk_...",
    "refreshMs": 300000
  }
}
```

- `enabled` — set to `true` to activate the section. Defaults to `false`.
- `cookie` — the `auth` session cookie for `opencode.ai` (see below).
- `workspaceID` — your workspace id, visible in the console URL (`/workspace/<workspaceID>/go`).
- `refreshMs` — how often to re-fetch usage from the console. Defaults to `300000` (5 minutes); values below 60000 are clamped.

To get the cookie, log in to `https://opencode.ai`, open the workspace `/go` page, then copy the `auth` cookie value from your browser's DevTools (Application → Cookies → `https://opencode.ai`). The cookie lasts up to a year; if the section shows an error, copy it again. Restart OpenCode after editing this file.

## Open The Viewer

Start the local web viewer and open it in your browser:

```bash
opencode-insights open --limit 5000 --port 8765
```

Or run the server only:

```bash
opencode-insights serve --limit 5000 --port 8765
```

Then open:

```text
http://127.0.0.1:8765/
```

The viewer shows:

- Project/session filters with subagent sessions nested under their parent session.
- User-message rows only, with each row showing visible assistant steps and hidden context count.
- A `Summary` view with the agent thinking/response sequence.
- Collapsed hidden-context previews that expand to plain text system prompt or hidden prompt-like content.
- A dark/light theme switcher.

## Common Commands

List recent raw captures:

```bash
opencode-insights recent --limit 20
```

List reconstructed sessions:

```bash
opencode-insights sessions --limit 5000
```

Print one reconstructed session:

```bash
opencode-insights show ses_xxx --limit 10000
```

Export one session to JSON:

```bash
opencode-insights export ses_xxx --limit 10000 --output ./session.json
```

Check DB path, table health, row counts, and SQLite readability:

```bash
opencode-insights doctor
```

Compact the local SQLite DB after heavy testing:

```bash
opencode-insights vacuum
```

Remove plugin config entries and delete local captured data:

```bash
opencode-insights uninstall
```

If the command is not available, confirm `~/.local/bin` is on `PATH`, or run the installed binary directly from OpenCode's package cache:

```bash
~/.cache/opencode/packages/node_modules/.bin/opencode-insights doctor
```

You can also run the published package through npm without relying on the OpenCode cache:

```bash
npx -y -p @rejacky/opencode-insights opencode-insights doctor
```

## Storage

Default database path:

```text
~/.opencode-insights/insights.sqlite
```

If SQLite is unavailable in the plugin runtime, the fallback path is:

```text
~/.opencode-insights/insights.sqlite.jsonl
```

The database keeps one day of captures by default and auto-cleans older rows on
startup and after new captures; `retentionDays` sets how many days to keep (`0`
disables auto-cleaning).

Storage settings live in the config file `~/.opencode-insights/config.jsonc` (JSONC —
comments allowed). The plugin creates it on first run with `dbPath` commented out
(uncomment to relocate the database) and `retentionDays` defaulting to 1:

```jsonc
{
  // Database file. Default: ~/.opencode-insights/insights.sqlite
  // "dbPath": "/absolute/path/to/insights.sqlite",
  "retentionDays": 1,
  "promptRightMetrics": ["tps", "avg", "used", "cache"],
  "goUsage": { "enabled": false, "cookie": "", "workspaceID": "", "refreshMs": 300000 }
}
```

A legacy `config.json` is still honored when `config.jsonc` does not exist. Plugin
params such as `{ "dbPath": … }` in `opencode.json` are ignored after the upgrade —
if you previously set `dbPath` or `retentionDays` there, copy those values into
`~/.opencode-insights/config.jsonc`. CLI commands read the configured database path
from this file; the former `--db`/`--data-dir`/`--retention-days` flags are removed.

## Privacy Model

This plugin intentionally does not redact anything. It stores data locally exactly as OpenCode exposes it to plugin hooks and events.

Captured data can include prompts, system messages, provider metadata, API keys exposed inside hook payloads, tool arguments, headers, reasoning text, and response events. Use it only on machines where local full-fidelity capture is acceptable.
