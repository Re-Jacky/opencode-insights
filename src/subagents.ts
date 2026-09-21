import { emptyActivity, formatActivitySuffix, type ActivityState, type SessionActivity } from "./activity.js";

export type SubagentStatus = "running" | "done" | "error";

export type SubagentInfo = {
  id: string;
  parentID: string;
  title: string;
  status: SubagentStatus;
  startedAt: string;
  updatedAt: string;
  endedAt?: string | undefined;
  elapsedMs?: number | undefined;
  tokens?: {
    input?: number | undefined;
    output?: number | undefined;
    total?: number | undefined;
    contextPercent?: number | undefined;
  } | undefined;
  activity?: SessionActivity | undefined;
};

export type SubagentState = {
  children: Record<string, SubagentInfo>;
  totalExecuted: number;
  activityStore?: ActivityState | undefined;
};

export type SubagentSidebarRow = {
  id: string;
  title: string;
  subtitle: string;
  status: SubagentStatus;
};

export type SubagentSidebarModel = {
  title: string;
  summary: string;
  rows: SubagentSidebarRow[];
};

export function createSubagentState(activityStore?: ActivityState): SubagentState {
  return { children: {}, totalExecuted: 0, ...(activityStore ? { activityStore } : {}) };
}

export function recordSubagentFromSessionInfo(
  state: SubagentState,
  session: { id: string; parentID?: string; title?: string }
): void {
  if (!session.parentID || !session.id || session.id === session.parentID) return;
  if (state.children[session.id]) return;
  const now = new Date().toISOString();
  state.children[session.id] = {
    id: session.id,
    parentID: session.parentID,
    title: session.title ?? "subagent",
    status: "done",
    startedAt: now,
    updatedAt: now
  };
  state.totalExecuted += 1;
}

function eventData(event: unknown): { type: string; created: number; data: Record<string, unknown> } | undefined {
  if (!isRecord(event)) return undefined;
  const type = asString(event.type);
  if (!type) return undefined;
  return {
    type,
    created: asNumber(event.created) ?? Date.now(),
    data: isRecord(event.data) ? event.data : {}
  };
}

export function applySubagentEvent(state: SubagentState, event: unknown): boolean {
  const parsed = eventData(event);
  if (!parsed) return false;
  const { type, created, data } = parsed;
  const sessionID = asString(data.sessionID);

  if (type === "session.created") {
    const parentID = asString(data.parentID);
    if (!sessionID || !parentID || sessionID === parentID) return false;
    if (state.children[sessionID]) return false;
    const startedAt = new Date(created).toISOString();
    state.children[sessionID] = {
      id: sessionID,
      parentID,
      title: asString(data.title) ?? asString(data.agent) ?? "subagent",
      status: "running",
      startedAt,
      updatedAt: startedAt,
      activity: state.activityStore ? (state.activityStore.bySessionID[sessionID] ??= emptyActivity()) : undefined
    };
    state.totalExecuted += 1;
    return true;
  }

  if (!sessionID) return false;
  const previous = state.children[sessionID];
  if (!previous) return false;

  if (type === "session.renamed") {
    const title = asString(data.title);
    if (!title || title === previous.title) return false;
    state.children[sessionID] = { ...previous, title, updatedAt: new Date(created).toISOString() };
    return true;
  }

  if (type === "session.status") {
    const statusType = isRecord(data.status) ? asString(data.status.type) : undefined;
    const next = statusType === "busy" || statusType === "retry" ? "running" : "done";
    return setStatus(state, previous, next, created);
  }

  if (type === "session.idle") {
    return setStatus(state, previous, "done", created);
  }

  if (type === "session.execution.failed") {
    return setStatus(state, previous, "error", created);
  }

  if (type === "session.usage.updated" || type === "session.step.ended") {
    const tokens = extractTokens(data.tokens) ?? previous.tokens;
    const updatedAt = new Date(created).toISOString();
    state.children[sessionID] = {
      ...previous,
      updatedAt,
      tokens,
      elapsedMs: elapsedMs(previous.startedAt, previous.endedAt ?? updatedAt)
    };
    return true;
  }

  return false;
}

