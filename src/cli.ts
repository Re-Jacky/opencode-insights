#!/usr/bin/env node
import { buildRequestHistory, formatCaptureSummary, readRecentCaptures } from "./inspect.js";
import { serveViewer } from "./viewer.js";

type CliOptions = {
  dbPath?: string | undefined;
  dataDir?: string | undefined;
  limit: number;
  json: boolean;
  host?: string | undefined;
  port?: number | undefined;
};

async function main(argv: string[]) {
  const command = argv[2] ?? "recent";
  const options = parseOptions(argv.slice(3));

  if (command === "recent") {
    const records = await readRecentCaptures(options);
    process.stdout.write(options.json ? `${JSON.stringify(records, null, 2)}\n` : `${formatCaptureSummary(records)}\n`);
    return;
  }

  if (command === "history") {
    const records = await readRecentCaptures(options);
    const history = buildRequestHistory(records);
    process.stdout.write(`${JSON.stringify(history, null, 2)}\n`);
    return;
  }

  if (command === "serve") {
    const viewer = await serveViewer(options);
    process.stdout.write(`OpenCode Insights viewer listening at ${viewer.url}\n`);
    return;
  }

  {
    process.stderr.write(`Unknown command: ${command}\n`);
    process.stderr.write(
      [
        "Usage:",
        "  opencode-insights recent [--db PATH] [--data-dir DIR] [--limit N] [--json]",
        "  opencode-insights history [--db PATH] [--data-dir DIR] [--limit N]",
        "  opencode-insights serve [--db PATH] [--data-dir DIR] [--limit N] [--host HOST] [--port PORT]"
      ].join("\n") + "\n"
    );
    process.exitCode = 1;
  }
}

function parseOptions(args: string[]): CliOptions {
  const options: CliOptions = { limit: 20, json: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json") {
      options.json = true;
    } else if (arg === "--db") {
      const value = args[index + 1];
      if (value) options.dbPath = value;
      index += 1;
    } else if (arg === "--data-dir") {
      const value = args[index + 1];
      if (value) options.dataDir = value;
      index += 1;
    } else if (arg === "--limit") {
      options.limit = Number.parseInt(args[index + 1] ?? "20", 10);
      index += 1;
    } else if (arg === "--host") {
      const value = args[index + 1];
      if (value) options.host = value;
      index += 1;
    } else if (arg === "--port") {
      options.port = Number.parseInt(args[index + 1] ?? "8765", 10);
      index += 1;
    }
  }
  if (!Number.isFinite(options.limit) || options.limit < 1) options.limit = 20;
  if (options.port !== undefined && (!Number.isFinite(options.port) || options.port < 1)) options.port = 8765;
  return options;
}

main(process.argv).catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
