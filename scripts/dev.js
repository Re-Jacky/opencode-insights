#!/usr/bin/env node
// Dev-only deploy helper. Not published (package.json#files excludes scripts/).
//
//   node scripts/dev.js debug   [--dry-run] [--config <opencode.jsonc>]
//   node scripts/dev.js revert  [--dry-run] [--config <opencode.jsonc>]
//
// This is a TUI-only plugin, so OpenCode V2 loads it from `cli.json` (the same
// place `opencode plugin add` writes a package that exposes a `tui` entrypoint
// but no server entrypoint). The dev entry points at ./dev, whose tui.ts
// re-exports the build. Run `npm run build` first: `npm run debug` does that.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { addLocalPlugin, readPluginSpecs, revertLocalPlugin } from "./dev-config.js";

const OFFICIAL_SPEC = "@rejacky/opencode-insights@latest";
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const localPath = join(repoRoot, "dev");
const distEntry = join(repoRoot, "dist", "tui.js");

function parseArgs(argv) {
  const args = { command: argv[0], dryRun: false, config: undefined };
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--config") args.config = argv[++i];
    else if (arg.startsWith("--config=")) args.config = arg.slice("--config=".length);
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
if (args.command !== "debug" && args.command !== "revert") {
  console.error("usage: node scripts/dev.js <debug|revert> [--dry-run] [--config <opencode.jsonc>]");
  process.exit(1);
}

const configPath = resolve(args.config ?? join(homedir(), ".config", "opencode", "cli.json"));
if (!existsSync(configPath)) {
  console.error(`Config not found: ${configPath}`);
  process.exit(1);
}
if (args.command === "debug" && !existsSync(distEntry)) {
  console.error(`Build output missing: ${distEntry}\nRun: npm run build`);
  process.exit(1);
}

const source = readFileSync(configPath, "utf8");
const before = readPluginSpecs(source);
const result =
  args.command === "debug"
    ? addLocalPlugin(source, localPath)
    : revertLocalPlugin(source, localPath, OFFICIAL_SPEC);

console.log(`${args.command}: ${configPath}`);
console.log(`  local plugin: ${localPath}`);
if (args.dryRun) {
  console.log("  --dry-run: no changes written");
} else if (result.changed) {
  writeFileSync(`${configPath}.bak`, source, "utf8");
  writeFileSync(configPath, result.source, "utf8");
  console.log(`  backup: ${configPath}.bak`);
} else {
  console.log("  (already up to date)");
}
console.log(`  plugins before: ${JSON.stringify(before)}`);
console.log(`  plugins after:  ${JSON.stringify(result.plugins)}`);
