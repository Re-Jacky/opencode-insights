#!/usr/bin/env node
import { execFile } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { resolveCapturePath } from "./capture.js";
import { buildRequestHistory, formatCaptureSummary, readRecentCaptures } from "./inspect.js";
import { serveViewer } from "./viewer.js";

const execFileAsync = promisify(execFile);
const DEFAULT_RECENT_LIMIT = 20;
const DEFAULT_HISTORY_LIMIT = 5_000;
const SERVER_PLUGIN_SPEC = "@rejacky/opencode-insights";
const TUI_PLUGIN_SPEC = SERVER_PLUGIN_SPEC;
const SUBPATH_TUI_PLUGIN_SPEC = "@rejacky/opencode-insights/tui";

type CliOptions = {
  dbPath?: string | undefined;
  dataDir?: string | undefined;
  limit: number;
  limitProvided: boolean;
  json: boolean;
  host?: string | undefined;
  port?: number | undefined;
  output?: string | undefined;
  configDir?: string | undefined;
  dryRun: boolean;
  keepData: boolean;
};

async function main(argv: string[]) {
  const command = argv[2] ?? "recent";
  const options = parseOptions(argv.slice(3));
  const positionals = parsePositionals(argv.slice(3));

  if (command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  if (command === "recent") {
    const records = await readRecentCaptures({ ...options, limit: options.limitProvided ? options.limit : DEFAULT_RECENT_LIMIT });
    process.stdout.write(options.json ? `${JSON.stringify(records, null, 2)}\n` : `${formatCaptureSummary(records)}\n`);
    return;
  }

  if (command === "history") {
    const records = await readRecentCaptures(historyReadOptions(options));
    const history = buildRequestHistory(records);
    process.stdout.write(`${JSON.stringify(history, null, 2)}\n`);
    return;
  }

  if (command === "sessions") {
    const records = await readRecentCaptures(historyReadOptions(options));
    const history = buildRequestHistory(records);
    const rows = summarizeSessions(history.sessions);
    process.stdout.write(options.json ? `${JSON.stringify(rows, null, 2)}\n` : `${formatSessionSummary(rows)}\n`);
    return;
  }

  if (command === "show") {
    const sessionID = positionals[0];
    if (!sessionID) throw new Error("Missing session id. Usage: opencode-insights show <session-id>");
    const session = await readSession(sessionID, options);
    process.stdout.write(`${JSON.stringify(session, null, 2)}\n`);
    return;
  }

  if (command === "export") {
    const sessionID = positionals[0];
    if (!sessionID) throw new Error("Missing session id. Usage: opencode-insights export <session-id> [--output PATH]");
    const session = await readSession(sessionID, options);
    const json = `${JSON.stringify(session, null, 2)}\n`;
    if (options.output) {
      await mkdir(dirname(options.output), { recursive: true });
      await writeFile(options.output, json, "utf8");
      process.stdout.write(`Exported ${sessionID} to ${options.output}\n`);
    } else {
      process.stdout.write(json);
    }
    return;
  }

  if (command === "serve") {
    const viewer = await serveViewer({ ...options, limit: options.limitProvided ? options.limit : DEFAULT_HISTORY_LIMIT });
    process.stdout.write(`OpenCode Insights viewer listening at ${viewer.url}\n`);
    return;
  }

  if (command === "open") {
    const viewer = await serveViewer({ ...options, limit: options.limitProvided ? options.limit : DEFAULT_HISTORY_LIMIT });
    await openBrowser(viewer.url);
    process.stdout.write(`OpenCode Insights viewer listening at ${viewer.url}\n`);
    return;
  }

  if (command === "doctor") {
    process.stdout.write(`${await runDoctor(options)}\n`);
    return;
  }

  if (command === "vacuum") {
    process.stdout.write(`${await vacuumDatabase(options)}\n`);
    return;
  }

  if (command === "configure") {
    process.stdout.write(`${await configureOpenCode(options)}\n`);
    return;
  }

  if (command === "debug") {
    process.stdout.write(`${await configureOpenCodeDebug(options)}\n`);
    return;
  }

  if (command === "uninstall") {
    process.stdout.write(`${await uninstallOpenCode(options)}\n`);
    return;
  }

  {
    process.stderr.write(`Unknown command: ${command}\n`);
    process.stderr.write(`${usage()}\n`);
    process.exitCode = 1;
  }
}

export function parseOptions(args: string[]): CliOptions {
  const options: CliOptions = { limit: DEFAULT_RECENT_LIMIT, limitProvided: false, json: false, dryRun: false, keepData: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json") {
      options.json = true;
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--keep-data") {
      options.keepData = true;
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
      options.limitProvided = true;
      index += 1;
    } else if (arg === "--host") {
      const value = args[index + 1];
      if (value) options.host = value;
      index += 1;
    } else if (arg === "--port") {
      options.port = Number.parseInt(args[index + 1] ?? "8765", 10);
      index += 1;
    } else if (arg === "--output" || arg === "-o") {
      const value = args[index + 1];
      if (value) options.output = value;
      index += 1;
    } else if (arg === "--config-dir") {
      const value = args[index + 1];
      if (value) options.configDir = value;
      index += 1;
    }
  }
  if (!Number.isFinite(options.limit) || options.limit < 1) options.limit = DEFAULT_RECENT_LIMIT;
  if (options.port !== undefined && (!Number.isFinite(options.port) || options.port < 1)) options.port = 8765;
  return options;
}

