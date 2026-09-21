// Dev-only TUI entrypoint. Re-exports the built plugin so OpenCode loads exactly
// the code `npm run build` produces. `npm run debug` builds before deploying.
export { default } from "../dist/tui.js";
