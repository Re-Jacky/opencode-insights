/** @jsxImportSource @opentui/solid */
import { Plugin } from "@opencode/plugin/tui";
import type { Context } from "@opencode/plugin/tui/context";
import { createSignal, For } from "solid-js";
import { readInsightsConfig, resolveCopilotToken, type InsightsConfig } from "./capture.js";
import { createListenerRegistry } from "./listeners.js";
import { createMetricsState, recordAssistantDelta, recordAssistantMessage, recordToolActivity, renderPromptRightMetricsText, renderSessionTokenUsage, type MetricsState } from "./metrics.js";
import { applySubagentEvent, createSubagentState, getSubagentSidebarModel, sumSubagentTokens, type SubagentState } from "./subagents.js";
import { buildSessionAnalysisRows, createActivityState, formatActivityBriefRows, recordChild, recordCompaction, recordStep, recordToolPart, treeActivity, treeLoading, treeSubagentCount, type ActivityState } from "./activity.js";
import { hydrateActivity } from "./activity-hydrate.js";
import { createGoProviderTracker, createGoUsageRefresher, formatGoUsageRow, goUsageRows, goUsageSectionVisible } from "./go-usage.js";
import { copilotUsageRow, copilotUsageSectionVisible, createCopilotProviderTracker, createCopilotUsageRefresher, formatCopilotUsageRow } from "./copilot-usage.js";

const id = "opencode-insights-tui";
const isSessionID = (value: unknown): value is string => typeof value === "string" && value.startsWith("ses");

function TextSection(props: { title: string; lines: string[]; collapsed?: boolean; onClick?: () => void }) {
  const [collapsed, setCollapsed] = createSignal(props.collapsed ?? false);
  return (
    <box flexDirection="column" onMouseUp={() => { setCollapsed((value) => !value); props.onClick?.(); }}>
      <text fg="text" attributes={1}>{collapsed() ? "▶" : "▼"} {props.title}</text>
      <For each={collapsed() ? [] : props.lines}>{(line) => <text fg="textMuted">{line}</text>}</For>
    </box>
  );
}

function PromptRight(props: { context: Context; sessionID: string; metrics: MetricsState; config: InsightsConfig; subscribe: (listener: () => void) => () => void }) {
  const [, setVersion] = createSignal(0);
  props.subscribe(() => setVersion((value) => value + 1));
  const text = () => {
    if (!isSessionID(props.sessionID)) return "";
    return renderPromptRightMetricsText(props.metrics, props.sessionID, {
      idle: props.context.data.session.status(props.sessionID) === "idle",
      metrics: props.config.promptRightMetrics
    });
  };
  return <text fg="textMuted" height={text() ? 1 : 0}>{text()}</text>;
}

function SessionAnalysis(props: { context: Context; sessionID: string; activity: ActivityState; subscribe: (listener: () => void) => () => void; hydrate: () => void }) {
  const [, setVersion] = createSignal(0);
  props.subscribe(() => setVersion((value) => value + 1));
  props.hydrate();
  const tree = () => treeActivity(props.activity, props.sessionID);
  const lines = () => {
    const rows = formatActivityBriefRows(tree(), treeSubagentCount(props.activity, props.sessionID));
    return treeLoading(props.activity, props.sessionID) ? [...rows, "loading..."] : rows;
  };
  return <TextSection title="Session Analysis" lines={lines()} onClick={() => {
    void props.context.ui.dialog.show(() => <box flexDirection="column"><text fg="text" attributes={1}>Session Analysis</text><For each={buildSessionAnalysisRows(props.activity, props.sessionID)}>{(row) => <text fg={row.header ? "text" : "textMuted"}>{row.text}</text>}</For></box>);
  }} />;
}

function TokenUsage(props: { sessionID: string; metrics: MetricsState; subagents: SubagentState; subscribe: (listener: () => void) => () => void; hydrate: () => void }) {
  const [, setVersion] = createSignal(0);
  props.subscribe(() => setVersion((value) => value + 1));
  props.hydrate();
  const content = () => renderSessionTokenUsage(props.metrics, props.sessionID, sumSubagentTokens(props.subagents, props.sessionID));
  const [title, ...lines] = content().split("\n");
  return <TextSection title={title ?? "Token Usage"} lines={lines} />;
}

