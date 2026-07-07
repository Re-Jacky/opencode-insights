# opencode-insights

OpenCode plugin for local request visibility, live TPS metrics, and subagent status.

## What It Does

- Shows live TPS, average TPS, and average TTFT in the OpenCode prompt zone.
- Shows subagent status in the right sidebar: running, done, failed, elapsed time, and token/context usage when OpenCode exposes it.
- Captures OpenCode hook/event data locally without redaction.
- Provides a local web viewer for sessions, messages, hooks, request context, system/messages transforms, and assistant responses.

## Privacy Model

This plugin intentionally does not redact anything. It stores data locally exactly as OpenCode exposes it to plugin hooks and events. Captured data can include prompts, system messages, provider metadata, API keys exposed inside hook payloads, tool arguments, headers, reasoning text, and response events.

Use it only on machines where local full-fidelity capture is acceptable.

## Storage

Default database path:

```text
~/.opencode-insights/insights.sqlite
```

If SQLite is unavailable in the plugin runtime, the fallback path is:

```text
~/.opencode-insights/insights.sqlite.jsonl
```

You can override storage in OpenCode config:

```json
{
  "plugin": [
    [
      "opencode-insights",
      {
        "dbPath": "/absolute/path/to/insights.sqlite"
      }
    ]
  ]
}
```

## Install For Local Testing

From this repo:

```bash
cd /Users/zyao/Desktop/opencode-insights
npm install
npm run verify
npm pack
```

Install the packed plugin from your OpenCode config/package directory:

```bash
cd ~/.config/opencode
npm i /Users/zyao/Desktop/opencode-insights/opencode-insights-0.1.0.tgz
```

Then configure OpenCode. OpenCode loads the server plugin from `opencode.json` or `opencode.jsonc`, but it loads TUI plugins from a separate `tui.json` file in the same directory.

The easiest path is the explicit installer helper:

```bash
npx opencode-insights configure
```

For local repo development without installing the package binary globally:

```bash
node /Users/zyao/Desktop/opencode-insights/dist/cli.js configure --config-dir ~/.config/opencode
```

This detects or creates:

- `~/.config/opencode/opencode.json` or existing `~/.config/opencode/opencode.jsonc`
- `~/.config/opencode/tui.json`

The resulting server config should include:

```json
{
  "plugin": ["opencode-insights"]
}
```

The resulting `tui.json` should include an absolute path to the built TUI plugin:

```json
{
  "plugin": ["/Users/zyao/Desktop/opencode-insights/dist/tui.js"]
}
```

Restart OpenCode after reinstalling. Existing sessions will not gain missing events retroactively, so create a new session to test capture changes.

## Faster Local Iteration

For development, you can link instead of packing each time:

```bash
cd /Users/zyao/Desktop/opencode-insights
npm link

cd ~/.config/opencode
npm link opencode-insights
```

Still restart OpenCode after rebuilding:

```bash
cd /Users/zyao/Desktop/opencode-insights
npm run build
```

Then refresh both config files:

```bash
node /Users/zyao/Desktop/opencode-insights/dist/cli.js configure --config-dir ~/.config/opencode
```

## CLI Commands

The package exposes:

```bash
opencode-insights <command>
```

If the command is not installed globally, run the built CLI directly:

```bash
node /Users/zyao/Desktop/opencode-insights/dist/cli.js <command>
```

### Configure OpenCode

Configure the server plugin in `opencode.json/jsonc` and the TUI plugin in sibling `tui.json`:

```bash
opencode-insights configure
```

Preview changes without writing files:

```bash
opencode-insights configure --dry-run
```

Use a non-default config directory:

```bash
opencode-insights configure --config-dir ~/.config/opencode
```

### Recent Captures

```bash
opencode-insights recent --limit 20
```

Full JSON:

```bash
opencode-insights recent --limit 20 --json
```

Use a custom DB:

```bash
opencode-insights recent --db ~/.opencode-insights/insights.sqlite --limit 50
```

### Reconstructed History

```bash
opencode-insights history --limit 5000
```