function setStatus(state: SubagentState, previous: SubagentInfo, status: SubagentStatus, created: number): boolean {
  if (previous.status === status) return false;
  const timestamp = new Date(created).toISOString();
  const terminal = status === "done" || status === "error";
  state.children[previous.id] = {
    ...previous,
    status,
    updatedAt: timestamp,
    endedAt: terminal ? previous.endedAt ?? timestamp : previous.endedAt,
    elapsedMs: elapsedMs(previous.startedAt, terminal ? previous.endedAt ?? timestamp : timestamp)
  };
  return true;
}

export function renderSubagentStatus(state: SubagentState, options: { now?: number } = {}) {
  const children = getSubagentItems(state);
  const running = children.filter((child) => child.status === "running").length;
  const done = children.filter((child) => child.status === "done").length;
  const error = children.filter((child) => child.status === "error").length;
  const aggregate = `${running} running · ${done} done · ${error} failed · ${state.totalExecuted} total`;

  if (children.length === 0) return aggregate;

  const details = children
    .map((child) => {
      const nowIso = new Date(options.now ?? Date.now()).toISOString();
      const duration =
        child.status === "running" || (child.status === "error" && !child.endedAt)
          ? formatDuration(elapsedMs(child.startedAt, child.endedAt ?? nowIso))
          : formatDuration(child.elapsedMs ?? elapsedMs(child.startedAt, child.endedAt ?? nowIso));
      const context = formatContext(child);
      return [child.title, duration, context].filter(Boolean).join(" ");
    })
    .join(" · ");

  return `${aggregate} · ${details}`;
}

export function getSubagentItems(state: SubagentState, parentID?: string) {
  return Object.values(state.children)
    .filter((child) => !parentID || child.parentID === parentID)
    .sort((a, b) => {
      const statusRank = statusSortRank(a.status) - statusSortRank(b.status);
      if (statusRank !== 0) return statusRank;
      return b.startedAt.localeCompare(a.startedAt);
    });
}

export function sumSubagentTokens(state: SubagentState, parentID: string): number {
  return getSubagentItems(state, parentID).reduce((sum, child) => sum + (child.tokens?.total ?? 0), 0);
}

export function pruneStaleSubagents(state: SubagentState, options: { now?: number; staleMs?: number } = {}) {
  const now = options.now ?? Date.now();
  const staleMs = options.staleMs ?? 180_000;
  let changed = false;

  for (const [id, child] of Object.entries(state.children)) {
    if (child.status === "running") continue;
    const lastActivity = Date.parse(child.endedAt ?? child.updatedAt);
    if (!Number.isFinite(lastActivity)) continue;
    if (now - lastActivity <= staleMs) continue;
    delete state.children[id];
    changed = true;
  }

  return changed;
}

export function getSubagentSidebarModel(
  state: SubagentState,
  parentID: string,
  options: { now?: number; staleMs?: number } = {}
): SubagentSidebarModel | undefined {
  pruneStaleSubagents(state, options);
  const children = getSubagentItems(state, parentID);
  if (children.length === 0) return undefined;

  const running = children.filter((child) => child.status === "running").length;
  const done = children.filter((child) => child.status === "done").length;
  const error = children.filter((child) => child.status === "error").length;

  return {
    title: "Subagents",
    summary: `${running} running · ${done} done · ${error} error`,
    rows: children.map((child) => ({
      id: child.id,
      title: formatSubagentTitle(child.title),
      subtitle: [formatSubagentDuration(child, options.now), formatUsage(child), formatActivitySuffix(child.activity)].filter(Boolean).join(" · "),
      status: child.status
    }))
  };
}

export function getSubagentSidebarRowAtLine(model: SubagentSidebarModel, line: number) {
  let rowStart = 2;

  for (const [index, row] of model.rows.entries()) {
    if (index > 0) rowStart += 1;
    if (line === rowStart || line === rowStart + 1) return row;
    rowStart += 2;
  }
}