function Usage(props: { title: string; lines: string[]; error?: string | undefined }) {
  return <TextSection title={props.title} lines={props.error ? [props.error] : props.lines} />;
}

function Sidebar(props: { context: Context; sessionID: string; config: InsightsConfig; metrics: MetricsState; activity: ActivityState; subagents: SubagentState; subscribe: (listener: () => void) => () => void; hydrateMetrics: () => void; hydrateActivity: () => void; go: ReturnType<typeof createGoUsageRefresher>; goTracker: ReturnType<typeof createGoProviderTracker>; copilot: ReturnType<typeof createCopilotUsageRefresher>; copilotTracker: ReturnType<typeof createCopilotProviderTracker>; copilotToken: string }) {
  const [, setVersion] = createSignal(0);
  props.subscribe(() => setVersion((value) => value + 1));
  const goVisible = goUsageSectionVisible(props.config, props.goTracker.usesOpenCodeGo(props.sessionID));
  const copilotVisible = copilotUsageSectionVisible(props.config, props.copilotToken, props.copilotTracker.usesCopilot(props.sessionID));
  if (goVisible) void props.go.refresh();
  if (copilotVisible) void props.copilot.refresh();
  const goRows = goVisible ? goUsageRows(props.go.state, Date.now()) : undefined;
  const copilotRow = copilotVisible && props.copilot.state.data ? copilotUsageRow(props.copilot.state.data, Date.now()) : undefined;
  const hydrateMetrics = () => {
    for (const message of props.context.data.session.message.list(props.sessionID) as any[]) {
      const info = message.info ?? message;
      if (info.role !== "assistant" || typeof info.time?.completed !== "number") continue;
      recordAssistantMessage(props.metrics, {
        sessionID: info.sessionID ?? props.sessionID,
        messageID: info.id,
        createdAt: info.time.created,
        completedAt: info.time.completed,
        inputTokens: info.tokens?.input,
        outputTokens: info.tokens?.output,
        reasoningTokens: info.tokens?.reasoning,
        cacheReadTokens: info.tokens?.cache?.read,
        cacheWriteTokens: info.tokens?.cache?.write
      });
    }
  };
  hydrateMetrics();
  return <box flexDirection="column">
    <SessionAnalysis context={props.context} sessionID={props.sessionID} activity={props.activity} subscribe={props.subscribe} hydrate={props.hydrateActivity} />
    <TokenUsage sessionID={props.sessionID} metrics={props.metrics} subagents={props.subagents} subscribe={props.subscribe} hydrate={hydrateMetrics} />
    {goVisible ? <Usage title="Go Usage" lines={goRows?.map(formatGoUsageRow) ?? []} error={props.go.state.error} /> : null}
    {copilotVisible ? <Usage title="Copilot" lines={copilotRow ? formatCopilotUsageRow(copilotRow).split("\n") : []} error={props.copilot.state.error} /> : null}
    <Subagents sessionID={props.sessionID} state={props.subagents} context={props.context} subscribe={props.subscribe} />
  </box>;
}

function Subagents(props: { sessionID: string; state: SubagentState; context: Context; subscribe: (listener: () => void) => () => void }) {
  const [, setVersion] = createSignal(0);
  props.subscribe(() => setVersion((value) => value + 1));
  const model = () => getSubagentSidebarModel(props.state, props.sessionID);
  return model() ? <TextSection title={model()!.title} lines={[model()!.summary, ...model()!.rows.map((row) => `${row.title} ${row.subtitle}`)]} onClick={() => {
    const row = model()?.rows[0];
    if (row) props.context.ui.router.navigate({ type: "session", sessionID: row.id });
  }} /> : null;
}

