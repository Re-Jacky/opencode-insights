import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { parse, type ParseError } from "jsonc-parser";
import { DEFAULT_PROMPT_RIGHT_METRICS, type PromptRightMetric } from "./metrics.js";

export type InsightsOptions = {
  dataDir?: unknown;
};

export type GoUsageConfig = {
  enabled: boolean;
  cookie: string;
  workspaceID: string;
  refreshMs: number;
};

export type CopilotUsageConfig = {
  enabled: boolean;
  token: string;
  refreshMs: number;
};

export type PromptRightColor = "base" | "muted" | "info" | "success" | "warning" | "error";

export type InsightsConfig = {
  promptRightMetrics: PromptRightMetric[];
  promptRightColor: PromptRightColor;
  goUsage: GoUsageConfig;
  copilotUsage: CopilotUsageConfig;
};

const DEFAULT_PROMPT_RIGHT_COLOR: PromptRightColor = "muted";
const DEFAULT_GO_USAGE_REFRESH_MS = 300_000;
const DEFAULT_COPILOT_USAGE_REFRESH_MS = 300_000;
const MIN_GO_USAGE_REFRESH_MS = 60_000;
const MIN_COPILOT_USAGE_REFRESH_MS = 60_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function defaultDataDir() {
  return join(homedir(), ".opencode-insights");
}

function resolveConfigDataDir(options: InsightsOptions = {}) {
  return typeof options.dataDir === "string" && options.dataDir.length > 0
    ? options.dataDir
    : defaultDataDir();
}

export function resolveInsightsConfigPath(options: InsightsOptions = {}) {
  return join(resolveConfigDataDir(options), "config.jsonc");
}

export function resolveLegacyInsightsConfigPath(options: InsightsOptions = {}) {
  return join(resolveConfigDataDir(options), "config.json");
}

export async function readInsightsConfig(options: InsightsOptions = {}): Promise<InsightsConfig> {
  const jsoncPath = resolveInsightsConfigPath(options);
  if (existsSync(jsoncPath)) {
    return parseInsightsConfigFile(jsoncPath);
  }

  const legacyPath = resolveLegacyInsightsConfigPath(options);
  if (existsSync(legacyPath)) {
    return parseInsightsConfigFile(legacyPath);
  }

  try {
    await mkdir(dirname(jsoncPath), { recursive: true });
    await writeFile(jsoncPath, defaultInsightsConfigJsonc(), "utf8");
  } catch {
    // First-run setup is best-effort; defaults still apply.
  }
  return defaultInsightsConfig();
}

async function parseInsightsConfigFile(path: string): Promise<InsightsConfig> {
  try {
    const parseErrors: ParseError[] = [];
    const parsed = parse(await readFile(path, "utf8"), parseErrors, { allowTrailingComma: true }) as unknown;
    if (parseErrors.length > 0) return defaultInsightsConfig();
    return insightsConfigFrom(parsed);
  } catch {
    return defaultInsightsConfig();
  }
}

function defaultInsightsConfigJsonc(): string {
  return [
    "{",
    `  "promptRightMetrics": ${JSON.stringify(DEFAULT_PROMPT_RIGHT_METRICS)},`,
    `  "promptRightColor": ${JSON.stringify(DEFAULT_PROMPT_RIGHT_COLOR)},`,
    `  "goUsage": ${JSON.stringify(defaultGoUsageConfig())},`,
    `  "copilotUsage": ${JSON.stringify(defaultCopilotUsageConfig())}`,
    "}",
    ""
  ].join("\n");
}

function defaultInsightsConfig(): InsightsConfig {
  return {
    promptRightMetrics: [...DEFAULT_PROMPT_RIGHT_METRICS],
    promptRightColor: DEFAULT_PROMPT_RIGHT_COLOR,
    goUsage: defaultGoUsageConfig(),
    copilotUsage: defaultCopilotUsageConfig()
  };
}

function defaultGoUsageConfig(): GoUsageConfig {
  return { enabled: false, cookie: "", workspaceID: "", refreshMs: DEFAULT_GO_USAGE_REFRESH_MS };
}

function defaultCopilotUsageConfig(): CopilotUsageConfig {
  return { enabled: false, token: "", refreshMs: DEFAULT_COPILOT_USAGE_REFRESH_MS };
}

function insightsConfigFrom(value: unknown): InsightsConfig {
  const record = isRecord(value) ? value : {};
  const metrics = Array.isArray(record.promptRightMetrics)
    ? record.promptRightMetrics.map((metric) => (metric === "used" ? "total" : metric)).filter(isPromptRightMetric)
    : [];
  return {
    promptRightMetrics: metrics.length ? metrics : [...DEFAULT_PROMPT_RIGHT_METRICS],
    promptRightColor: isPromptRightColor(record.promptRightColor) ? record.promptRightColor : DEFAULT_PROMPT_RIGHT_COLOR,
    goUsage: goUsageConfigFrom(record.goUsage),
    copilotUsage: copilotUsageConfigFrom(record.copilotUsage)
  };
}

function isPromptRightColor(value: unknown): value is PromptRightColor {
  return (
    value === "base" ||
    value === "muted" ||
    value === "info" ||
    value === "success" ||
    value === "warning" ||
    value === "error"
  );
}

function goUsageConfigFrom(value: unknown): GoUsageConfig {
  const record = isRecord(value) ? value : {};
  const enabled = record.enabled === true;
  const cookie = typeof record.cookie === "string" && record.cookie.length > 0 ? record.cookie : "";
  const workspaceID =
    typeof record.workspaceID === "string" && record.workspaceID.length > 0 ? record.workspaceID : "";
  const refreshMs =
    typeof record.refreshMs === "number" && Number.isFinite(record.refreshMs)
      ? Math.max(MIN_GO_USAGE_REFRESH_MS, Math.trunc(record.refreshMs))
      : DEFAULT_GO_USAGE_REFRESH_MS;
  return { enabled, cookie, workspaceID, refreshMs };
}

function copilotUsageConfigFrom(value: unknown): CopilotUsageConfig {
  const record = isRecord(value) ? value : {};
  const enabled = record.enabled === true;
  const token = typeof record.token === "string" && record.token.length > 0 ? record.token : "";
  const refreshMs =
    typeof record.refreshMs === "number" && Number.isFinite(record.refreshMs)
      ? Math.max(MIN_COPILOT_USAGE_REFRESH_MS, Math.trunc(record.refreshMs))
      : DEFAULT_COPILOT_USAGE_REFRESH_MS;
  return { enabled, token, refreshMs };
}

function isPromptRightMetric(value: unknown): value is PromptRightMetric {
  return (
    value === "tps" ||
    value === "avg" ||
    value === "ttft" ||
    value === "total" ||
    value === "cache" ||
    value === "input" ||
    value === "output" ||
    value === "reasoning"
  );
}

export function resolveCopilotToken(config: CopilotUsageConfig): string {
  if (config.token.length > 0) return config.token;
  try {
    const authPath = join(homedir(), ".local/share/opencode/auth.json");
    if (!existsSync(authPath)) return "";
    const raw = readFileSync(authPath, "utf8");
    const auth = JSON.parse(raw) as Record<string, unknown>;
    const copilot = isRecord(auth?.["github-copilot"]) ? auth["github-copilot"] : undefined;
    if (!copilot) return "";
    const access = typeof copilot.access === "string" ? copilot.access : "";
    const refresh = typeof copilot.refresh === "string" ? copilot.refresh : "";
    return access || refresh;
  } catch {
    return "";
  }
}
