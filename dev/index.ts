// Dev-only server entrypoint.
//
// OpenCode V2 silently drops a plugin directory that has no server entrypoint
// (ConfigPluginSource.scan does `if (!result.server) return []`), so this no-op
// stub exists purely to keep the directory registered. The actual plugin is the
// TUI entrypoint in ./tui.ts, which OpenCode loads into the CLI.
export default {
  id: "opencode-insights",
  setup() {}
};
