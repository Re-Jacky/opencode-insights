# opencode-insights

OpenCode plugin for local, full-fidelity request capture plus live session visibility.

## Features

- Shows live TPS, average TPS, and average TTFT in the session prompt.
- Shows subagent status counts, elapsed time, and token/context totals when OpenCode exposes them.
- Captures OpenCode LLM-related hooks locally without redaction: chat messages, chat params, headers, events, and tool payloads.

## Local Storage

By default, records are written to:

```text
~/.local/share/opencode-insights/requests.sqlite
```

When running in an environment without Bun's SQLite runtime, the plugin falls back to:

```text
~/.local/share/opencode-insights/requests.sqlite.jsonl
```

You can override this path in plugin options:

```json
{
  "plugin": [
    [
      "opencode-insights",
      {
        "dbPath": "/absolute/path/to/requests.sqlite"
      }
    ]
  ]
}
```

## Important Privacy Note

This plugin intentionally does not redact anything. It stores request and response-adjacent data exactly as OpenCode exposes it to plugin hooks, including prompts, headers, provider options, tool arguments, and event payloads.

## Inspect Captures

After installing the package, view recent local captures with:

```bash
opencode-insights recent --limit 20
```

For full payload review:

```bash
opencode-insights recent --limit 20 --json
```
