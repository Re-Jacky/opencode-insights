# opencode-insights

Local OpenCode observability for live TPS, subagent status, and full-fidelity request/session inspection.

## Install

Install globally with OpenCode's plugin manager:

```bash
opencode plugin @rejacky/opencode-insights --global
```

Restart OpenCode after installing the plugin.

## Uninstall

Remove this plugin from `opencode.json` / `opencode.jsonc`, remove it from `tui.json`, and delete the local Insights database files:

```bash
npx opencode-insights uninstall
```

Preview the cleanup without changing files:

```bash
npx opencode-insights uninstall --dry-run
```

Keep captured data while removing only the plugin config entries:

```bash
npx opencode-insights uninstall --keep-data
```

Use a custom OpenCode config directory or data location:

```bash
npx opencode-insights uninstall --config-dir ~/.config/opencode --data-dir ~/.opencode-insights
```

After uninstalling, restart OpenCode. If you also want to remove the npm package from your OpenCode config/package directory, run:

```bash
cd ~/.config/opencode
npm rm @rejacky/opencode-insights
```

## What You Get

- Live TPS, average TPS, and average TTFT in the OpenCode prompt zone.
- Right-sidebar subagent status: running, done, failed, elapsed time, and token/context usage when OpenCode exposes it.
- Local capture of OpenCode hook/event data without redaction.
- A local web viewer for sessions, messages, hooks, request context, system/messages transforms, and assistant responses.

## Open The Viewer

Start the local web viewer and open it in your browser:

```bash
npx opencode-insights open --limit 5000 --port 8765
```

Or run the server only:

```bash
npx opencode-insights serve --limit 5000 --port 8765
```

Then open:

```text
http://127.0.0.1:8765/
```

The viewer shows:

- `MSG` rows for user messages.
- `HOOK` rows for OpenCode plugin hooks.
- `Summary`, `Request`, `Response`, and `Raw` tabs.
- Expandable/collapsible JSON trees with `Expand All` and `Collapse All`.

## Common Commands

List recent raw captures:

```bash
npx opencode-insights recent --limit 20
```

List reconstructed sessions:

```bash
npx opencode-insights sessions --limit 5000
```

Print one reconstructed session:

```bash
npx opencode-insights show ses_xxx --limit 10000
```

Export one session to JSON:

```bash
npx opencode-insights export ses_xxx --limit 10000 --output ./session.json
```

Check DB path, table health, row counts, and SQLite readability:

```bash
npx opencode-insights doctor
```

Compact the local SQLite DB after heavy testing:

```bash
npx opencode-insights vacuum
```

Remove plugin config entries and delete local captured data:

```bash
npx opencode-insights uninstall
```

If the command is not available through `npx`, run the installed binary directly from your OpenCode config directory:

```bash
./node_modules/.bin/opencode-insights doctor
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

You can override storage in `opencode.json` or `opencode.jsonc`:

```json
{
  "plugin": [
    [
      "@rejacky/opencode-insights",
      {
        "dbPath": "/absolute/path/to/insights.sqlite"
      }
    ]
  ]
}
```

## Privacy Model

This plugin intentionally does not redact anything. It stores data locally exactly as OpenCode exposes it to plugin hooks and events.

Captured data can include prompts, system messages, provider metadata, API keys exposed inside hook payloads, tool arguments, headers, reasoning text, and response events. Use it only on machines where local full-fidelity capture is acceptable.

## Captured Hooks

The viewer labels OpenCode hook records as `HOOK` because they are not raw HTTP requests.

Common hook rows:

- `HOOK title`: OpenCode title-generation model call, usually only on the first turn.
- `HOOK build`: Main assistant response model-call hook.
- `HOOK messages.transform`: Final conversation messages OpenCode prepared before model execution.
- `HOOK system.transform`: System prompt strings OpenCode prepared before model execution.

Hook payload meaning:

- `payload.input`: Context OpenCode passed into the plugin hook.
- `payload.output`: Value returned by the hook, such as model settings or transformed messages.
- `headers.output.headers`: Headers returned by the headers hook.
- Response text is captured from OpenCode event stream rows such as `message.part.delta` and `message.part.updated`.

The plugin reconstructs a logical LLM request from hooks and events. It does not capture the final provider HTTP body unless OpenCode exposes a lower-level transport hook in the future.

## SQLite Queries

Count captured rows:

```bash
sqlite3 ~/.opencode-insights/insights.sqlite \
  "select kind, count(*) from captures group by kind order by kind;"
```

Find text in captured payloads:

```bash
sqlite3 ~/.opencode-insights/insights.sqlite "
select datetime(timestamp/1000,'unixepoch','localtime') as time,
       kind,
       session_id,
       message_id,
       substr(payload_json, 1, 1200) as preview
from captures
where payload_json like '%search text%'
order by timestamp desc
limit 20;
"
```

## Development

Development and publish notes live in [DEVELOPMENT.md](./DEVELOPMENT.md).
