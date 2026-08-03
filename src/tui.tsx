/** @jsxImportSource @opentui/solid */
import { createTextAttributes, StyledText, type MouseEvent, type TextChunk, type TextRenderable } from "@opentui/core";
import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui";
import { createSignal, onCleanup } from "solid-js";
import { readInsightsConfig } from "./capture.js";
import {
  createMetricsState,
  recordAssistantDelta,
  recordAssistantMessage,
  recordToolActivity,
  renderPromptRightMetricsText
} from "./metrics.js";
import {
  applySubagentEvent,
  createSubagentState,
  getSubagentSidebarRowAtLine,
  getSubagentSidebarModel,
  type SubagentState
} from "./subagents.js";

type Listener = () => void;

function isSessionID(value: string | undefined): value is string {
  return typeof value === "string" && value.startsWith("ses");
}

function PromptRightMetrics(props: {
  api: TuiPluginApi;
  sessionID: string;
  text: () => string;
  subscribe: (listener: Listener) => () => void;
}) {
  let text: TextRenderable | undefined;

  const sync = () => {
    if (!text) return;
    const content = props.text();
    text.content = content;
    text.visible = content.length > 0;
    text.height = content.length > 0 ? 1 : 0;
    props.api.renderer.requestRender();
  };

  const unsubscribe = props.subscribe(sync);
  const timer = setInterval(sync, 1_000);
  onCleanup(() => {
    unsubscribe();
    clearInterval(timer);
  });

  return (
    <text
      ref={(ref: TextRenderable) => {
        text = ref;
        sync();
      }}
      fg={props.api.theme.current.textMuted}
      height={1}
      wrapMode="none"
      truncate
      overflow="hidden"
    >
      {props.text()}
    </text>
  );
}

function SubagentSidebar(props: {
  api: TuiPluginApi;
  sessionID: string;
  state: SubagentState;
  subscribe: (listener: Listener) => () => void;
}) {
  let text: TextRenderable | undefined;
  const [collapsed, setCollapsed] = createSignal(false);
  const [hoveredRowID, setHoveredRowID] = createSignal<string | undefined>();
  const titleAttributes = createTextAttributes({ bold: true });

  const toggle = (event: MouseEvent) => {
    if (!text || event.y !== text.y) return;
    setCollapsed((prev) => !prev);
    props.api.renderer.requestRender();
  };

  const openSubagent = (event: MouseEvent) => {
    if (!text || collapsed()) return;
    const model = getSubagentSidebarModel(props.state, props.sessionID);
    if (!model) return;
    const row = getSubagentSidebarRowAtLine(model, event.y - text.y);
    if (!row) return;
    props.api.route.navigate("session", { sessionID: row.id });
  };

  const hoverSubagent = (event: MouseEvent) => {
    if (!text || collapsed()) return;
    const model = getSubagentSidebarModel(props.state, props.sessionID);
    const row = model && getSubagentSidebarRowAtLine(model, event.y - text.y);
    const nextRowID = row?.id;
    if (nextRowID === hoveredRowID()) return;
    setHoveredRowID(nextRowID);
    sync();
  };

  const clearHoveredSubagent = () => {
    if (!hoveredRowID()) return;
    setHoveredRowID(undefined);
    sync();
  };

  const sync = () => {
    if (!text) return;
    const model = getSubagentSidebarModel(props.state, props.sessionID);
    text.visible = !!model;
    text.height = model ? "auto" : 0;
    text.content = model
      ? renderSubagentStyledSidebar(props.state, props.sessionID, props.api, titleAttributes, collapsed(), hoveredRowID())
      : "";
    props.api.renderer.requestRender();
  };

  const unsubscribe = props.subscribe(sync);
  const timer = setInterval(sync, 1_000);
  onCleanup(() => {
    unsubscribe();
    clearInterval(timer);
  });

  return (
    <text
      ref={(ref: TextRenderable) => {
        text = ref;
        sync();
      }}
      onMouseDown={toggle}
      onMouseUp={openSubagent}
      onMouseMove={hoverSubagent}
      onMouseOut={clearHoveredSubagent}
      fg={props.api.theme.current.textMuted}
    >
      {""}
    </text>
  );
}

