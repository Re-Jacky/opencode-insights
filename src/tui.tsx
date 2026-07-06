/** @jsxImportSource @opentui/solid */
import type { TextRenderable } from "@opentui/core";
import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui";
import { onCleanup } from "solid-js";
import {
  createMetricsState,
  recordAssistantDelta,
  recordAssistantMessage,
  recordToolActivity,
  renderMetricsText
} from "./metrics.js";
import { applySubagentEvent, createSubagentState, renderSubagentStatus } from "./subagents.js";

type Listener = () => void;

function PromptRight(props: {
  api: TuiPluginApi;
  sessionID: string;
  text: () => string;
  subscribe: (listener: Listener) => () => void;
}) {
  let text: TextRenderable | undefined;

  const sync = () => {
    if (!text) return;
    text.content = props.text();
    props.api.renderer.requestRender();
  };

  const unsubscribe = props.subscribe(sync);
  onCleanup(unsubscribe);

  return (
    <text
      ref={(ref: TextRenderable) => {
        text = ref;
        sync();
      }}
      fg={props.api.theme.current.textMuted}
    >
      {props.text()}
    </text>
  );
}

const tui: TuiPlugin = async (api) => {
  const metrics = createMetricsState();
  const subagents = createSubagentState();
  const listeners = new Set<Listener>();
  const bump = () => {
    for (const listener of listeners) listener();
  };
  const subscribe = (listener: Listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };

  const offDelta = api.event.on("message.part.delta", (evt) => {
    if (evt.properties.field !== "text") return;
    recordAssistantDelta(metrics, {
      sessionID: evt.properties.sessionID,
      messageID: evt.properties.messageID,
      delta: evt.properties.delta,
      at: Date.now()
    });
    bump();
  });

  const offMessage = api.event.on("message.updated", (evt) => {
    const info = evt.properties.info;
    if (info.role !== "assistant") {
      applySubagentEvent(subagents, evt);
      bump();
      return;
    }

    const messageInput: {
      sessionID: string;
      messageID: string;
      createdAt: number;
      completedAt?: number;
      outputTokens?: number;
      reasoningTokens?: number;
      finish?: string;
    } = {
      sessionID: info.sessionID ?? evt.properties.sessionID,
      messageID: info.id,
      createdAt: info.time.created,
      outputTokens: info.tokens.output,
      reasoningTokens: info.tokens.reasoning
    };
    if (typeof info.time.completed === "number") messageInput.completedAt = info.time.completed;
    if (typeof info.finish === "string") messageInput.finish = info.finish;
    recordAssistantMessage(metrics, messageInput);
    bump();
  });

  const offPart = api.event.on("message.part.updated", (evt) => {
    const part = evt.properties.part;
    if (part.type === "tool") {
      recordToolActivity(metrics, part.sessionID ?? evt.properties.sessionID, part.messageID, Date.now());
    }
    applySubagentEvent(subagents, evt);
    bump();
  });

  const offSlots = api.slots.register({
    slots: {
      session_prompt_right: (_ctx, props) => (
        <PromptRight
          api={api}
          sessionID={props.session_id}
          subscribe={subscribe}
          text={() => {
            const status = api.state.session.status(props.session_id);
            const metricText = renderMetricsText(metrics, props.session_id, { idle: status?.type === "idle" });
            return `${metricText} | ${renderSubagentStatus(subagents)}`;
          }}
        />
      ),
      home_prompt_right: () => (
        <PromptRight
          api={api}
          sessionID=""
          subscribe={subscribe}
          text={() => renderSubagentStatus(subagents)}
        />
      )
    }
  });

  api.lifecycle.onDispose(() => {
    offDelta();
    offMessage();
    offPart();
  });
};

export default tui;
