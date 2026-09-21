/** @jsxImportSource @opentui/solid */
import { createTextAttributes } from "@opentui/core";
import { Plugin, usePlugin } from "@opencode/plugin/tui";
import type { Context } from "@opencode/plugin/tui/context";
import { createEffect, createMemo, createSignal, For, Show, type JSX } from "solid-js";
import { readInsightsConfig, resolveCopilotToken, type InsightsConfig } from "./config.js";
import { createMetricsState, renderPromptRightMetricsText, renderSessionTokenUsage } from "./metrics.js";
import { hydrateInsights, needsHydration } from "./activity-hydrate.js";
import {
  buildSessionAnalysisRows,
  createActivityState,
  formatActivityBriefRows,
  treeActivity,
  treeLoading,
  treeSubagentCount,
  visibleAnalysisRowCount,
  type SessionAnalysisRow
} from "./activity.js";
import { selectDialogSize } from "./dialog-size.js";
import { createSubagentState, getSubagentSidebarModel, sumSubagentTokens } from "./subagents.js";
import {
  createGoUsageRefresher,
  formatGoUsageRow,
  goUsageRows,
  goUsageSectionVisible,
  createGoProviderTracker,
  type GoUsageRow
} from "./go-usage.js";
import {
  copilotUsageRow,
  copilotUsageSectionVisible,
  createCopilotUsageRefresher,
  createCopilotProviderTracker,
  formatCopilotUsageRow
} from "./copilot-usage.js";
import { applyInsightEvent, createInsightState, type InsightState } from "./events.js";

const bold = createTextAttributes({ bold: true });

function isSessionID(value: string | undefined): value is string {
  return typeof value === "string" && value.startsWith("ses");
}

function Section(props: {
  title: string;
  collapsed: boolean;
  onToggle: () => void;
  children: JSX.Element;
}) {
  const theme = usePlugin().theme;
  const [hovered, setHovered] = createSignal(false);
  return (
    <box flexDirection="column">
      <box
        flexDirection="row"
        {...(hovered() ? { backgroundColor: theme.background.raised.base } : {})}
        onMouseMove={() => setHovered(true)}
        onMouseOut={() => setHovered(false)}
        onMouseUp={props.onToggle}
      >
        <text attributes={bold}>{`${props.collapsed ? "▶" : "▼"} ${props.title}`}</text>
      </box>
      <Show when={!props.collapsed}>{props.children}</Show>
    </box>
  );
}

function TokenUsageSection(props: { sessionID: string; state: InsightState; version: number }) {
  const theme = usePlugin().theme;
  const [collapsed, setCollapsed] = createSignal(false);
  const lines = createMemo(() => {
    props.version;
    const subagents = sumSubagentTokens(props.state.subagents, props.sessionID);
    const content = renderSessionTokenUsage(props.state.metrics, props.sessionID, subagents);
    return content.length > 0 ? content.split("\n") : [];
  });

  return (
    <Show when={lines().length > 0}>
      <Section
        title={lines()[0] ?? "Token Usage"}
        collapsed={collapsed()}
        onToggle={() => setCollapsed((value) => !value)}
      >
        <For each={lines().slice(1)}>{(line) => <text fg={theme.text.muted}>{line}</text>}</For>
      </Section>
    </Show>
  );
}

function PromptRight(props: {
  sessionID: string;
  mode: string;
  status: "idle" | "running";
  state: InsightState;
  version: number;
  config: InsightsConfig;
}) {
  const theme = usePlugin().theme;
  const text = createMemo(() => {
    props.version;
    if (!isSessionID(props.sessionID) || props.mode === "shell") return "";
    return renderPromptRightMetricsText(props.state.metrics, props.sessionID, {
      idle: props.status === "idle",
      metrics: props.config.promptRightMetrics
    });
  });

  return (
    <Show when={text().length > 0}>
      <text fg={theme.text.muted}>{text()}</text>
    </Show>
  );
}