function renderSubagentStyledSidebar(
  state: SubagentState,
  sessionID: string,
  api: TuiPluginApi,
  titleAttributes: number,
  collapsed: boolean,
  hoveredRowID?: string
) {
  const model = getSubagentSidebarModel(state, sessionID);
  if (!model) return "";

  const indicator = collapsed ? "▶ " : "▼ ";
  const chunks: TextChunk[] = [
    textChunk(`${indicator}${model.title}\n`, api.theme.current.text, titleAttributes),
    textChunk(`${model.summary}\n`, api.theme.current.textMuted)
  ];

  if (!collapsed) {
    for (const [index, row] of model.rows.entries()) {
      if (index > 0) chunks.push(textChunk("\n"));
      const dotColor = row.status === "running"
        ? api.theme.current.success
        : row.status === "error"
          ? api.theme.current.error
          : api.theme.current.textMuted;
      const background = row.id === hoveredRowID ? api.theme.current.backgroundElement : undefined;
      chunks.push(textChunk("• ", dotColor, undefined, background));
      chunks.push(textChunk(`${row.title}\n`, api.theme.current.text, undefined, background));
      chunks.push(textChunk(row.subtitle, api.theme.current.textMuted, undefined, background));
    }
  }

  return new StyledText(chunks);
}

function textChunk(text: string, fg?: TextChunk["fg"], attributes?: number, bg?: TextChunk["bg"]): TextChunk {
  return {
    __isChunk: true,
    text,
    ...(fg === undefined ? {} : { fg }),
    ...(attributes === undefined ? {} : { attributes }),
    ...(bg === undefined ? {} : { bg })
  };
}

const tui: TuiPlugin = async (api, options) => {
  const config = await readInsightsConfig(options ?? {});
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
    if (applySubagentEvent(subagents, evt)) bump();
    if (info.role !== "assistant") return;

    const messageInput: {
      sessionID: string;
      messageID: string;
      createdAt: number;
      completedAt?: number;
      outputTokens?: number;
      reasoningTokens?: number;
      inputTokens?: number;
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
      finish?: string;
    } = {
      sessionID: info.sessionID ?? evt.properties.sessionID,
      messageID: info.id,
      createdAt: info.time.created,
      inputTokens: info.tokens.input,
      outputTokens: info.tokens.output,
      reasoningTokens: info.tokens.reasoning,
      cacheReadTokens: info.tokens.cache?.read,
      cacheWriteTokens: info.tokens.cache?.write
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

  const offSessionCreated = api.event.on("session.created", (evt) => {
    if (applySubagentEvent(subagents, evt)) bump();
  });

  const offSessionUpdated = api.event.on("session.updated", (evt) => {
    if (applySubagentEvent(subagents, evt)) bump();
  });

  const offSessionStatus = api.event.on("session.status", (evt) => {
    if (applySubagentEvent(subagents, evt)) bump();
  });

  const offSessionIdle = api.event.on("session.idle", (evt) => {
    if (applySubagentEvent(subagents, evt)) bump();
  });

  const offSessionError = api.event.on("session.error", (evt) => {
    if (applySubagentEvent(subagents, evt)) bump();
  });

  const offSlots = api.slots.register({
    slots: {
      session_prompt_right: (_ctx, props) => (
        <PromptRightMetrics
          api={api}
          sessionID={props.session_id}
          subscribe={subscribe}
          text={() => {
            if (!isSessionID(props.session_id)) return "";
            const status = api.state.session.status(props.session_id);
            return renderPromptRightMetricsText(metrics, props.session_id, {
              idle: status?.type === "idle",
              metrics: config.promptRightMetrics
            });
          }}
        />
      ),
      sidebar_content: (_ctx, props) => (
        <SubagentSidebar
          api={api}
          sessionID={props.session_id}
          state={subagents}
          subscribe={subscribe}
        />
      )
    }
  });

  api.lifecycle.onDispose(() => {
    offDelta();
    offMessage();
    offPart();
    offSessionCreated();
    offSessionUpdated();
    offSessionStatus();
    offSessionIdle();
    offSessionError();
  });
};

const id = "opencode-insights-tui";

export { id, tui };
export default { id, tui } satisfies TuiPluginModule;
