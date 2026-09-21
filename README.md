# opencode-insights

Live OpenCode TUI sidebars for token/TPS metrics, session analysis, subagent status, and provider usage. V2-only.

## Install

This is a TUI-only plugin, so OpenCode loads it from the CLI config
(`~/.config/opencode/cli.json`) — the same place `opencode plugin add` writes a
package that exposes a TUI entrypoint but no server entrypoint. Install with:

```bash
opencode plugin add @rejacky/opencode-insights
```

Or add it manually:

```jsonc
// ~/.config/opencode/cli.json
{
  "plugins": ["@rejacky/opencode-insights"]
}
```

Then restart OpenCode.

> Do not add it to `opencode.json(c)` `plugins`: OpenCode V2 drops a plugin
> directory or package from there unless it exposes a `server` entrypoint, and
> this plugin is TUI-only.

## Update

```bash
rm -rf ~/.cache/opencode/packages/node_modules/@rejacky/opencode-insights
```

Then reinstall by restarting OpenCode, or bump the version in `cli.json` if you pin one.

## What You Get

- **Prompt metrics** on their own line directly above the composer, configurable and ordered by `promptRightMetrics`. `tps` is a live estimate over a 5s window while the model streams (reasoning deltas included, so it shows while the model is thinking); `avg` uses the same window as the native message header's `tok/s`; `ttft` is the time to the first token of any kind.
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

## Breaking Change: V2-only

This plugin now targets OpenCode V2 (`@opencode/plugin@2.x`) as a TUI-only plugin. The previous V1 server plugin, local capture database, web viewer, and `opencode-insights` CLI have been removed.

If you need those V1 features, stay on the `0.4.x` line. Upgrading to `1.x` requires OpenCode V2.

## Privacy

This plugin stores nothing. It reads session, message, and token data from OpenCode's in-process V2 data API and renders it in the TUI. No prompts, responses, or headers are captured or persisted.