function SessionAnalysisSection(props: {
  sessionID: string;
  state: InsightState;
  version: number;
  onHydrate: () => void;
}) {
  const context = usePlugin();
  const theme = context.theme;
  const [collapsedGroups, setCollapsedGroups] = createSignal<Set<string>>(new Set());
  const [hovered, setHovered] = createSignal(false);

  createEffect(() => {
    props.sessionID;
    props.onHydrate();
  });

  const lines = createMemo(() => {
    props.version;
    const tree = treeActivity(props.state.activity, props.sessionID);
    const loading = treeLoading(props.state.activity, props.sessionID);
    const rows = formatActivityBriefRows(tree, treeSubagentCount(props.state.activity, props.sessionID));
    return loading && rows.length === 0 ? ["loading…"] : rows;
  });

  const toggleGroup = (key: string) => {
    setCollapsedGroups((previous) => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const openDialog = () => {
    const rows = buildSessionAnalysisRows(props.state.activity, props.sessionID);
    context.ui.dialog.set({ size: selectDialogSize(visibleAnalysisRowCount(rows, collapsedGroups())) });
    context.ui.dialog.show(() => (
      <SessionAnalysisDialog
        sessionID={props.sessionID}
        state={props.state}
        collapsedGroups={collapsedGroups()}
        onToggleGroup={toggleGroup}
      />
    ));
  };

  return (
    <Show when={lines().length > 0}>
      <box
        flexDirection="column"
        {...(hovered() ? { backgroundColor: theme.background.raised.base } : {})}
        onMouseMove={() => setHovered(true)}
        onMouseOut={() => setHovered(false)}
        onMouseUp={openDialog}
      >
        <text attributes={bold}>{"Session Analysis"}</text>
        <For each={lines()}>{(line) => <text fg={theme.text.muted}>{line}</text>}</For>
      </box>
    </Show>
  );
}

function SessionAnalysisDialog(props: {
  sessionID: string;
  state: InsightState;
  collapsedGroups: Set<string>;
  onToggleGroup: (key: string) => void;
}) {
  const context = usePlugin();
  const theme = context.theme;
  const rows = createMemo(() => buildSessionAnalysisRows(props.state.activity, props.sessionID));
  const visible = createMemo<SessionAnalysisRow[]>(() => {
    const result: SessionAnalysisRow[] = [];
    let header: string | undefined;
    for (const row of rows()) {
      if (row.header) {
        header = row.text;
        result.push({ text: `${props.collapsedGroups.has(row.text) ? "▶" : "▾"} ${row.text}`, header: true, key: row.text });
      } else if (header === undefined || !props.collapsedGroups.has(header)) {
        result.push(row);
      }
    }
    return result;
  });

  return (
    <box flexDirection="column" flexGrow={1} paddingLeft={4} paddingRight={4} paddingTop={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={bold}>{"Session Analysis"}</text>
        <text fg={theme.text.muted} onMouseUp={() => context.ui.dialog.clear()}>
          {"esc"}
        </text>
      </box>
      <scrollbox flexGrow={1} paddingTop={1}>
        <For each={visible()}>
          {(row) => (
            <text
              fg={row.header ? theme.text.base : theme.text.muted}
              {...(row.header ? { attributes: bold } : {})}
              {...(row.header && row.key ? { onMouseUp: () => props.onToggleGroup(row.key ?? "") } : {})}
            >
              {row.text}
            </text>
          )}
        </For>
      </scrollbox>
    </box>
  );
}

function SubagentsSection(props: { sessionID: string; state: InsightState; version: number }) {
  const context = usePlugin();
  const theme = context.theme;
  const [collapsed, setCollapsed] = createSignal(false);
  const [hovered, setHovered] = createSignal<string | undefined>();
  const model = createMemo(() => {
    props.version;
    return getSubagentSidebarModel(props.state.subagents, props.sessionID, { now: Date.now() });
  });

  return (
    <Show when={model()}>
      {(value) => (
        <Section
          title={value().title}
          collapsed={collapsed()}
          onToggle={() => setCollapsed((current) => !current)}
        >
          <text fg={theme.text.muted}>{value().summary}</text>
          <For each={value().rows}>
            {(row) => (
              <box
                flexDirection="row"
                {...(hovered() === row.id ? { backgroundColor: theme.background.raised.base } : {})}
                onMouseMove={() => setHovered(row.id)}
                onMouseOut={() => setHovered(undefined)}
                onMouseUp={() => context.ui.router.navigate({ type: "session", sessionID: row.id })}
              >
                <text
                  fg={
                    row.status === "running"
                      ? theme.text.feedback.success.base
                      : row.status === "error"
                        ? theme.text.feedback.error.base
                        : theme.text.muted
                  }
                >
                  {"• "}
                </text>
                <box flexDirection="column">
                  <text fg={theme.text.base}>{row.title}</text>
                  <text fg={theme.text.muted}>{row.subtitle}</text>
                </box>
              </box>
            )}
          </For>
        </Section>
      )}
    </Show>
  );
}

function GoUsageSection(props: {
  sessionID: string;
  state: InsightState;
  config: InsightsConfig;
  refresher: ReturnType<typeof createGoUsageRefresher>;
  version: number;
}) {
  const theme = usePlugin().theme;
  const [collapsed, setCollapsed] = createSignal(false);
  const visible = createMemo(() => {
    props.version;
    return goUsageSectionVisible(props.config, props.state.goProviders.usesOpenCodeGo(props.sessionID));
  });
  const rows = createMemo<GoUsageRow[] | undefined>(() => {
    props.version;
    return visible() ? goUsageRows(props.refresher.state, Date.now()) : undefined;
  });
  const error = createMemo(() => {
    props.version;
    return props.refresher.state.error;
  });

  createEffect(() => {
    if (visible()) void props.refresher.refresh();
  });

  return (
    <Show when={visible() && (rows() !== undefined || error() !== undefined)}>
      <Section title="Go Usage" collapsed={collapsed()} onToggle={() => setCollapsed((current) => !current)}>
        <Show
          when={error()}
          fallback={<For each={rows() ?? []}>{(row) => <text fg={theme.text.muted}>{formatGoUsageRow(row)}</text>}</For>}
        >
          {(message) => <text fg={theme.text.feedback.error.base}>{`Go usage: ${message()}`}</text>}
        </Show>
      </Section>
    </Show>
  );
}

function CopilotUsageSection(props: {
  sessionID: string;
  state: InsightState;
  config: InsightsConfig;
  token: string;
  refresher: ReturnType<typeof createCopilotUsageRefresher>;
  version: number;
}) {
  const theme = usePlugin().theme;
  const [collapsed, setCollapsed] = createSignal(false);
  const visible = createMemo(() => {
    props.version;
    return copilotUsageSectionVisible(props.config, props.token, props.state.copilotProviders.usesCopilot(props.sessionID));
  });
  const row = createMemo(() => {
    props.version;
    const data = props.refresher.state.data;
    return visible() && data ? copilotUsageRow(data, Date.now()) : undefined;
  });
  const error = createMemo(() => {
    props.version;
    return props.refresher.state.error;
  });

  createEffect(() => {
    if (visible()) void props.refresher.refresh();
  });

  return (
    <Show when={visible() && (row() !== undefined || error() !== undefined)}>
      <Section title="Copilot" collapsed={collapsed()} onToggle={() => setCollapsed((current) => !current)}>
        <Show
          when={error()}
          fallback={
            <For each={row() ? formatCopilotUsageRow(row()!).split("\n") : []}>
              {(line) => <text fg={theme.text.muted}>{line}</text>}
            </For>
          }
        >
          {(message) => <text fg={theme.text.feedback.error.base}>{`Copilot: ${message()}`}</text>}
        </Show>
      </Section>
    </Show>
  );
}

async function setup(context: Context) {
  const config = await readInsightsConfig({ dataDir: context.options.dataDir });
  const activity = createActivityState();
  const state = createInsightState({
    metrics: createMetricsState(),
    activity,
    subagents: createSubagentState(activity),
    goProviders: createGoProviderTracker(),
    copilotProviders: createCopilotProviderTracker()
  });
  const token = resolveCopilotToken(config.copilotUsage);
  const goUsage = createGoUsageRefresher(config.goUsage);
  const copilotUsage = createCopilotUsageRefresher(config.copilotUsage, token);

  const [metricsRev, setMetricsRev] = createSignal(0);
  const [activityRev, setActivityRev] = createSignal(0);
  const [subagentsRev, setSubagentsRev] = createSignal(0);
  const [now, setNow] = createSignal(Date.now());
  const ticker = setInterval(() => setNow(Date.now()), 1_000);

  const stop = context.data.listen(({ details }) => {
    let result;
    try {
      result = applyInsightEvent(state, details);
    } catch {
      return;
    }
    if (result.metrics) setMetricsRev((value) => value + 1);
    if (result.activity) setActivityRev((value) => value + 1);
    if (result.subagents) setSubagentsRev((value) => value + 1);
  });

  const hydrate = (sessionID: string) => {
    if (!isSessionID(sessionID) || !needsHydration(activity, sessionID)) return;
    void hydrateInsights(context.data, state, sessionID)
      .then(() => {
        setActivityRev((value) => value + 1);
        setMetricsRev((value) => value + 1);
        setSubagentsRev((value) => value + 1);
      })
      .catch(() => undefined);
  };

  const unregisterSidebar = context.ui.slot({
    append: "sidebar.content",
    render: (input) => (
      <box flexDirection="column">
        <SessionAnalysisSection
          sessionID={input.sessionID}
          state={state}
          version={activityRev() + now()}
          onHydrate={() => hydrate(input.sessionID)}
        />
        <TokenUsageSection
          sessionID={input.sessionID}
          state={state}
          version={metricsRev() + activityRev() + subagentsRev() + now()}
        />
        <GoUsageSection
          sessionID={input.sessionID}
          state={state}
          config={config}
          refresher={goUsage}
          version={metricsRev() + now()}
        />
        <CopilotUsageSection
          sessionID={input.sessionID}
          state={state}
          config={config}
          token={token}
          refresher={copilotUsage}
          version={metricsRev() + now()}
        />
        <SubagentsSection sessionID={input.sessionID} state={state} version={subagentsRev() + now()} />
      </box>
    )
  });

  const unregisterPrompt = context.ui.slot({
    after: "prompt.footer.status",
    render: (input) => (
      <PromptRight
        sessionID={input.sessionID ?? ""}
        mode={input.mode}
        status={input.sessionID ? context.data.session.status(input.sessionID) : "idle"}
        state={state}
        version={metricsRev() + now()}
        config={config}
      />
    )
  });

  return () => {
    stop();
    clearInterval(ticker);
    unregisterSidebar();
    unregisterPrompt();
  };
}

const tui = Plugin.define({ id: "opencode-insights", setup });

export { tui };
export default tui;