export function renderSubagentSidebar(state: SubagentState, parentID: string, options: { now?: number } = {}) {
  const model = getSubagentSidebarModel(state, parentID, options);
  if (!model) return "";

  return [
    model.title,
    model.summary,
    ...model.rows.flatMap((row) => [row.title, row.subtitle].filter(Boolean))
  ].join("\n");
}

export function renderSubagentFooter(state: SubagentState, parentID: string, options: { now?: number } = {}) {
  const model = getSubagentSidebarModel(state, parentID, options);
  if (!model) return "";
  return `Subagents ${model.summary}`;
}

function extractTokens(value: unknown): SubagentInfo["tokens"] {
  if (!isRecord(value)) return undefined;
  const input = asNumber(value.input);
  const output = asNumber(value.output);
  const reasoning = asNumber(value.reasoning);
  const cache = isRecord(value.cache) ? value.cache : undefined;
  const cacheRead = asNumber(cache?.read);
  const cacheWrite = asNumber(cache?.write);
  const total =
    asNumber(value.total) ??
    [input, output, reasoning, cacheRead, cacheWrite].reduce<number | undefined>(
      (sum, item) => (item === undefined ? sum : (sum ?? 0) + item),
      undefined
    );
  const contextPercent = asNumber(value.contextPercent);
  if (input === undefined && output === undefined && total === undefined && contextPercent === undefined) return undefined;
  return compactUndefined({ input, output, total, contextPercent });
}

function compactUndefined<T extends Record<string, unknown>>(value: T): T {
  for (const key of Object.keys(value)) {
    if (value[key] === undefined) delete value[key];
  }
  return value;
}

function formatContext(child: SubagentInfo) {
  const total = child.tokens?.total ?? ((child.tokens?.input ?? 0) + (child.tokens?.output ?? 0) || undefined);
  if (typeof total !== "number" || !Number.isFinite(total)) return "";
  const label = Math.round(total) === 1 ? "token" : "tokens";
  return `ctx ${Math.max(0, Math.round(total)).toLocaleString("en-US")} ${label}`;
}

function formatUsage(child: SubagentInfo) {
  const context = formatContext(child);
  const percent = child.tokens?.contextPercent;
  if (typeof percent === "number") return `${context} ${Math.round(percent)}%`.trim();
  return context;
}

function formatSubagentDuration(child: SubagentInfo, now?: number) {
  const nowIso = new Date(now ?? Date.now()).toISOString();
  if (child.status === "running" || (child.status === "error" && !child.endedAt)) {
    return formatDuration(elapsedMs(child.startedAt, child.endedAt ?? nowIso));
  }
  return formatDuration(child.elapsedMs ?? elapsedMs(child.startedAt, child.endedAt ?? nowIso));
}

function formatDuration(ms: number) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function statusSortRank(status: SubagentStatus) {
  if (status === "running") return 0;
  if (status === "error") return 1;
  return 2;
}

function formatSubagentTitle(title: string) {
  const match = title.match(/^(?:[✓✗!]\s*)?([A-Za-z][\w -]*?)\s+[—-]\s+(.+)$/u);
  if (!match) return truncateMiddle(title, 36);
  const agent = match[1]?.trim();
  const task = match[2]?.trim();
  if (!agent || !task) return truncateMiddle(title, 36);
  return truncateMiddle(`${agent}: ${task}`, 36);
}

function truncateMiddle(value: string, maxLength: number) {
  if (value.length <= maxLength) return value;
  if (maxLength <= 3) return value.slice(0, maxLength);
  const marker = "...";
  const left = Math.ceil((maxLength - marker.length) / 2);
  const right = Math.floor((maxLength - marker.length) / 2);
  return `${value.slice(0, left)}${marker}${value.slice(value.length - right)}`;
}

function elapsedMs(start: string, end: string) {
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return 0;
  return Math.max(0, endMs - startMs);
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