This reconstructs:

- Sessions
- User messages
- Hook rows grouped under the correct message
- Paired `chat.params` and `chat.headers`
- Experimental `messages.transform` and `system.transform`
- Assistant response events

### Sessions

List reconstructed sessions with title, last update time, message count, hook count, and response count:

```bash
opencode-insights sessions --limit 5000
```

Machine-readable output:

```bash
opencode-insights sessions --limit 5000 --json
```

### Show Or Export One Session

Print one reconstructed session:

```bash
opencode-insights show ses_xxx --limit 10000
```

Export one session to JSON:

```bash
opencode-insights export ses_xxx --limit 10000 --output ./session.json
```

### Web Viewer

```bash
opencode-insights serve --limit 5000 --port 8765
```

Open:

```text
http://127.0.0.1:8765/
```

Direct repo fallback:

```bash
node /Users/zyao/Desktop/opencode-insights/dist/cli.js serve --limit 5000 --port 8765
```

Start the viewer and open the browser automatically:

```bash
opencode-insights open --limit 5000 --port 8765
```

The viewer shows:

- `MSG` rows for user messages.
- `HOOK` rows for OpenCode plugin hooks.
- `Summary`, `Request`, `Response`, and `Raw` tabs.
- Expandable/collapsible JSON trees.
- `Expand All` / `Collapse All` controls for JSON tabs.

### Doctor And Maintenance

Check where the plugin is storing data, whether SQLite is readable, row counts by capture kind, and DB integrity:

```bash
opencode-insights doctor
```

Compact the local SQLite database after heavy testing:

```bash
opencode-insights vacuum
```

## Understanding Captured Hooks

The viewer labels OpenCode hook records as `HOOK` because they are not raw HTTP requests.

Common hook rows:

- `HOOK title`: OpenCode title-generation model call. Usually appears only on the first turn.
- `HOOK build`: Main assistant response model-call hook.
- `HOOK messages.transform`: Final conversation messages OpenCode prepared before model execution.
- `HOOK system.transform`: System prompt strings OpenCode prepared before model execution.

Hook payload meaning:

- `payload.input`: Context OpenCode passed into the plugin hook.
- `payload.output`: Value returned by the hook, such as model settings or transformed messages.
- `headers.output.headers`: Headers returned by the headers hook.
- Response text is captured from OpenCode event stream rows such as `message.part.delta` and `message.part.updated`.

The plugin currently reconstructs a logical LLM request from hooks and events. It does not yet capture the final provider HTTP body unless OpenCode exposes a lower-level transport hook in the future.

## Useful SQLite Queries

Count captured rows:

```bash
sqlite3 ~/.opencode-insights/insights.sqlite \
  "select kind, count(*) from captures group by kind order by kind;"
```

Recent hook records:

```bash
sqlite3 ~/.opencode-insights/insights.sqlite "
select datetime(timestamp/1000,'unixepoch','localtime') as time,
       kind,
       session_id,
       message_id,
       provider_id,
       model_id
from captures
where kind in (
  'chat.params',
  'chat.headers',
  'experimental.chat.messages.transform',
  'experimental.chat.system.transform'
)
order by timestamp desc
limit 20;
"
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

Run all checks:

```bash
npm run verify
```

Individual commands:

```bash
npm run typecheck
npm test
npm run build
```

## Publish Checklist

Before publishing:

```bash
npm run verify
npm pack --dry-run
```

Review package contents:

```bash
npm pack
tar -tf opencode-insights-0.1.0.tgz
```

Publish:

```bash
npm login
npm publish --access public
```

After publishing, users should be able to install from their OpenCode config/package directory with:

```bash
cd ~/.config/opencode
npm i opencode-insights
npx opencode-insights configure
```

That writes or updates `opencode.json/jsonc` with:

```json
{
  "plugin": ["opencode-insights"]
}
```

And writes or updates sibling `tui.json` with:

```json
{
  "plugin": ["/absolute/path/to/node_modules/opencode-insights/dist/tui.js"]
}
```
