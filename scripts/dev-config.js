import { applyEdits, modify, parse } from "jsonc-parser";

const INSIGHTS_PACKAGE = "@rejacky/opencode-insights";

function isRecord(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function detectEol(source) {
  return source.includes("\r\n") ? "\r\n" : "\n";
}

function isInsightsEntry(entry, localPath) {
  if (entry === localPath || entry === INSIGHTS_PACKAGE) return true;
  return entry.startsWith(`${INSIGHTS_PACKAGE}@`) || entry.startsWith(`${INSIGHTS_PACKAGE}/`);
}

export function readPluginSpecs(source) {
  const errors = [];
  const parsed = parse(source, errors, { allowTrailingComma: true });
  if (errors.length > 0 || !isRecord(parsed)) return [];
  const plugins = parsed.plugins;
  if (!Array.isArray(plugins)) return [];
  return plugins.filter((entry) => typeof entry === "string");
}

function writePlugins(source, plugins) {
  const edits = modify(source, ["plugins"], plugins, {
    formattingOptions: { insertSpaces: true, tabSize: 2, eol: detectEol(source) }
  });
  return applyEdits(source, edits);
}

function transform(source, plugins, previous) {
  return {
    source: writePlugins(source, plugins),
    plugins,
    changed: JSON.stringify(plugins) !== JSON.stringify(previous)
  };
}

export function addLocalPlugin(source, localPath) {
  const previous = readPluginSpecs(source);
  const plugins = previous.filter((entry) => !isInsightsEntry(entry, localPath));
  if (!plugins.includes(localPath)) plugins.push(localPath);
  return transform(source, plugins, previous);
}

export function revertLocalPlugin(source, localPath, officialSpec) {
  const previous = readPluginSpecs(source);
  const plugins = previous.filter((entry) => !isInsightsEntry(entry, localPath));
  if (!plugins.includes(officialSpec)) plugins.push(officialSpec);
  return transform(source, plugins, previous);
}
