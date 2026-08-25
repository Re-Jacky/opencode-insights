/** @jsxImportSource @opentui/solid */
import { createTextAttributes, StyledText, type MouseEvent, type TextChunk, type TextRenderable } from "@opentui/core";
import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui";
import { createSignal, For, onCleanup, onMount } from "solid-js";
import { readInsightsConfig, resolveCopilotToken, type InsightsConfig } from "./capture.js";
import { createListenerRegistry, type Listener } from "./listeners.js";
import { hasRenderStateChanged } from "./render-state.js";
import {
  createGoProviderTracker,
  createGoUsageRefresher,
  formatGoUsageRow,
  goUsageRows,
  goUsageSectionVisible,
  type GoUsageRow,
  type GoUsageState
} from "./go-usage.js";
import {
  copilotUsageRow,
  copilotUsageSectionVisible,
  createCopilotProviderTracker,
  createCopilotUsageRefresher,
  formatCopilotUsageRow,
  type CopilotUsageRow,
  type CopilotUsageState
} from "./copilot-usage.js";
import {
  createMetricsState,
  recordAssistantDelta,
  recordAssistantMessage,
  recordToolActivity,
  renderPromptRightMetricsText,
  renderSessionTokenUsage,
  type MetricsState
} from "./metrics.js";
import {
  applySubagentEvent,
  createSubagentState,
  getSubagentSidebarRowAtLine,
  getSubagentSidebarModel,
  sumSubagentTokens,
  type SubagentState
} from "./subagents.js";
import {
  buildSessionAnalysisRows,
  createActivityState,
  formatActivityBriefRows,
  recordChild,
  recordCompaction,
  recordStep,
  recordToolPart,
  treeActivity,
  treeLoading,
  treeSubagentCount,
  type ActivityState,
  type SessionAnalysisRow
} from "./activity.js";
import { hydrateActivity, type ActivityClient } from "./activity-hydrate.js";
import { useTerminalDimensions } from "@opentui/solid";

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
  let previous: { content: string; visible: boolean; height: number | string } | undefined;

  const sync = () => {
    if (!text) return;
    const content = props.text();
    const next = { content, visible: content.length > 0, height: content.length > 0 ? 1 : 0 };
    if (!hasRenderStateChanged(previous, next)) return;
    previous = next;
    text.content = next.content;
    text.visible = next.visible;
    text.height = next.height;
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

function TokenUsageSidebar(props: {
  api: TuiPluginApi;
  sessionID: string;
  state: MetricsState;
  subagentState: SubagentState;
  subscribe: (listener: Listener) => () => void;
  hydrate: () => void;
}) {
  let text: TextRenderable | undefined;
  let previous: { content: string; visible: boolean; height: number | string } | undefined;
  const [collapsed, setCollapsed] = createSignal(false);
  const titleAttributes = createTextAttributes({ bold: true });

  const toggleTokenUsage = (event: MouseEvent) => {
    if (!text || event.y !== text.y) return;
    setCollapsed((prev) => !prev);
    sync();
  };

  const sync = () => {
    if (!text) return;
    const subagentTokens = sumSubagentTokens(props.subagentState, props.sessionID);
    const content = renderSessionTokenUsage(props.state, props.sessionID, subagentTokens);
    const next: { content: string; visible: boolean; height: number | "auto" } = {
      content: `${collapsed()}|${content}`,
      visible: content.length > 0,
      height: content.length > 0 ? "auto" : 0
    };
    if (!hasRenderStateChanged(previous, next)) return;
    previous = next;
    text.visible = next.visible;
    text.height = next.height;
    text.content = content ? renderTokenUsageSidebar(content, props.api, titleAttributes, collapsed()) : "";
    props.api.renderer.requestRender();
  };

  const unsubscribe = props.subscribe(sync);
  onCleanup(unsubscribe);
  props.hydrate();

  return (
    <text
      ref={(ref: TextRenderable) => {
        text = ref;
        sync();
      }}
      onMouseDown={toggleTokenUsage}
      fg={props.api.theme.current.textMuted}
    >
      {""}
    </text>
  );
}

function GoUsageSidebar(props: {
  api: TuiPluginApi;
  state: GoUsageState;
  config: InsightsConfig;
  tracker: ReturnType<typeof createGoProviderTracker>;
  sessionID: string;
  subscribe: (listener: Listener) => () => void;
  goUsageSubscribe: (listener: Listener) => () => void;
  refresh: () => void;
}) {
  let text: TextRenderable | undefined;
  const [collapsed, setCollapsed] = createSignal(false);
  const titleAttributes = createTextAttributes({ bold: true });
  let previous: { content: string; visible: boolean; height: number | string } | undefined;

  const toggle = (event: MouseEvent) => {
    if (!text || event.y !== text.y) return;
    setCollapsed((prev) => !prev);
    sync();
  };

  const sync = () => {
    if (!text) return;
    const visible = goUsageSectionVisible(props.config, props.tracker.usesOpenCodeGo(props.sessionID));
    if (visible) props.refresh();
    const rows = visible ? goUsageRows(props.state, Date.now()) : undefined;
    const error = props.state.error;
    const showContent = visible && (rows || error);
    const signature = showContent ? JSON.stringify({ collapsed: collapsed(), rows, error }) : "";
    const next: { content: string; visible: boolean; height: number | "auto" } = {
      content: signature,
      visible: signature.length > 0,
      height: signature.length > 0 ? "auto" : 0
    };
    if (!hasRenderStateChanged(previous, next)) return;
    previous = next;
    text.visible = next.visible;
    text.height = next.height;
    text.content = showContent ? renderGoUsageSidebar(rows, error, props.api, titleAttributes, collapsed()) : "";
    props.api.renderer.requestRender();
  };

  const unsubscribe = props.subscribe(sync);
  const unsubscribeGoUsage = props.goUsageSubscribe(sync);
  const timer = setInterval(sync, 1_000);
  onCleanup(() => {
    unsubscribe();
    unsubscribeGoUsage();
    clearInterval(timer);
  });

  return (
    <text
      ref={(ref: TextRenderable) => {
        text = ref;
        sync();
      }}
      onMouseDown={toggle}
      fg={props.api.theme.current.textMuted}
    >
      {""}
    </text>
  );
}

function renderGoUsageSidebar(
  rows: GoUsageRow[] | undefined,
  error: string | undefined,
  api: TuiPluginApi,
  titleAttributes: number,
  collapsed: boolean
) {
  const chunks: TextChunk[] = [
    textChunk(`${collapsed ? "▶" : "▼"} Go Usage\n`, api.theme.current.text, titleAttributes)
  ];
  if (!collapsed) {
    if (rows && rows.length > 0) {
      for (const [index, row] of rows.entries()) {
        if (index > 0) chunks.push(textChunk("\n"));
        chunks.push(textChunk(formatGoUsageRow(row), api.theme.current.textMuted));
      }
    } else if (error) {
      chunks.push(textChunk(`Go usage: ${error}`, api.theme.current.error));
    }
  }
  return new StyledText(chunks);
}

function CopilotUsageSidebar(props: {
  api: TuiPluginApi;
  state: CopilotUsageState;
  config: InsightsConfig;
  token: string;
  tracker: ReturnType<typeof createCopilotProviderTracker>;
  sessionID: string;
  subscribe: (listener: Listener) => () => void;
  copilotUsageSubscribe: (listener: Listener) => () => void;
  refresh: () => void;
}) {
  let text: TextRenderable | undefined;
  const [collapsed, setCollapsed] = createSignal(false);
  const titleAttributes = createTextAttributes({ bold: true });
  let previous: { content: string; visible: boolean; height: number | string } | undefined;

  const toggle = (event: MouseEvent) => {
    if (!text || event.y !== text.y) return;
    setCollapsed((prev) => !prev);
    sync();
  };

  const sync = () => {
    if (!text) return;
    const visible = copilotUsageSectionVisible(props.config, props.token, props.tracker.usesCopilot(props.sessionID));
    if (visible) props.refresh();
    const row = visible ? copilotUsageRow(props.state.data ?? ({} as never), Date.now()) : undefined;
    const error = props.state.error;
    const showContent = visible && (row || error);
    const signature = showContent ? JSON.stringify({ collapsed: collapsed(), row, error }) : "";
    const next: { content: string; visible: boolean; height: number | "auto" } = {
      content: signature,
      visible: signature.length > 0,
      height: signature.length > 0 ? "auto" : 0
    };
    if (!hasRenderStateChanged(previous, next)) return;
    previous = next;
    text.visible = next.visible;
    text.height = next.height;
    text.content = showContent ? renderCopilotUsageSidebar(row, error, props.api, titleAttributes, collapsed()) : "";
    props.api.renderer.requestRender();
  };

  const unsubscribe = props.subscribe(sync);
  const unsubscribeCopilot = props.copilotUsageSubscribe(sync);
  const timer = setInterval(sync, 1_000);
  onCleanup(() => {
    unsubscribe();
    unsubscribeCopilot();
    clearInterval(timer);
  });

  return (
    <text
      ref={(ref: TextRenderable) => {
        text = ref;
        sync();
      }}
      onMouseDown={toggle}
      fg={props.api.theme.current.textMuted}
    >
      {""}
    </text>
  );
}

function renderCopilotUsageSidebar(
  row: CopilotUsageRow | undefined,
  error: string | undefined,
  api: TuiPluginApi,
  titleAttributes: number,
  collapsed: boolean
) {
  const chunks: TextChunk[] = [
    textChunk(`${collapsed ? "▶" : "▼"} Copilot\n`, api.theme.current.text, titleAttributes)
  ];
  if (!collapsed) {
    if (row) {
      const lines = formatCopilotUsageRow(row).split("\n");
      for (const [index, line] of lines.entries()) {
        if (index > 0) chunks.push(textChunk("\n"));
        chunks.push(textChunk(line, api.theme.current.textMuted));
      }
    } else if (error) {
      chunks.push(textChunk(`Copilot: ${error}`, api.theme.current.error));
    }
  }
  return new StyledText(chunks);
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
  let previous: { content: string; visible: boolean; height: number | string } | undefined;

  const toggle = (event: MouseEvent) => {
    if (!text || event.y !== text.y) return;
    setCollapsed((prev) => !prev);
    sync();
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
    const content = model
      ? renderSubagentStyledSidebar(model, props.api, titleAttributes, collapsed(), hoveredRowID())
      : "";
    const next: { content: string; visible: boolean; height: number | "auto" } = {
      content: model ? contentSignature(model, collapsed(), hoveredRowID()) : "",
      visible: !!model,
      height: model ? "auto" : 0
    };
    if (!hasRenderStateChanged(previous, next)) return;
    previous = next;
    text.visible = next.visible;
    text.height = next.height;
    text.content = model ? content : "";
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
  model: NonNullable<ReturnType<typeof getSubagentSidebarModel>>,
  api: TuiPluginApi,
  titleAttributes: number,
  collapsed: boolean,
  hoveredRowID?: string
) {
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

function renderSessionAnalysisSidebar(lines: string[], api: TuiPluginApi, titleAttributes: number) {
  const chunks: TextChunk[] = [
    textChunk(`Session Analysis\n`, api.theme.current.text, titleAttributes),
    ...lines.flatMap((line, index) => [
      ...(index > 0 ? [textChunk("\n")] : []),
      textChunk(line, api.theme.current.textMuted)
    ])
  ];
  return new StyledText(chunks);
}

function SessionAnalysisDialog(props: {
  api: TuiPluginApi;
  state: ActivityState;
  rootSessionID: string;
}) {
  const dimensions = useTerminalDimensions();
  const titleAttributes = createTextAttributes({ bold: true });
  const [collapsedSections, setCollapsedSections] = createSignal<Set<string>>(new Set());
  const rows = buildSessionAnalysisRows(props.state, props.rootSessionID);
  const loading = treeLoading(props.state, props.rootSessionID);
  const maxHeight = Math.max(4, Math.floor(dimensions().height / 2) - 6);
  onMount(() => props.api.ui.dialog.setSize("large"));

  const toggleSection = (header: string) => {
    setCollapsedSections((previous) => {
      const next = new Set(previous);
      if (next.has(header)) next.delete(header);
      else next.add(header);
      return next;
    });
  };

  const visibleRows: SessionAnalysisRow[] = [];
  let currentHeader: string | undefined;
  for (const row of rows) {
    if (row.header) {
      currentHeader = row.text;
      visibleRows.push({ text: `${collapsedSections().has(row.text) ? "▶" : "▾"} ${row.text}`, header: true, key: row.text });
    } else if (currentHeader === undefined || !collapsedSections().has(currentHeader)) {
      visibleRows.push(row);
    }
  }

  return (
    <box flexDirection="column" flexGrow={1} paddingLeft={4} paddingRight={4} paddingTop={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text fg={props.api.theme.current.text} attributes={titleAttributes}>
          {"Session Analysis"}
        </text>
        <text fg={props.api.theme.current.textMuted} onMouseUp={() => props.api.ui.dialog.clear()}>
          esc
        </text>
      </box>
      <scrollbox
        maxHeight={maxHeight}
        flexGrow={1}
        paddingTop={1}
      >
        <For each={visibleRows}>
          {(row) => (
            <text
              fg={row.header ? props.api.theme.current.text : props.api.theme.current.textMuted}
              {...(row.header ? { attributes: titleAttributes } : {})}
              {...(row.header && row.key ? { onMouseUp: () => toggleSection(row.key ?? "") } : {})}
            >
              {row.text}
            </text>
          )}
        </For>
        <For each={loading ? [true] : []}>
          {() => <text fg={props.api.theme.current.textMuted}>loading…</text>}
        </For>
      </scrollbox>
    </box>
  );
}

function SessionAnalysisSidebar(props: {
  api: TuiPluginApi;
  sessionID: string;
  state: ActivityState;
  subscribe: (listener: Listener) => () => void;
  hydrate: () => void;
}) {
  let text: TextRenderable | undefined;
  const titleAttributes = createTextAttributes({ bold: true });
  let previous: { content: string; visible: boolean; height: number | string } | undefined;

  const openDialog = (event: MouseEvent) => {
    if (!text) return;
    props.api.ui.dialog.replace(() => (
      <SessionAnalysisDialog api={props.api} state={props.state} rootSessionID={props.sessionID} />
    ));
  };

  const sync = () => {
    if (!text) return;
    const tree = treeActivity(props.state, props.sessionID);
    const loading = treeLoading(props.state, props.sessionID);
    const rows = formatActivityBriefRows(tree, treeSubagentCount(props.state, props.sessionID));
    const lines = loading ? (rows.length > 0 ? [...rows, "loading…"] : ["loading…"]) : rows;
    const visible = lines.length > 0;
    const content = lines.join("\n");
    const next: { content: string; visible: boolean; height: number | "auto" } = {
      content,
      visible,
      height: visible ? "auto" : 0
    };
    if (!hasRenderStateChanged(previous, next)) return;
    previous = next;
    text.visible = next.visible;
    text.height = next.height;
    text.content = visible ? renderSessionAnalysisSidebar(lines, props.api, titleAttributes) : "";
    props.api.renderer.requestRender();
  };

  const unsubscribe = props.subscribe(sync);
  const timer = setInterval(sync, 1_000);
  onCleanup(() => {
    unsubscribe();
    clearInterval(timer);
  });
  props.hydrate();

  return (
    <text
      ref={(ref: TextRenderable) => {
        text = ref;
        sync();
      }}
      onMouseUp={openDialog}
      fg={props.api.theme.current.textMuted}
    >
      {""}
    </text>
  );
}

function renderTokenUsageSidebar(content: string, api: TuiPluginApi, titleAttributes: number, collapsed: boolean) {
  const [title, ...details] = content.split("\n");
  const visibleDetails = collapsed ? details.slice(0, 1) : details;
  return new StyledText([
    textChunk(`${collapsed ? "▶" : "▼"} ${title}\n`, api.theme.current.text, titleAttributes),
    textChunk(visibleDetails.join("\n"), api.theme.current.textMuted)
  ]);
}

function contentSignature(model: NonNullable<ReturnType<typeof getSubagentSidebarModel>>, collapsed: boolean, hoveredRowID?: string) {
  return JSON.stringify({ collapsed, hoveredRowID, title: model.title, summary: model.summary, rows: model.rows });
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
  const activity = createActivityState();
  const activityListeners = createListenerRegistry();
  const subagents = createSubagentState(activity);
  const metricListeners = createListenerRegistry();
  const subagentListeners = createListenerRegistry();
  const goUsageListeners = createListenerRegistry();
  const copilotUsageListeners = createListenerRegistry();
  const hydratedSessions = new Set<string>();
  const goProviderTracker = createGoProviderTracker();
  const copilotProviderTracker = createCopilotProviderTracker();
  const goUsage = createGoUsageRefresher(config.goUsage);
  const copilotToken = resolveCopilotToken(config.copilotUsage);
  const copilotUsage = createCopilotUsageRefresher(config.copilotUsage, copilotToken);

  const refreshGoUsage = async () => {
    if (await goUsage.refresh()) goUsageListeners.notify();
  };

  const refreshCopilotUsage = async () => {
    if (await copilotUsage.refresh()) copilotUsageListeners.notify();
  };

  const hydrateSessionMetrics = async (sessionID: string) => {
    if (!isSessionID(sessionID) || hydratedSessions.has(sessionID)) return;
    hydratedSessions.add(sessionID);

    try {
      const response = await api.client.session.messages({ sessionID });
      const messages = response.data ?? [];
      for (const message of messages) {
        const info = message.info;
        const providerID = (info as { providerID?: unknown }).providerID;
        goProviderTracker.record(sessionID, typeof providerID === "string" ? providerID : undefined);
        copilotProviderTracker.record(sessionID, typeof providerID === "string" ? providerID : undefined);
        if (info.role !== "assistant" || typeof info.time.completed !== "number") continue;
        const input = {
          sessionID: info.sessionID,
          messageID: info.id,
          createdAt: info.time.created,
          completedAt: info.time.completed,
          inputTokens: info.tokens.input,
          outputTokens: info.tokens.output,
          reasoningTokens: info.tokens.reasoning,
          cacheReadTokens: info.tokens.cache.read,
          cacheWriteTokens: info.tokens.cache.write
        };
        recordAssistantMessage(metrics, typeof info.finish === "string" ? { ...input, finish: info.finish } : input);
      }
      metricListeners.notify();
    } catch {
      hydratedSessions.delete(sessionID);
    }
  };

  const offDelta = api.event.on("message.part.delta", (evt) => {
    if (evt.properties.field !== "text") return;
    recordAssistantDelta(metrics, {
      sessionID: evt.properties.sessionID,
      messageID: evt.properties.messageID,
      delta: evt.properties.delta,
      at: Date.now()
    });
    metricListeners.notify();
  });

  const offMessage = api.event.on("message.updated", (evt) => {
    const info = evt.properties.info;
    if (applySubagentEvent(subagents, evt)) subagentListeners.notify();
    const sessionID = info.sessionID ?? evt.properties.sessionID;
    const providerID =
      (info as { providerID?: unknown }).providerID ?? (info as { model?: { providerID?: unknown } }).model?.providerID;
    goProviderTracker.record(sessionID, typeof providerID === "string" ? providerID : undefined);
    copilotProviderTracker.record(sessionID, typeof providerID === "string" ? providerID : undefined);
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
    metricListeners.notify();
  });

  const offPart = api.event.on("message.part.updated", (evt) => {
    const part = evt.properties.part;
    const sessionID = part.sessionID ?? evt.properties.sessionID;
    if (part.type === "tool") {
      recordToolActivity(metrics, sessionID, part.messageID, Date.now());
      recordToolPart(activity, sessionID, part);
    } else if (part.type === "compaction") {
      recordCompaction(activity, sessionID, part.id, part.auto === true);
    } else if (part.type === "step-finish") {
      recordStep(activity, sessionID, part.id);
    }
    if (applySubagentEvent(subagents, evt)) subagentListeners.notify();
    metricListeners.notify();
    activityListeners.notify();
  });

  const offSessionCreated = api.event.on("session.created", (evt) => {
    if (applySubagentEvent(subagents, evt)) subagentListeners.notify();
    const info = evt.properties.info as { id?: unknown; parentID?: unknown; title?: unknown } | undefined;
    if (info && typeof info.id === "string") {
      if (typeof info.title === "string") activity.titles[info.id] = info.title;
      if (typeof info.parentID === "string") recordChild(activity, info.id, info.parentID);
      activityListeners.notify();
    }
  });

  const offSessionUpdated = api.event.on("session.updated", (evt) => {
    if (applySubagentEvent(subagents, evt)) subagentListeners.notify();
    const info = evt.properties.info as { id?: unknown; parentID?: unknown; title?: unknown; model?: { providerID?: unknown } } | undefined;
    const sessionID = typeof info?.id === "string" ? info.id : undefined;
    if (sessionID) {
      if (typeof info?.title === "string") activity.titles[sessionID] = info.title;
      if (typeof info?.parentID === "string") recordChild(activity, sessionID, info.parentID);
      activityListeners.notify();
    }
    const providerID = info?.model?.providerID;
    if (sessionID && typeof providerID === "string") {
      goProviderTracker.record(sessionID, providerID);
      metricListeners.notify();
    }
  });

  const offSessionStatus = api.event.on("session.status", (evt) => {
    if (applySubagentEvent(subagents, evt)) subagentListeners.notify();
  });

  const offSessionIdle = api.event.on("session.idle", (evt) => {
    if (applySubagentEvent(subagents, evt)) subagentListeners.notify();
  });

  const offSessionError = api.event.on("session.error", (evt) => {
    if (applySubagentEvent(subagents, evt)) subagentListeners.notify();
  });

  const offSlots = api.slots.register({
    slots: {
      session_prompt_right: (_ctx, props) => (
        <PromptRightMetrics
          api={api}
          sessionID={props.session_id}
          subscribe={metricListeners.subscribe}
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
        <>
          <SessionAnalysisSidebar
            api={api}
            sessionID={props.session_id}
            state={activity}
            subscribe={activityListeners.subscribe}
            hydrate={() => void hydrateActivity(api.client as unknown as ActivityClient, activity, props.session_id).then(() => activityListeners.notify())}
          />
          <TokenUsageSidebar
            api={api}
            sessionID={props.session_id}
            state={metrics}
            subagentState={subagents}
            subscribe={metricListeners.subscribe}
            hydrate={() => void hydrateSessionMetrics(props.session_id)}
          />
          <GoUsageSidebar
            api={api}
            state={goUsage.state}
            config={config}
            tracker={goProviderTracker}
            sessionID={props.session_id}
            subscribe={metricListeners.subscribe}
            goUsageSubscribe={goUsageListeners.subscribe}
            refresh={() => void refreshGoUsage()}
          />
          <CopilotUsageSidebar
            api={api}
            state={copilotUsage.state}
            config={config}
            token={copilotToken}
            tracker={copilotProviderTracker}
            sessionID={props.session_id}
            subscribe={metricListeners.subscribe}
            copilotUsageSubscribe={copilotUsageListeners.subscribe}
            refresh={() => void refreshCopilotUsage()}
          />
          <SubagentSidebar
            api={api}
            sessionID={props.session_id}
            state={subagents}
            subscribe={subagentListeners.subscribe}
          />
        </>
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
