/** @jsxImportSource @opentui/solid */
import { Plugin } from "@opencode/plugin/tui";
import type { Context, SlotMap } from "@opencode/plugin/tui/context";
import { createEffect, createSignal, For, onCleanup } from "solid-js";
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

type V2Data = Record<string, unknown>;

function isRecord(value: unknown): value is V2Data {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function textFromToolContent(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  const text = value
    .filter(isRecord)
    .map((item) => stringValue(item.text))
    .filter((item): item is string => item !== undefined)
    .join("\n");
  return text || undefined;
}

function errorMessage(value: unknown): string | undefined {
  if (isRecord(value)) return stringValue(value.message);
  return stringValue(value);
}

function providerIDFromModel(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  return stringValue(value.providerID) ?? stringValue(value.providerId);
}

type SemanticTheme = Context["theme"];

function TextSection(props: { title: string | (() => string); lines: () => string[]; theme: SemanticTheme; collapsed?: boolean; onClick?: () => void }) {
  const [collapsed, setCollapsed] = createSignal(props.collapsed ?? false);
  return (
    <box flexDirection="column" onMouseUp={() => { setCollapsed((value) => !value); props.onClick?.(); }}>
      <text fg={props.theme.text} attributes={1}>{collapsed() ? "▶" : "▼"} {typeof props.title === "function" ? props.title() : props.title}</text>
      <For each={collapsed() ? [] : props.lines()}>{(line) => <text fg={props.theme.textMuted}>{line}</text>}</For>
    </box>
  );
}

function PromptRight(props: { context: Context; sessionID: () => string; metrics: MetricsState; config: InsightsConfig; subscribe: (listener: () => void) => () => void }) {
  const [version, setVersion] = createSignal(0);
  props.subscribe(() => setVersion((value) => value + 1));
  const text = () => {
    version();
    const sessionID = props.sessionID();
    if (!isSessionID(sessionID)) return "";
    return renderPromptRightMetricsText(props.metrics, sessionID, {
      idle: props.context.data.session.status(sessionID) === "idle",
      metrics: props.config.promptRightMetrics
    });
  };
  return <text fg={props.context.theme.textMuted} height={text() ? 1 : 0}>{text()}</text>;
}

function SessionAnalysis(props: { context: Context; sessionID: string; activity: ActivityState; subscribe: (listener: () => void) => () => void; hydrate: () => void }) {
  const [version, setVersion] = createSignal(0);
  props.subscribe(() => setVersion((value) => value + 1));
  props.hydrate();
  const tree = () => treeActivity(props.activity, props.sessionID);
  const lines = () => {
    version();
    const rows = formatActivityBriefRows(tree(), treeSubagentCount(props.activity, props.sessionID));
    return treeLoading(props.activity, props.sessionID) ? [...rows, "loading..."] : rows;
  };
  return <TextSection theme={props.context.theme} title="Session Analysis" lines={lines} onClick={() => {
    void props.context.ui.dialog.show(() => <box flexDirection="column"><text fg={props.context.theme.text} attributes={1}>Session Analysis</text><For each={buildSessionAnalysisRows(props.activity, props.sessionID)}>{(row) => <text fg={row.header ? props.context.theme.text : props.context.theme.textMuted}>{row.text}</text>}</For></box>);
  }} />;
}

function TokenUsage(props: { sessionID: string; metrics: MetricsState; subagents: SubagentState; subscribe: (listener: () => void) => () => void; hydrate: () => void; theme: SemanticTheme }) {
  const [version, setVersion] = createSignal(0);
  props.subscribe(() => setVersion((value) => value + 1));
  props.hydrate();
  const content = () => { version(); return renderSessionTokenUsage(props.metrics, props.sessionID, sumSubagentTokens(props.subagents, props.sessionID)); };
  const title = () => content().split("\n")[0] ?? "Token Usage";
  const lines = () => content().split("\n").slice(1);
  return <TextSection theme={props.theme} title={title} lines={lines} />;
}

function Usage(props: { title: string; lines: () => string[]; error?: () => string | undefined; theme: SemanticTheme; subscribe: (listener: () => void) => () => void }) {
  const [version, setVersion] = createSignal(0);
  const unsubscribe = props.subscribe(() => setVersion((value) => value + 1));
  onCleanup(unsubscribe);
  return <TextSection theme={props.theme} title={props.title} lines={() => { version(); return props.error?.() ? [props.error()!] : props.lines(); }} />;
}

function Sidebar(props: { context: Context; sessionID: string; config: InsightsConfig; metrics: MetricsState; activity: ActivityState; subagents: SubagentState; subscribe: (listener: () => void) => () => void; usageSubscribe: (listener: () => void) => () => void; notify: () => void; hydrateMetrics: () => void; hydrateActivity: () => void; go: ReturnType<typeof createGoUsageRefresher>; goTracker: ReturnType<typeof createGoProviderTracker>; copilot: ReturnType<typeof createCopilotUsageRefresher>; copilotTracker: ReturnType<typeof createCopilotProviderTracker>; copilotToken: string }) {
  const [version, setVersion] = createSignal(0);
  props.subscribe(() => setVersion((value) => value + 1));
  props.usageSubscribe(() => setVersion((value) => value + 1));
  const goVisible = () => { version(); return goUsageSectionVisible(props.config, props.goTracker.usesOpenCodeGo(props.sessionID)); };
  const copilotVisible = () => { version(); return copilotUsageSectionVisible(props.config, props.copilotToken, props.copilotTracker.usesCopilot(props.sessionID)); };
  createEffect(() => {
    if (goVisible()) void props.go.refresh().then((changed) => changed && props.notify());
    if (copilotVisible()) void props.copilot.refresh().then((changed) => changed && props.notify());
  });
  const hydrateMetrics = () => {
    for (const message of props.context.data.session.message.list(props.sessionID)) {
      const info = message.type === "assistant" ? message : undefined;
      if (!info || typeof info.time.completed !== "number") continue;
      const usage = info.tokens;
      recordAssistantMessage(props.metrics, {
        sessionID: props.sessionID,
        messageID: info.id,
        createdAt: info.time.created,
        completedAt: info.time.completed,
        ...(usage?.input === undefined ? {} : { inputTokens: usage.input }),
        ...(usage?.output === undefined ? {} : { outputTokens: usage.output }),
        ...(usage?.reasoning === undefined ? {} : { reasoningTokens: usage.reasoning }),
        ...(usage?.cache.read === undefined ? {} : { cacheReadTokens: usage.cache.read }),
        ...(usage?.cache.write === undefined ? {} : { cacheWriteTokens: usage.cache.write })
      });
    }
  };
  hydrateMetrics();
  return <box flexDirection="column">
    <SessionAnalysis context={props.context} sessionID={props.sessionID} activity={props.activity} subscribe={props.subscribe} hydrate={props.hydrateActivity} />
    <TokenUsage sessionID={props.sessionID} metrics={props.metrics} subagents={props.subagents} subscribe={props.subscribe} hydrate={hydrateMetrics} theme={props.context.theme} />
    {goVisible() ? <Usage subscribe={props.usageSubscribe} theme={props.context.theme} title="Go Usage" lines={() => { const rows = goUsageRows(props.go.state, Date.now()); return rows?.map(formatGoUsageRow) ?? []; }} error={() => props.go.state.error} /> : null}
    {copilotVisible() ? <Usage subscribe={props.usageSubscribe} theme={props.context.theme} title="Copilot" lines={() => { const row = props.copilot.state.data ? copilotUsageRow(props.copilot.state.data, Date.now()) : undefined; return row ? formatCopilotUsageRow(row).split("\n") : []; }} error={() => props.copilot.state.error} /> : null}
    <Subagents sessionID={props.sessionID} state={props.subagents} context={props.context} subscribe={props.subscribe} />
  </box>;
}

function Subagents(props: { sessionID: string; state: SubagentState; context: Context; subscribe: (listener: () => void) => () => void }) {
  const [version, setVersion] = createSignal(0);
  props.subscribe(() => setVersion((value) => value + 1));
  const model = () => { version(); return getSubagentSidebarModel(props.state, props.sessionID); };
  return model() ? <TextSection theme={props.context.theme} title={model()!.title} lines={() => { const current = model(); return current ? [current.summary, ...current.rows.map((row) => `${row.title} ${row.subtitle}`)] : []; }} onClick={() => {
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
  for (const session of context.data.session.list()) {
    goTracker.record(session.id, providerIDFromModel(session.model));
    copilotTracker.record(session.id, providerIDFromModel(session.model));
  }
  cleanups.push(context.data.listen(({ details }) => {
    if (disposed) return;
    const data: V2Data = isRecord(details.data) ? details.data : {};
    const eventType = details.type;
    const sessionID = stringValue(data.sessionID);
    const messageID = stringValue(data.assistantMessageID);
    const toolID = stringValue(data.id);
    const tool = sessionID && toolID
      ? context.data.session.message.list(sessionID).flatMap((entry) => entry.type === "assistant" ? entry.content : []).find((part): part is Extract<typeof part, { type: "tool" }> => part.type === "tool" && part.id === toolID)
      : undefined;
    applySubagentEvent(subagents, details, tool);
    const message = sessionID && messageID ? context.data.session.message.get(sessionID, messageID) : undefined;
    const info = message?.type === "assistant" ? message : undefined;
    const providerID = providerIDFromModel(info?.model);
    if (sessionID) {
      const sessionProviderID = providerID ?? providerIDFromModel(context.data.session.get(sessionID)?.model);
      goTracker.record(sessionID, sessionProviderID);
      copilotTracker.record(sessionID, sessionProviderID);
    }
    if (eventType === "session.text.delta" || eventType === "session.reasoning.delta") {
      const deltaSessionID = stringValue(data.sessionID);
      const deltaMessageID = stringValue(data.assistantMessageID);
      const delta = stringValue(data.delta);
      if (deltaSessionID && deltaMessageID && delta) recordAssistantDelta(metrics, { sessionID: deltaSessionID, messageID: deltaMessageID, delta, at: Date.now() });
      metricListeners.notify();
    } else if (eventType === "session.usage.updated") {
      const latest = sessionID ? [...context.data.session.message.list(sessionID)].reverse().find((entry) => entry.type === "assistant") : undefined;
      if (latest && sessionID && isRecord(data.tokens)) {
        const usage = data.tokens;
        recordAssistantMessage(metrics, { sessionID, messageID: latest.id, createdAt: latest.time.created, ...(typeof latest.time.completed === "number" ? { completedAt: latest.time.completed } : {}), ...(typeof usage.input === "number" ? { inputTokens: usage.input } : {}), ...(typeof usage.output === "number" ? { outputTokens: usage.output } : {}), ...(typeof usage.reasoning === "number" ? { reasoningTokens: usage.reasoning } : {}), ...(isRecord(usage.cache) && typeof usage.cache.read === "number" ? { cacheReadTokens: usage.cache.read } : {}), ...(isRecord(usage.cache) && typeof usage.cache.write === "number" ? { cacheWriteTokens: usage.cache.write } : {}) });
      }
      metricListeners.notify();
    } else if (eventType === "session.tool.success" || eventType === "session.tool.failed") {
      const toolID = stringValue(data.id);
      const tool = sessionID ? context.data.session.message.list(sessionID).flatMap((entry) => entry.type === "assistant" ? entry.content : []).find((part): part is Extract<typeof part, { type: "tool" }> => part.type === "tool" && part.id === toolID) : undefined;
      if (!tool || !sessionID || !messageID) return;
      const failure = eventType.endsWith("failed") ? errorMessage(data.error) ?? textFromToolContent(data.content) ?? "tool failed" : undefined;
      const part = { id: tool.id, sessionID, messageID, type: "tool", tool: tool.name, state: { status: eventType.endsWith("failed") ? "error" : "completed", ...(failure ? { error: failure } : {}) } };
      recordToolActivity(metrics, part.sessionID, part.messageID, Date.now());
      recordToolPart(activity, part.sessionID, part);
      metricListeners.notify();
      activityListeners.notify();
    } else if (eventType === "session.compaction.ended") {
      if (sessionID) recordCompaction(activity, sessionID, stringValue(data.id) ?? details.id, data.reason === "auto");
      activityListeners.notify();
    } else if (eventType === "session.step.ended") {
      if (sessionID) recordStep(activity, sessionID, stringValue(data.id) ?? details.id);
      activityListeners.notify();
    } else if (eventType === "session.created") {
      if (sessionID && typeof data.parentID === "string") recordChild(activity, sessionID, data.parentID);
      if (sessionID && typeof data.title === "string") activity.titles[sessionID] = data.title;
      const createdProviderID = providerIDFromModel(data.model);
      if (sessionID) {
        goTracker.record(sessionID, createdProviderID);
        copilotTracker.record(sessionID, createdProviderID);
      }
      activityListeners.notify();
    }
  }));
  const subscribeSidebar = (listener: () => void) => {
    const unsubscribers = [metricListeners.subscribe(listener), activityListeners.subscribe(listener), subagentListeners.subscribe(listener)];
    return () => unsubscribers.forEach((unsubscribe) => unsubscribe());
  };
  const slotCleanups = [
    context.ui.slot({ append: "prompt.footer.status", render: (input: SlotMap["prompt.footer.status"]) => <PromptRight context={context} sessionID={() => input.sessionID ?? ""} metrics={metrics} config={config} subscribe={metricListeners.subscribe} /> }),
    context.ui.slot({ append: "sidebar.content", render: (input: SlotMap["sidebar.content"]) => <Sidebar context={context} sessionID={input.sessionID} config={config} metrics={metrics} activity={activity} subagents={subagents} subscribe={subscribeSidebar} usageSubscribe={(listener) => { const goUnsubscribe = goListeners.subscribe(listener); const copilotUnsubscribe = copilotListeners.subscribe(listener); return () => { goUnsubscribe(); copilotUnsubscribe(); }; }} notify={() => { metricListeners.notify(); activityListeners.notify(); goListeners.notify(); copilotListeners.notify(); }} hydrateMetrics={() => {}} hydrateActivity={() => void hydrateActivity({ session: { list: () => context.data.session.list().map((session) => ({ id: session.id, ...(session.parentID ? { parentID: session.parentID } : {}), ...(session.title ? { title: session.title } : {}) })) }, message: { list: (sessionID: string) => context.data.session.message.list(sessionID).map((message) => ({ parts: message.type === "assistant" ? message.content.filter((part): part is Extract<typeof part, { type: "tool" }> => part.type === "tool").map((part) => ({ id: part.id, type: "tool", tool: part.name, state: part.state })) : [] })) } }, activity, input.sessionID).then(() => activityListeners.notify())} go={go} goTracker={goTracker} copilot={copilot} copilotTracker={copilotTracker} copilotToken={copilotToken} /> })
  ];
  cleanups.push(...slotCleanups);
  const timers = [setInterval(() => { metricListeners.notify(); activityListeners.notify(); goListeners.notify(); copilotListeners.notify(); }, 1000)];
  let disposed = false;
  const cleanup = async () => {
    if (disposed) return;
    disposed = true;
    for (const timer of timers) clearInterval(timer);
    for (const cleanup of cleanups) cleanup();
  };
  Object.assign(cleanup, {
    __insightsState: {
      metrics,
      activity,
      subagents,
      render: (sessionID: string) => formatActivityBriefRows(treeActivity(activity, sessionID), treeSubagentCount(activity, sessionID)).join("\n")
    }
  });
  return cleanup;
};

export { setup };
export default Plugin.define({ id, setup });