function parsePositionals(args: string[]) {
  const positionals: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg) continue;
    if (arg.startsWith("--")) {
      if (["--db", "--data-dir", "--limit", "--host", "--port", "--output", "--config-dir"].includes(arg)) index += 1;
      continue;
    }
    if (arg === "-o") {
      index += 1;
      continue;
    }
    positionals.push(arg);
  }
  return positionals;
}

function historyReadOptions(options: CliOptions) {
  return { ...options, limit: options.limitProvided ? options.limit : DEFAULT_HISTORY_LIMIT };
}

async function readSession(sessionID: string, options: CliOptions) {
  const records = await readRecentCaptures(historyReadOptions(options));
  const session = buildRequestHistory(records).sessions.find((item) => item.id === sessionID);
  if (!session) {
    throw new Error(
      `Session not found in the latest ${historyReadOptions(options).limit} capture rows: ${sessionID}. Try --limit 20000 or check opencode-insights sessions.`
    );
  }
  return session;
}

export function summarizeSessions(sessions: ReturnType<typeof buildRequestHistory>["sessions"]) {
  return sessions.map((session) => {
    const hookCount = session.requests.length;
    const responseCount = session.messages.filter((message) => message.response).length;
    const updatedAt = session.updatedAt ?? Math.max(0, ...session.messages.map((message) => message.completedAt ?? message.createdAt ?? 0));
    return {
      id: session.id,
      title: session.title ?? "",
      updatedAt: updatedAt || undefined,
      messages: session.messages.length,
      hooks: hookCount,
      responses: responseCount
    };
  });
}

export function formatSessionSummary(rows: ReturnType<typeof summarizeSessions>) {
  if (rows.length === 0) return "No sessions found.";
  const header = ["updated".padEnd(24), "messages".padStart(8), "hooks".padStart(6), "responses".padStart(9), "session".padEnd(28), "title"].join(
    "  "
  );
  const body = rows.map((row) =>
    [
      (row.updatedAt ? new Date(row.updatedAt).toISOString() : "-").padEnd(24),
      String(row.messages).padStart(8),
      String(row.hooks).padStart(6),
      String(row.responses).padStart(9),
      row.id.padEnd(28),
      row.title || "-"
    ].join("  ")
  );
  return [header, ...body].join("\n");
}

async function openBrowser(url: string) {
  const platform = process.platform;
  if (platform === "darwin") {
    await execFileAsync("open", [url]);
    return;
  }
  if (platform === "win32") {
    await execFileAsync("cmd", ["/c", "start", "", url]);
    return;
  }
  await execFileAsync("xdg-open", [url]);
}

async function runDoctor(options: CliOptions) {
  const dbPath = resolveCapturePath(options);
  const jsonlPath = dbPath.endsWith(".sqlite") ? `${dbPath}.jsonl` : dbPath;
  const rows = [
    `OpenCode Insights doctor`,
    `DB path: ${dbPath}`,
    `DB exists: ${existsSync(dbPath) ? "yes" : "no"}`,
    `JSONL fallback exists: ${existsSync(jsonlPath) ? "yes" : "no"}`
  ];

  if (existsSync(dbPath)) {
    rows.push(...(await sqliteDiagnostics(dbPath)));
  } else if (existsSync(jsonlPath)) {
    const records = await readRecentCaptures({ ...options, limit: options.limitProvided ? options.limit : DEFAULT_HISTORY_LIMIT });
    rows.push(`Readable fallback records: ${records.length}`);
  }

  return rows.join("\n");
}