const setup = async (context: Context) => {
  const config = await readInsightsConfig({ dataDir: typeof context.options.dataDir === "string" ? context.options.dataDir : undefined });
  const metrics = createMetricsState();
  const activity = createActivityState();
  const subagents = createSubagentState(activity);
  const metricListeners = createListenerRegistry();
  const activityListeners = createListenerRegistry();
  const subagentListeners = createListenerRegistry();
  const goListeners = createListenerRegistry();
  const copilotListeners = createListenerRegistry();
  const goTracker = createGoProviderTracker();
  const copilotTracker = createCopilotProviderTracker();
  const go = createGoUsageRefresher(config.goUsage);
  const copilotToken = resolveCopilotToken(config.copilotUsage);
  const copilot = createCopilotUsageRefresher(config.copilotUsage, copilotToken);
  const cleanups: Array<() => void> = [];
  cleanups.push(context.data.on("session.status", (_event) => {
    metricListeners.notify();
    subagentListeners.notify();
  }));
  cleanups.push(context.data.listen(({ details }) => {
    const event = details as { type: string; data?: Record<string, any> };
    const data = event.data ?? {};
    if (event.type === "session.text.delta" || event.type === "session.reasoning.delta") {
      recordAssistantDelta(metrics, { sessionID: data.sessionID, messageID: data.assistantMessageID, delta: data.delta, at: Date.now() });
      metricListeners.notify();
    } else if (event.type === "session.usage.updated") {
      const info = context.data.session.message.get(data.sessionID, data.assistantMessageID) as any;
      if (info?.role === "assistant") recordAssistantMessage(metrics, { sessionID: info.sessionID, messageID: info.id, createdAt: info.time.created, ...(typeof info.time.completed === "number" ? { completedAt: info.time.completed } : {}), inputTokens: info.tokens.input, outputTokens: info.tokens.output, reasoningTokens: info.tokens.reasoning, cacheReadTokens: info.tokens.cache.read, cacheWriteTokens: info.tokens.cache.write });
      metricListeners.notify();
    } else if (event.type === "session.tool.success" || event.type === "session.tool.failed") {
      const part = { id: data.id, sessionID: data.sessionID, messageID: data.assistantMessageID, type: "tool", tool: "tool", state: { status: event.type.endsWith("failed") ? "error" : "completed", error: event.type.endsWith("failed") ? String(data.error ?? "tool failed") : undefined } } as any;
      recordToolActivity(metrics, part.sessionID, part.messageID, Date.now());
      recordToolPart(activity, part.sessionID, part);
      metricListeners.notify();
      activityListeners.notify();
    } else if (event.type === "session.compaction.ended") {
      recordCompaction(activity, data.sessionID, data.id ?? details.id, data.auto === true);
      activityListeners.notify();
    } else if (event.type === "session.step.ended") {
      recordStep(activity, data.sessionID, data.id ?? details.id);
      activityListeners.notify();
    } else if (event.type === "session.created") {
      if (data.parentID) recordChild(activity, data.sessionID, data.parentID);
      if (data.title) activity.titles[data.sessionID] = data.title;
      activityListeners.notify();
    }
  }));
  const slotCleanups = [
    context.ui.slot({ append: "prompt.footer.status", render: (input: any) => <PromptRight context={context} sessionID={input.sessionID ?? ""} metrics={metrics} config={config} subscribe={metricListeners.subscribe} /> }),
    context.ui.slot({ append: "sidebar.content", render: (input: any) => <Sidebar context={context} sessionID={input.sessionID} config={config} metrics={metrics} activity={activity} subagents={subagents} subscribe={metricListeners.subscribe} hydrateMetrics={() => {}} hydrateActivity={() => void hydrateActivity({ session: { list: () => context.data.session.list() }, message: { list: (sessionID: string) => context.data.session.message.list(sessionID).map((message: any) => ({ parts: message.parts })) } }, activity, input.sessionID).then(() => activityListeners.notify())} go={go} goTracker={goTracker} copilot={copilot} copilotTracker={copilotTracker} copilotToken={copilotToken} /> })
  ];
  cleanups.push(...slotCleanups);
  const timers = [setInterval(() => { metricListeners.notify(); activityListeners.notify(); goListeners.notify(); copilotListeners.notify(); }, 1000)];
  let disposed = false;
  return async () => {
    if (disposed) return;
    disposed = true;
    for (const timer of timers) clearInterval(timer);
    for (const cleanup of cleanups) cleanup();
  };
};

export default Plugin.define({ id, setup });
