import { recordChild, recordCompaction, recordSkill, recordStep, recordToolPart, type ActivityState } from "./activity.js";
import type { CopilotProviderTracker } from "./copilot-usage.js";
import type { GoProviderTracker } from "./go-usage.js";
import {
  recordAssistantDelta,
  recordAssistantMessage,
  recordStreamedAt,
  recordToolActivity,
  type MetricsState
} from "./metrics.js";
import { applySubagentEvent, type SubagentState } from "./subagents.js";

export type InsightState = {
  metrics: MetricsState;
  activity: ActivityState;
  subagents: SubagentState;
  goProviders: GoProviderTracker;
  copilotProviders: CopilotProviderTracker;
  stepStartedAt: Record<string, number>;
  stepUsageByMessage: Record<string, StepUsage | undefined>;
  toolNameById: Record<string, string>;
};

export type InsightEventResult = {
  metrics: boolean;
  activity: boolean;
  subagents: boolean;
  providers: boolean;
};

/** Per-step token totals accumulated across the steps of one assistant message. */
type StepUsage = {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
};

export function createInsightState(parts: {
  metrics: MetricsState;
  activity: ActivityState;
  subagents: SubagentState;
  goProviders: GoProviderTracker;
  copilotProviders: CopilotProviderTracker;
}): InsightState {
  return {
    ...parts,
    stepStartedAt: {},
    stepUsageByMessage: {},
    toolNameById: {}
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function tokenUsage(value: unknown): StepUsage | undefined {
  if (!isRecord(value)) return undefined;
  const cache = isRecord(value.cache) ? value.cache : {};
  const fields = {
    inputTokens: num(value.input),
    outputTokens: num(value.output),
    reasoningTokens: num(value.reasoning),
    cacheReadTokens: num(cache.read),
    cacheWriteTokens: num(cache.write)
  };
  if (Object.values(fields).every((item) => item === undefined)) return undefined;
  return {
    inputTokens: fields.inputTokens ?? 0,
    outputTokens: fields.outputTokens ?? 0,
    reasoningTokens: fields.reasoningTokens ?? 0,
    cacheReadTokens: fields.cacheReadTokens ?? 0,
    cacheWriteTokens: fields.cacheWriteTokens ?? 0
  };
}

function providerFrom(data: Record<string, unknown>): string | undefined {
  const model = isRecord(data.model) ? data.model : undefined;
  return model ? str(model.providerID) : undefined;
}

export function applyInsightEvent(state: InsightState, event: unknown): InsightEventResult {
  const result: InsightEventResult = { metrics: false, activity: false, subagents: false, providers: false };
  if (!isRecord(event)) return result;
  const type = str(event.type);
  if (!type) return result;
  const created = num(event.created) ?? Date.now();
  const data = isRecord(event.data) ? event.data : {};
  const sessionID = str(data.sessionID);
  const messageID = str(data.assistantMessageID);

  const recordProvider = (sessionKey: string | undefined, providerID: string | undefined) => {
    if (!sessionKey || !providerID) return;
    state.goProviders.record(sessionKey, providerID);
    state.copilotProviders.record(sessionKey, providerID);
    result.providers = true;
  };

  switch (type) {
    case "session.text.delta":
    case "session.reasoning.delta": {
      const delta = str(data.delta);
      if (!sessionID || !messageID || delta === undefined) break;
      recordAssistantDelta(state.metrics, { sessionID, messageID, delta, at: created });
      result.metrics = true;
      break;
    }
    case "session.step.streamed": {
      // Marks the end of the model's streaming window, which is the denominator
      // the native message header uses for its tok/s average.
      if (recordStreamedAt(state.metrics, messageID ?? "", created)) result.metrics = true;
      break;
    }
    case "session.step.started": {
      if (!sessionID || !messageID) break;
      const started = num(data.started) ?? created;
      state.stepStartedAt[messageID] = started;
      recordAssistantMessage(state.metrics, { sessionID, messageID, createdAt: started });
      recordProvider(sessionID, providerFrom(data));
      const stepID = str(event.id);
      if (stepID !== undefined && recordStep(state.activity, sessionID, stepID)) result.activity = true;
      result.metrics = true;
      break;
    }
    case "session.step.ended": {
      if (!sessionID || !messageID) break;
      const step = tokenUsage(data.tokens);
      if (step) {
        const previous = state.stepUsageByMessage[messageID];
        state.stepUsageByMessage[messageID] = {
          inputTokens: step.inputTokens,
          cacheReadTokens: step.cacheReadTokens,
          cacheWriteTokens: step.cacheWriteTokens,
          outputTokens: (previous?.outputTokens ?? 0) + step.outputTokens,
          reasoningTokens: (previous?.reasoningTokens ?? 0) + step.reasoningTokens
        };
      }
      const finish = str(data.finish);
      // In V2 a tool-call step is its own assistant message, so its usage must be
      // recorded here too; skipping it silently dropped most of a session's tokens.
      const usage: Partial<StepUsage> = state.stepUsageByMessage[messageID] ?? {};
      recordAssistantMessage(state.metrics, {
        sessionID,
        messageID,
        createdAt: state.stepStartedAt[messageID] ?? created,
        completedAt: created,
        ...(usage.inputTokens !== undefined ? { inputTokens: usage.inputTokens } : {}),
        ...(usage.outputTokens !== undefined ? { outputTokens: usage.outputTokens } : {}),
        ...(usage.reasoningTokens !== undefined ? { reasoningTokens: usage.reasoningTokens } : {}),
        ...(usage.cacheReadTokens !== undefined ? { cacheReadTokens: usage.cacheReadTokens } : {}),
        ...(usage.cacheWriteTokens !== undefined ? { cacheWriteTokens: usage.cacheWriteTokens } : {}),
        ...(finish !== undefined ? { finish } : {})
      });
      result.metrics = true;
      break;
    }
    case "session.tool.input.started": {
      const toolID = str(data.id);
      const name = str(data.name) ?? "tool";
      if (!sessionID || !toolID) break;
      state.toolNameById[toolID] = name;
      recordToolActivity(state.metrics, sessionID, messageID ?? "");
      if (recordToolPart(state.activity, sessionID, { id: toolID, tool: name, state: { status: "running" } })) {
        result.activity = true;
      }
      result.metrics = true;
      break;
    }
    case "session.tool.called":
    case "session.tool.success":
    case "session.tool.failed": {
      const toolID = str(data.id);
      if (!sessionID || !toolID) break;
      const name = state.toolNameById[toolID] ?? "tool";
      const error = isRecord(data.error) ? str(data.error.message) : undefined;
      const status = type === "session.tool.failed" ? "error" : type === "session.tool.success" ? "completed" : "running";
      // `session.tool.called` is the only tool event that carries the call's input,
      // and a skill hit is only readable from it (`input.name`).
      const input = isRecord(data.input) ? (data.input as { name?: string }) : undefined;
      recordToolActivity(state.metrics, sessionID, messageID ?? "");
      if (
        recordToolPart(state.activity, sessionID, {
          id: toolID,
          tool: name,
          state: {
            status,
            ...(input !== undefined ? { input } : {}),
            ...(error ? { error } : {})
          }
        })
      ) {
        result.activity = true;
      }
      result.metrics = true;
      break;
    }
    case "session.compaction.started": {
      const id = str(event.id);
      if (!sessionID || !id) break;
      if (recordCompaction(state.activity, sessionID, id, data.reason === "auto")) result.activity = true;
      break;
    }
    case "session.skill.activated": {
      const id = str(data.id);
      const name = str(data.name) ?? str(data.skill);
      if (!sessionID || !name) break;
      if (recordSkill(state.activity, sessionID, id, name)) result.activity = true;
      break;
    }
    case "session.created": {
      if (!sessionID) break;
      const parentID = str(data.parentID);
      const title = str(data.title);
      if (title) state.activity.titles[sessionID] = title;
      if (parentID) recordChild(state.activity, sessionID, parentID);
      recordProvider(sessionID, providerFrom(data));
      if (applySubagentEvent(state.subagents, event)) result.subagents = true;
      break;
    }
    case "session.renamed": {
      if (!sessionID) break;
      const title = str(data.title);
      if (title) state.activity.titles[sessionID] = title;
      if (applySubagentEvent(state.subagents, event)) result.subagents = true;
      break;
    }
    case "session.status":
    case "session.idle":
    case "session.execution.failed":
    case "session.usage.updated": {
      if (applySubagentEvent(state.subagents, event)) result.subagents = true;
      break;
    }
    case "session.model.selected": {
      recordProvider(sessionID, providerFrom(data));
      break;
    }
    default:
      break;
  }

  return result;
}