async function sqliteDiagnostics(dbPath: string) {
  const diagnostics: string[] = [];
  try {
    const tableRows = await sqliteJsonQuery(dbPath, "select name from sqlite_master where type='table' order by name;");
    const tables = tableRows.filter((row) => typeof row.name === "string").map((row) => row.name);
    diagnostics.push(`SQLite CLI: yes`);
    diagnostics.push(`Tables: ${tables.join(", ") || "-"}`);
    if (tables.includes("captures")) {
      const captureRows = await sqliteJsonQuery(dbPath, "select count(*) as captures from captures;");
      const kindRows = await sqliteJsonQuery(dbPath, "select kind, count(*) as count from captures group by kind order by kind;");
      const captureRow = captureRows.find((row) => typeof row.captures === "number");
      diagnostics.push(`Capture rows: ${captureRow?.captures ?? "unknown"}`);
      diagnostics.push(`Capture kinds: ${kindRows.map((row) => `${row.kind}=${row.count}`).join(", ") || "-"}`);
    } else {
      diagnostics.push("Capture rows: unavailable (missing captures table)");
    }
    const integrityRows = await sqliteJsonQuery(dbPath, "pragma integrity_check;");
    const integrity = integrityRows.find((row) => typeof row.integrity_check === "string");
    diagnostics.push(`Integrity: ${integrity?.integrity_check ?? "unknown"}`);
  } catch (error) {
    diagnostics.push(`SQLite CLI: unavailable or failed (${error instanceof Error ? error.message : String(error)})`);
    const records = await readRecentCaptures({ dbPath, limit: DEFAULT_RECENT_LIMIT });
    diagnostics.push(`Readable records via fallback: ${records.length}`);
  }
  return diagnostics;
}

async function sqliteJsonQuery(dbPath: string, sql: string) {
  const { stdout } = await execFileAsync("sqlite3", ["-json", dbPath, sql], { maxBuffer: 128 * 1024 * 1024 });
  return stdout.trim() ? (JSON.parse(stdout) as Record<string, unknown>[]) : [];
}

async function vacuumDatabase(options: CliOptions) {
  const dbPath = resolveCapturePath(options);
  if (!existsSync(dbPath)) return `No SQLite DB found at ${dbPath}`;
  await execFileAsync("sqlite3", [dbPath, "vacuum;"]);
  return `Vacuumed ${dbPath}`;
}

type JsonObject = Record<string, unknown>;

export async function configureOpenCode(options: CliOptions) {
  const configDir = options.configDir ?? defaultOpenCodeConfigDir();
  const opencodePath = resolveOpenCodeConfigPath(configDir);
  const tuiPath = join(configDir, "tui.json");

  const opencodeConfig = await readJsonConfig(opencodePath, { plugin: [] });
  const tuiConfig = await readJsonConfig(tuiPath, { plugin: [] });
  const opencodeChanged = addUniquePlugin(opencodeConfig, SERVER_PLUGIN_SPEC);
  const removedSubpathTui = removePlugin(tuiConfig, SUBPATH_TUI_PLUGIN_SPEC);
  const tuiAdded = addUniquePlugin(tuiConfig, TUI_PLUGIN_SPEC);
  const tuiChanged = removedSubpathTui || tuiAdded;

  const lines = [
    `OpenCode config: ${opencodePath}`,
    `TUI config: ${tuiPath}`,
    `Server plugin: ${opencodeChanged ? "added" : "already present"} (${SERVER_PLUGIN_SPEC})`,
    `TUI plugin: ${tuiAdded ? "added" : "already present"} (${TUI_PLUGIN_SPEC})`
  ];
  if (removedSubpathTui) lines.push(`TUI plugin: removed subpath entry (${SUBPATH_TUI_PLUGIN_SPEC})`);

  if (options.dryRun) {
    lines.push("Dry run: no files written.");
    return lines.join("\n");
  }

  await mkdir(configDir, { recursive: true });
  if (opencodeChanged || !existsSync(opencodePath)) await writeJsonConfig(opencodePath, opencodeConfig);
  if (tuiChanged || !existsSync(tuiPath)) await writeJsonConfig(tuiPath, tuiConfig);
  lines.push("Configuration written. Restart OpenCode to load the plugin.");
  return lines.join("\n");
}

