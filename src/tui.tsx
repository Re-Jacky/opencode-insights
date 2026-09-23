/** @jsxImportSource @opentui/solid */
import { createTextAttributes } from "@opentui/core";
import { Plugin, usePlugin } from "@opencode/plugin/tui";
import type { Context } from "@opencode/plugin/tui/context";
import { createEffect, createMemo, createSignal, For, Show, type JSX } from "solid-js";
import { readInsightsConfig, resolveCopilotToken, type InsightsConfig } from "./config.js";
import { createMetricsState, renderPromptRightMetricsText, renderSessionTokenUsage } from "./metrics.js";
import { hydrateInsights, listAllMessages, needsHydration, type ActivityData } from "./activity-hydrate.js";
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
import { selectAnalysisDialogLayout, selectDialogSize } from "./dialog-size.js";
import { getSubagentSidebarModel, sumSubagentTokens } from "./subagents.js";
import {
  createGoUsageRefresher,
  formatNextUsageUpdate,
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
  const context = usePlugin();
  const theme = context.theme;
  const [collapsed, setCollapsed] = createSignal(false);
  const lines = createMemo(() => {
    props.version;
    // Subagent totals come from the host's session store, the same source the
    // Subagents section reads its rows from.
    const children = context.data.session.list().filter((session) => session.parentID === props.sessionID);
    const content = renderSessionTokenUsage(props.state.metrics, props.sessionID, sumSubagentTokens(children));
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
  status: "idle" | "running";
  state: InsightState;
  version: number;
  config: InsightsConfig;
}) {
  const theme = usePlugin().theme;
  const text = createMemo(() => {
    props.version;
    if (!isSessionID(props.sessionID)) return "";
    return renderPromptRightMetricsText(props.state.metrics, props.sessionID, {
      idle: props.status === "idle",
      metrics: props.config.promptRightMetrics
    });
  });

  return (
    <Show when={text().length > 0}>
      <box flexDirection="row" justifyContent="flex-end" width="100%">
        <text fg={theme.text.feedback.info.base}>{text()}</text>
      </box>
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
  // Explicit heights: an unbounded scrollbox stretches to the bottom of the host's
  // full-screen dialog overlay, so short content used to fill the whole terminal.
  const layout = createMemo(() => selectAnalysisDialogLayout(visible().length, context.renderer.height));
  // The width preset has to be applied from inside the dialog: dialog.show() resets
  // the presentation options to "medium", so setting it beforehand is discarded.
  createEffect(() => {
    context.ui.dialog.set({ size: selectDialogSize(visibleAnalysisRowCount(rows(), props.collapsedGroups)) });
  });

  return (
    <box flexDirection="column" height={layout().height} paddingLeft={4} paddingRight={4} paddingTop={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={bold}>{"Session Analysis"}</text>
        <text fg={theme.text.muted} onMouseUp={() => context.ui.dialog.clear()}>
          {"esc"}
        </text>
      </box>
      <scrollbox height={layout().scrollHeight} paddingTop={1}>
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
  // The host's idle stamp can lag its store, so a child that has already stopped
  // keeps the duration it had when we first saw it stop instead of never stopping.
  const idleSeenAt = new Map<string, number>();
  const observedIdleAt = (id: string) => {
    const seen = idleSeenAt.get(id);
    if (seen !== undefined) return seen;
    const at = Date.now();
    idleSeenAt.set(id, at);
    return at;
  };
  const model = createMemo(() => {
    props.version;
    // The host's session store is the source of truth: liveness is
    // `data.session.status()`, identity and timings are `SessionInfo` fields.
    const sessions = context.data.session.list();
    const children = sessions
      .filter((session) => session.parentID === props.sessionID)
      .map((session) => ({
        id: session.id,
        title: session.title,
        agent: session.agent,
        outcome: session.outcome,
        status: context.data.session.status(session.id),
        time: session.time,
        tokens: session.tokens
      }));
    return getSubagentSidebarModel(children, {
      now: Date.now(),
      activity: (id) => props.state.activity.bySessionID[id],
      observedIdleAt
    });
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

function UsageRefreshStatus(props: {
  version: number;
  refreshMs: number;
  refresher: {
    state: { lastFetchAt?: number | undefined; isRefreshing?: boolean | undefined };
    refresh: (now?: number, force?: boolean) => Promise<boolean>;
  };
}) {
  const theme = usePlugin().theme;
  const [hovered, setHovered] = createSignal(false);
  const [manualRefreshing, setManualRefreshing] = createSignal(false);
  const nextUpdate = createMemo(() => {
    props.version;
    const remaining = formatNextUsageUpdate(props.refresher.state.lastFetchAt, props.refreshMs, Date.now());
    return remaining === "now" || remaining === "pending" ? remaining : `in ${remaining}`;
  });
  const refreshLabel = createMemo(() => {
    props.version;
    return manualRefreshing() || props.refresher.state.isRefreshing ? "Refreshing…" : "↻ Refresh";
  });
  const refresh = async () => {
    setManualRefreshing(true);
    try {
      await props.refresher.refresh(Date.now(), true);
    } finally {
      setManualRefreshing(false);
    }
  };

  return (
    <box flexDirection="row" gap={1}>
      <text fg={theme.text.muted}>{`Next update: ${nextUpdate()}`}</text>
      <text
        fg={hovered() ? theme.text.base : theme.text.muted}
        onMouseMove={() => setHovered(true)}
        onMouseOut={() => setHovered(false)}
        onMouseUp={() => void refresh()}
      >
        {refreshLabel()}
      </text>
    </box>
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
    props.version;
    if (visible() && !props.refresher.state.isRefreshing) void props.refresher.refresh();
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
        <UsageRefreshStatus version={props.version} refreshMs={props.config.goUsage.refreshMs} refresher={props.refresher} />
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
    props.version;
    if (visible() && !props.refresher.state.isRefreshing) void props.refresher.refresh();
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
        <UsageRefreshStatus
          version={props.version}
          refreshMs={props.config.copilotUsage.refreshMs}
          refresher={props.refresher}
        />
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
    // The host's `session.message.sync()` only loads the newest transcript page
    // (20 messages), so session totals read through the client's paging API instead.
    const data: ActivityData = {
      session: {
        list: () => context.data.session.list(),
        message: {
          sync: (id) => context.data.session.message.sync(id),
          list: (id) => context.data.session.message.list(id),
          history: (id) => listAllMessages((input) => context.client.message.list(input), id)
        }
      }
    };
    void hydrateInsights(data, state, sessionID)
      .then(() => {
        setActivityRev((value) => value + 1);
        setMetricsRev((value) => value + 1);
        setSubagentsRev((value) => value + 1);
      })
      .catch(() => undefined);
  };

  const unregisterSidebar = context.ui.slot({
    prepend: "sidebar.content",
    render: (input) => (
      // The host spaces the `sidebar.content` contributions with `gap: 1`, but
      // this slot returns a single wrapper box, so the sections inside it need
      // that same gap here to sit as far apart as the native Context/MCP ones.
      <box flexDirection="column" gap={1}>
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
    append: "session.composer.top",
    render: (input) => (
      <PromptRight
        sessionID={input.sessionID}
        status={context.data.session.status(input.sessionID)}
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
