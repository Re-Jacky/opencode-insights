#!/usr/bin/env node
import { formatCaptureSummary, readRecentCaptures } from "./inspect.js";

type CliOptions = {
  dbPath?: string | undefined;
  dataDir?: string | undefined;
  limit: number;
  json: boolean;
};

async function main(argv: string[]) {
  const command = argv[2] ?? "recent";
  const options = parseOptions(argv.slice(3));

  if (command !== "recent") {
    process.stderr.write(`Unknown command: ${command}\n`);
    process.stderr.write("Usage: opencode-insights recent [--db PATH] [--data-dir DIR] [--limit N] [--json]\n");
    process.exitCode = 1;
    return;
  }

  const records = await readRecentCaptures(options);
  process.stdout.write(options.json ? `${JSON.stringify(records, null, 2)}\n` : `${formatCaptureSummary(records)}\n`);
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
    }
  }
  if (!Number.isFinite(options.limit) || options.limit < 1) options.limit = 20;
  return options;
}

main(process.argv).catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