export async function configureOpenCodeDebug(options: CliOptions) {
  const configDir = options.configDir ?? defaultOpenCodeConfigDir();
  const opencodePath = resolveOpenCodeConfigPath(configDir);
  const tuiPath = join(configDir, "tui.json");
  const localServerEntry = resolve("dist/index.js");
  const localTuiEntry = resolve("dist/tui.js");

  if (!existsSync(localServerEntry) || !existsSync(localTuiEntry)) {
    throw new Error("Missing dist output. Run npm run build before opencode-insights debug.");
  }

  const opencodeConfig = await readJsonConfig(opencodePath, { plugin: [] });
  const tuiConfig = await readJsonConfig(tuiPath, { plugin: [] });
  setSinglePluginSpec(opencodeConfig, SERVER_PLUGIN_SPEC, localServerEntry);
  setSinglePluginSpec(tuiConfig, TUI_PLUGIN_SPEC, localTuiEntry);
  removePlugin(tuiConfig, SUBPATH_TUI_PLUGIN_SPEC);

  const lines = [
    `OpenCode config: ${opencodePath}`,
    `TUI config: ${tuiPath}`,
    `Local server plugin: ${localServerEntry}`,
    `Local TUI plugin: ${localTuiEntry}`,
    `Server plugin: set local build output`,
    `TUI plugin: set local build output`
  ];

  if (options.dryRun) {
    lines.push("Dry run: no files written.");
    return lines.join("\n");
  }

  await mkdir(configDir, { recursive: true });
  await writeJsonConfig(opencodePath, opencodeConfig);
  await writeJsonConfig(tuiPath, tuiConfig);
  lines.push("Debug configuration written. Restart OpenCode to load the local build.");
  return lines.join("\n");
}

export function defaultOpenCodeConfigDir() {
  const override = process.env.OPENCODE_CONFIG_DIR;
  if (override) return override;
  if (process.platform === "win32") return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "opencode");
  return join(homedir(), ".config", "opencode");
}

export function resolveOpenCodeConfigPath(configDir: string) {
  const jsoncPath = join(configDir, "opencode.jsonc");
  if (existsSync(jsoncPath)) return jsoncPath;
  const jsonPath = join(configDir, "opencode.json");
  if (existsSync(jsonPath)) return jsonPath;
  return jsonPath;
}

