#!/usr/bin/env node
import { execFile } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { applyEdits, modify, parse, type ParseError } from "jsonc-parser";
import { readInsightsConfig, resolveCapturePath, resolveInsightsConfigPath } from "./capture.js";
import { buildRequestHistory, formatCaptureSummary, readRecentCaptures } from "./inspect.js";
import { serveViewer } from "./viewer.js";

const execFileAsync = promisify(execFile);
const DEFAULT_RECENT_LIMIT = 20;
const DEFAULT_HISTORY_LIMIT = 5_000;
const SERVER_PLUGIN_SPEC = "@rejacky/opencode-insights";
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

export function unsupportedFlagWarning(arg: string): string | undefined {
  if (arg === "--data-dir") {
    return "warning: --data-dir is no longer supported; the CLI reads the configured database path from ~/.opencode-insights/config.jsonc";
  }
  const setting = arg === "--db" ? "dbPath" : arg === "--retention-days" ? "retentionDays" : undefined;
  if (!setting) return undefined;
  return `warning: ${arg} is no longer supported; set ${setting} in ~/.opencode-insights/config.jsonc`;
}

async function main(argv: string[]) {
  const command = argv[2] ?? "recent";
  for (const arg of argv.slice(3)) {
    const warning = unsupportedFlagWarning(arg);
    if (warning) process.stderr.write(`${warning}\n`);
  }
  const options = parseOptions(argv.slice(3));
  const positionals = parsePositionals(argv.slice(3));
  const config = await readInsightsConfig();
  options.dbPath = config.dbPath;

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

  if (command === "debug") {
    process.stdout.write(`${await configureOpenCodeDebug(options)}\n`);
    return;
  }

  if (command === "revert") {
    process.stdout.write(`${await revertOpenCodeDebug(options)}\n`);
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
      if (["--db", "--data-dir", "--limit", "--host", "--port", "--output", "--config-dir", "--retention-days"].includes(arg)) index += 1;
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

export async function configureOpenCodeDebug(options: CliOptions) {
  const configDir = options.configDir ?? defaultOpenCodeConfigDir();
  const opencodePath = resolveOpenCodeConfigPath(configDir);
  const localServerEntry = resolve("dist/index.js");

  if (!existsSync(localServerEntry) || !existsSync(resolve("dist/tui.js"))) {
    throw new Error("Missing dist output. Run npm run build before opencode-insights debug.");
  }

  const opencodeSource = await readJsonConfigSource(opencodePath);
  const opencodeConfig = await readJsonConfig(opencodePath, { plugins: [] }, opencodeSource);
  setSinglePluginSpec(opencodeConfig, localServerEntry);

  const lines = [
    `OpenCode config: ${opencodePath}`,
    `Local plugin package: ${localServerEntry}`,
    `Insights config: ${resolveInsightsConfigPath({ dataDir: options.dataDir })}`,
    `Plugin: set local build output`
  ];

  if (options.dryRun) {
    lines.push("Dry run: no files written.");
    return lines.join("\n");
  }

  await readInsightsConfig({ dataDir: options.dataDir });
  await mkdir(configDir, { recursive: true });
  await writeJsonConfig(opencodePath, opencodeConfig, opencodeSource);
  lines.push("Debug configuration written. Restart OpenCode to load the local build.");
  return lines.join("\n");
}

export async function revertOpenCodeDebug(options: CliOptions) {
  const configDir = options.configDir ?? defaultOpenCodeConfigDir();
  const opencodePath = resolveOpenCodeConfigPath(configDir);
  const cliPath = resolveOptionalConfigPath(configDir, "cli");
  const tuiPath = resolveOptionalConfigPath(configDir, "tui");
  const officialSpec = `${SERVER_PLUGIN_SPEC}@latest`;

  const serverResult = await revertPluginToOfficial(opencodePath, officialSpec, options, "plugins");
  const cliResult = await removeInsightsFromConfig(cliPath, options);
  const tuiResult = await removeInsightsFromConfig(tuiPath, options);
  const changed = [serverResult, cliResult, tuiResult].some(
    (result) => result.startsWith("replaced") || result.startsWith("removed")
  );

  const lines = [
    `OpenCode config: ${opencodePath}`,
    `CLI config: ${cliPath}`,
    `Legacy TUI config: ${tuiPath}`,
    `Official plugin spec: ${officialSpec}`,
    `Server plugin: ${serverResult}`,
    `CLI plugin: ${cliResult}`,
    `Legacy TUI plugin: ${tuiResult}`
  ];

  if (options.dryRun) {
    lines.push("Dry run: no files written.");
  } else if (changed) {
    lines.push("Reverted to the official package. Restart OpenCode to load it.");
  } else {
    lines.push("No local build output found; nothing to revert.");
  }
  return lines.join("\n");
}

async function revertPluginToOfficial(path: string, officialSpec: string, options: CliOptions, key: "plugins") {
  if (!existsSync(path)) return "config not found";
  const source = await readJsonConfigSource(path);
  const config = await readJsonConfig(path, { [key]: [] }, source);
  const current = Array.isArray(config[key]) ? config[key] : [];
  let changed = false;
  const next = current.map((entry) => {
    if (!isLocalDistEntry(entry)) return entry;
    changed = true;
    return officialSpec;
  });
  if (!changed) return "not present (local build output)";
  config[key] = dedupePluginEntries(next);
  if (options.dryRun) return `would replace local build with ${officialSpec}`;
  await writeJsonConfig(path, config, source);
  return `replaced local build with ${officialSpec}`;
}

async function removeInsightsFromConfig(path: string, options: CliOptions) {
  if (!existsSync(path)) return "config not found";
  const source = await readJsonConfigSource(path);
  const config = await readJsonConfig(path, { plugins: [] }, source);
  const current = Array.isArray(config.plugins) ? config.plugins : [];
  const next = current.filter((entry) => !isInsightsPluginEntry(entry));
  if (next.length === current.length) return "not present (local build output)";
  config.plugins = next;
  if (options.dryRun) return "would remove stale Insights entries";
  await writeJsonConfig(path, config, source);
  return "removed stale Insights entries";
}

function isLocalDistEntry(entry: unknown): boolean {
  const spec = isJsonObject(entry) && typeof entry.package === "string" ? entry.package : entry;
  return typeof spec === "string" && /\/opencode-insights\/dist\/(?:index|tui)\.js$/u.test(spec.replaceAll("\\", "/"));
}

function dedupePluginEntries(values: unknown[]) {
  const seen = new Set<string>();
  return values.filter((value) => {
    const spec = pluginSpec(value);
    if (!spec) return true;
    if (seen.has(spec)) return false;
    seen.add(spec);
    return true;
  });
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

async function readJsonConfig(path: string, fallback: JsonObject, source?: string) {
  const content = source ?? (existsSync(path) ? await readFile(path, "utf8") : undefined);
  if (content === undefined) return { ...fallback };
  const trimmed = content.trim();
  if (!trimmed) return { ...fallback };
  try {
    const parseErrors: ParseError[] = [];
    const parsed = parse(trimmed, parseErrors, { allowTrailingComma: true }) as unknown;
    if (parseErrors.length > 0) throw new Error("invalid JSONC syntax");
    return isJsonObject(parsed) ? parsed : { ...fallback };
  } catch (error) {
    throw new Error(`Could not parse ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function readJsonConfigSource(path: string) {
  return existsSync(path) ? readFile(path, "utf8") : undefined;
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
  const current = Array.isArray(config.plugins) ? config.plugins : [];
  if (current.some((entry) => pluginSpec(entry) === plugin)) {
    config.plugins = current;
    return false;
  }
  config.plugins = [...current, plugin];
  return true;
}

export function removePlugin(config: JsonObject, plugin: string) {
  const current = Array.isArray(config.plugins) ? config.plugins : [];
  const next = current.filter((entry) => !isPluginEntry(entry, plugin));
  config.plugins = next;
  return next.length !== current.length;
}

function isPluginEntry(entry: unknown, plugin: string) {
  return pluginSpec(entry) === plugin;
}

export function setSinglePluginSpec(config: JsonObject, nextPlugin: unknown) {
  const current = Array.isArray(config.plugins) ? config.plugins : [];
  const next = current.filter(
    (entry) => !isInsightsPluginEntry(entry) && pluginSpec(entry) !== pluginSpec(nextPlugin)
  );
  config.plugins = [...next, nextPlugin];
}

function isInsightsPluginEntry(entry: unknown): boolean {
  const spec = pluginSpec(entry);
  if (typeof spec !== "string") return false;
  return isInsightsSpec(spec);
}

function pluginSpec(entry: unknown): string | undefined {
  if (typeof entry === "string") return entry;
  if (isJsonObject(entry) && typeof entry.package === "string") return entry.package;
  return undefined;
}

function isInsightsSpec(spec: string): boolean {
  if (spec === SERVER_PLUGIN_SPEC || spec === SUBPATH_TUI_PLUGIN_SPEC) return true;
  if (spec.startsWith("npm:")) return isInsightsSpec(spec.slice(4));
  if (spec.startsWith(`${SERVER_PLUGIN_SPEC}@`)) return true;
  const normalized = spec.replaceAll("\\", "/");
  return /(?:^|[/@-])opencode-insights.*\.tgz$/u.test(normalized) || /\/opencode-insights\/dist\/(?:index|tui)\.js$/u.test(normalized);
}

export async function uninstallOpenCode(options: CliOptions) {
  const configDir = options.configDir ?? defaultOpenCodeConfigDir();
  const opencodePath = resolveOpenCodeConfigPath(configDir);
  const cliPath = resolveOptionalConfigPath(configDir, "cli");
  const tuiPath = resolveOptionalConfigPath(configDir, "tui");
  const dbPath = resolveCapturePath(options);
  const jsonlPath = dbPath.endsWith(".sqlite") ? `${dbPath}.jsonl` : dbPath;

  const lines = [
    `OpenCode config: ${opencodePath}`,
    `CLI config: ${cliPath}`,
    `Legacy TUI config: ${tuiPath}`,
    `DB path: ${dbPath}`,
    `JSONL fallback path: ${jsonlPath}`
  ];

  const results = await Promise.all([
    removePluginFromConfig(opencodePath, SERVER_PLUGIN_SPEC, options),
    removePluginFromConfig(cliPath, SERVER_PLUGIN_SPEC, options),
    removePluginFromConfig(cliPath, SUBPATH_TUI_PLUGIN_SPEC, options),
    removePluginFromConfig(tuiPath, SERVER_PLUGIN_SPEC, options),
    removePluginFromConfig(tuiPath, SUBPATH_TUI_PLUGIN_SPEC, options)
  ]);
  lines.push(`Server plugin: ${results[0]}`);
  lines.push(`CLI plugin: ${results[1]}`);
  lines.push(`CLI subpath plugin: ${results[2]}`);
  lines.push(`Legacy TUI plugin: ${results[3]}`);
  lines.push(`Legacy TUI subpath plugin: ${results[4]}`);

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
  const source = await readJsonConfigSource(path);
  const config = await readJsonConfig(path, { plugins: [] }, source);
  const current = Array.isArray(config.plugins) ? config.plugins : [];
  const next = current.filter((entry) => !isInsightsSpec(pluginSpec(entry) ?? ""));
  const changed = next.length !== current.length;
  config.plugins = next;
  if (!changed) return `not present (${plugin})`;
  if (options.dryRun) return `would remove (${plugin})`;
  await writeJsonConfig(path, config, source);
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

async function writeJsonConfig(path: string, config: JsonObject, source?: string) {
  await mkdir(dirname(path), { recursive: true });
  if (source !== undefined) {
    const edits = modify(source, ["plugins"], config.plugins, {
      formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" }
    });
    await writeFile(path, applyEdits(source, edits), "utf8");
    return;
  }
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

function usage() {
  return [
    "Usage:",
    "  opencode-insights debug [--config-dir DIR] [--dry-run]",
    "  opencode-insights revert [--config-dir DIR] [--dry-run]",
    "  opencode-insights uninstall [--config-dir DIR] [--keep-data] [--dry-run]",
    "  opencode-insights recent [--limit N] [--json]",
    "  opencode-insights sessions [--limit N] [--json]",
    "  opencode-insights history [--limit N]",
    "  opencode-insights show <session-id> [--limit N]",
    "  opencode-insights export <session-id> [--output PATH] [--limit N]",
    "  opencode-insights serve [--limit N] [--host HOST] [--port PORT]",
    "  opencode-insights open [--limit N] [--host HOST] [--port PORT]",
    "  opencode-insights doctor",
    "  opencode-insights vacuum",
    "",
    "OpenCode v2 uses the plugins array in opencode.json(c). The package's TUI export is loaded automatically; cli.json(c) is only for CLI-only plugins."
  ].join("\n");
}

function resolveOptionalConfigPath(configDir: string, name: "cli" | "tui") {
  const jsoncPath = join(configDir, `${name}.jsonc`);
  if (existsSync(jsoncPath)) return jsoncPath;
  const jsonPath = join(configDir, `${name}.json`);
  return existsSync(jsonPath) ? jsonPath : jsoncPath;
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
