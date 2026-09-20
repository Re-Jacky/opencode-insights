import { Plugin } from "@opencode/plugin";

const id = "opencode-insights";

const setup = async () => {};

export default Plugin.define({ id, setup });

export * from "./capture.js";
export * from "./metrics.js";
export * from "./subagents.js";
