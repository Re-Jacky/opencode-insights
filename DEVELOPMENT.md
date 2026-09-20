# Development

OpenCode Insights is an OpenCode v2 plugin. The package has one combined plugin
entrypoint and a separate TUI export; OpenCode loads the TUI automatically when
the package is listed in `opencode.json` or `opencode.jsonc`.

## Local Setup

Install dependencies with Node 22.13 or newer:

```bash
npm install
npm run verify
```

The release gate runs typechecking, the full Vitest suite, and the ESM build.
The build emits `dist/index.js`, `dist/tui.js`, and `dist/cli.js`.

## OpenCode Configuration

The plugin belongs in the `plugins` array in `opencode.json(c)`:

```jsonc
{
  "plugins": ["@rejacky/opencode-insights"]
}
```

Do not add a second TUI entry. `cli.json(c)` is reserved for CLI-only plugins;
Insights does not write or require it. The `debug` and `revert` commands update
only the main OpenCode configuration.

## Runtime Data

The default database is `~/.opencode-insights/insights.sqlite`. If SQLite cannot
be loaded, captures append to `~/.opencode-insights/insights.sqlite.jsonl`.
Runtime settings are read from `~/.opencode-insights/config.jsonc`, which is
created on first use. Set `dbPath` there to move the database and
`retentionDays` to control cleanup.

Capture is intentionally unredacted. Prompts, system messages, provider
metadata, headers, tool arguments, API keys present in payloads, reasoning, and
response events may be stored locally.

## CLI And Viewer

The CLI reads the configured database path and provides raw capture, session,
diagnostic, and maintenance commands:

```bash
opencode-insights doctor
opencode-insights recent --limit 20
opencode-insights open --port 8765
```

The viewer is local-only by default at `http://127.0.0.1:8765/`. Use
`opencode-insights serve` when a browser should not be opened automatically.

## Tests

Static entrypoint tests scan production source for removed v1 contracts and
configuration writers. Keep those assertions aligned with the v2-only surface
when changing plugin or TUI integration.