async function readJsonConfig(path: string, fallback: JsonObject) {
  if (!existsSync(path)) return { ...fallback };
  const content = await readFile(path, "utf8");
  const trimmed = content.trim();
  if (!trimmed) return { ...fallback };
  try {
    const parsed = JSON.parse(stripJsonCommentsAndTrailingCommas(trimmed)) as unknown;
    return isJsonObject(parsed) ? parsed : { ...fallback };
  } catch (error) {
    throw new Error(`Could not parse ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function stripJsonCommentsAndTrailingCommas(input: string) {
  let output = "";
  let inString = false;
  let quote = "";
  let escaped = false;
  for (let index = 0; index < input.length; index += 1) {
    const current = input[index] ?? "";
    const next = input[index + 1] ?? "";
    if (inString) {
      output += current;
      if (escaped) {
        escaped = false;
      } else if (current === "\\") {
        escaped = true;
      } else if (current === quote) {
        inString = false;
      }
      continue;
    }
    if (current === '"' || current === "'") {
      inString = true;
      quote = current;
      output += current;
      continue;
    }
    if (current === "/" && next === "/") {
      while (index < input.length && input[index] !== "\n") index += 1;
      output += "\n";
      continue;
    }
    if (current === "/" && next === "*") {
      index += 2;
      while (index < input.length && !(input[index] === "*" && input[index + 1] === "/")) index += 1;
      index += 1;
      continue;
    }
    output += current;
  }
  return output.replace(/,\s*([}\]])/g, "$1");
}

function isJsonObject(value: unknown): value is JsonObject {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function addUniquePlugin(config: JsonObject, plugin: string) {
  const current = Array.isArray(config.plugin) ? config.plugin : [];
  if (current.includes(plugin)) {
    config.plugin = current;
    return false;
  }
  config.plugin = [...current, plugin];
  return true;
}

export function removePlugin(config: JsonObject, plugin: string) {
  const current = Array.isArray(config.plugin) ? config.plugin : [];
  const next = current.filter((entry) => !isPluginEntry(entry, plugin));
  config.plugin = next;
  return next.length !== current.length;
}

function isPluginEntry(entry: unknown, plugin: string) {
  return entry === plugin || (Array.isArray(entry) && entry[0] === plugin);
}

function setSinglePluginSpec(config: JsonObject, previousPlugin: string, nextPlugin: string) {
  const current = Array.isArray(config.plugin) ? config.plugin : [];
  const next = current.filter((entry) => !isInsightsPluginEntry(entry, previousPlugin, nextPlugin));
  config.plugin = [...next, nextPlugin];
}

function isInsightsPluginEntry(entry: unknown, packagePlugin: string, localPlugin: string) {
  if (isPluginEntry(entry, packagePlugin) || isPluginEntry(entry, localPlugin) || isPluginEntry(entry, SUBPATH_TUI_PLUGIN_SPEC)) {
    return true;
  }
  const spec = Array.isArray(entry) ? entry[0] : entry;
  if (typeof spec !== "string") return false;
  return /(?:^|[/@-])opencode-insights.*\.tgz$/u.test(spec) || /\/opencode-insights\/dist\/(?:index|tui)\.js$/u.test(spec);
}

export async function uninstallOpenCode(options: CliOptions) {
  const configDir = options.configDir ?? defaultOpenCodeConfigDir();
  const opencodePath = resolveOpenCodeConfigPath(configDir);
  const tuiPath = join(configDir, "tui.json");
  const dbPath = resolveCapturePath(options);
  const jsonlPath = dbPath.endsWith(".sqlite") ? `${dbPath}.jsonl` : dbPath;

  const lines = [
    `OpenCode config: ${opencodePath}`,
    `TUI config: ${tuiPath}`,
    `DB path: ${dbPath}`,
    `JSONL fallback path: ${jsonlPath}`
  ];

  const opencodeResult = await removePluginFromConfig(opencodePath, SERVER_PLUGIN_SPEC, options);
  const tuiResult = await removePluginFromConfig(tuiPath, TUI_PLUGIN_SPEC, options);
  const subpathTuiResult = await removePluginFromConfig(tuiPath, SUBPATH_TUI_PLUGIN_SPEC, options);
  lines.push(`Server plugin: ${opencodeResult}`);
  lines.push(`TUI plugin: ${tuiResult}`);
  lines.push(`Subpath TUI plugin: ${subpathTuiResult}`);

  if (options.keepData) {
    lines.push("Data cleanup: skipped (--keep-data).");
  } else {
    const removed = await removeDataFiles([dbPath, jsonlPath], options);
    lines.push(`Data cleanup: ${removed.length ? `removed ${removed.join(", ")}` : "no data files found"}`);
  }

  if (options.dryRun) {
    lines.push("Dry run: no files changed.");
  } else {
    lines.push("Uninstall cleanup complete. Restart OpenCode to unload the plugin.");
  }

  return lines.join("\n");
}

async function removePluginFromConfig(path: string, plugin: string, options: CliOptions) {
  if (!existsSync(path)) return "config not found";
  const config = await readJsonConfig(path, { plugin: [] });
  const changed = removePlugin(config, plugin);
  if (!changed) return `not present (${plugin})`;
  if (options.dryRun) return `would remove (${plugin})`;
  await writeJsonConfig(path, config);
  return `removed (${plugin})`;
}

async function removeDataFiles(paths: string[], options: CliOptions) {
  const uniquePaths = [...new Set(paths)];
  const existing = uniquePaths.filter((path) => existsSync(path));
  if (options.dryRun) return existing;
  for (const path of existing) {
    await rm(path, { force: true });
  }
  return existing;
}

async function writeJsonConfig(path: string, config: JsonObject) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

function usage() {
  return [
    "Usage:",
    "  opencode-insights configure [--config-dir DIR] [--dry-run]",
    "  opencode-insights debug [--config-dir DIR] [--dry-run]",
    "  opencode-insights uninstall [--config-dir DIR] [--db PATH] [--data-dir DIR] [--keep-data] [--dry-run]",
    "  opencode-insights recent [--db PATH] [--data-dir DIR] [--limit N] [--json]",
    "  opencode-insights sessions [--db PATH] [--data-dir DIR] [--limit N] [--json]",
    "  opencode-insights history [--db PATH] [--data-dir DIR] [--limit N]",
    "  opencode-insights show <session-id> [--db PATH] [--data-dir DIR] [--limit N]",
    "  opencode-insights export <session-id> [--output PATH] [--db PATH] [--data-dir DIR] [--limit N]",
    "  opencode-insights serve [--db PATH] [--data-dir DIR] [--limit N] [--host HOST] [--port PORT]",
    "  opencode-insights open [--db PATH] [--data-dir DIR] [--limit N] [--host HOST] [--port PORT]",
    "  opencode-insights doctor [--db PATH] [--data-dir DIR]",
    "  opencode-insights vacuum [--db PATH] [--data-dir DIR]"
  ].join("\n");
}

function isDirectRun() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return pathToFileURL(realpathSync(entry)).href === import.meta.url;
  } catch {
    return pathToFileURL(entry).href === import.meta.url;
  }
}

if (isDirectRun()) {
  main(process.argv).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
