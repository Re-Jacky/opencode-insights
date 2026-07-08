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
};

export type SubagentState = {
  children: Record<string, SubagentInfo>;
  totalExecuted: number;
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

type EventLike = {
  type?: unknown;
  properties?: {
    info?: Record<string, unknown>;
    part?: unknown;
    sessionID?: unknown;
    sessionId?: unknown;
    status?: unknown;
  };
};

export function createSubagentState(): SubagentState {
  return { children: {}, totalExecuted: 0 };
}

export function applySubagentEvent(state: SubagentState, event: unknown) {
  const created = extractTaskToolSubagent(event) ?? extractSubagent(event) ?? updateExistingSubagent(state, event);
  if (!created) return false;

  const previous = state.children[created.id];
  const preserveTerminal = !!previous && isTerminalStatus(previous.status) && created.status === "running";
  const status = preserveTerminal ? previous.status : created.status;
  const title = preserveTerminal ? previous.title : created.title;
  const startedAt = preserveTerminal ? previous.startedAt : created.startedAt;
  const endedAt = preserveTerminal ? previous.endedAt : created.endedAt;
  const next: SubagentInfo = {
    ...previous,
    ...created,
    title,
    status,
    startedAt,
    updatedAt: created.updatedAt,
    endedAt,
    elapsedMs: elapsedMs(startedAt, endedAt ?? created.updatedAt),
    tokens: created.tokens ?? previous?.tokens
  };

  if (!previous) state.totalExecuted += 1;
  state.children[created.id] = next;
  return true;
}

function isTerminalStatus(status: SubagentStatus) {
  return status === "done" || status === "error";
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
      subtitle: [formatSubagentDuration(child, options.now), formatUsage(child)].filter(Boolean).join(" · "),
      status: child.status
    }))
  };
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

function extractTaskToolSubagent(event: unknown): SubagentInfo | undefined {
  if (!isRecord(event)) return undefined;
  const evt = event as EventLike;
  if (evt.type !== "message.part.updated") return undefined;

  const part = isRecord(evt.properties?.part) ? evt.properties.part : undefined;
  if (!part || part.type !== "tool" || part.tool !== "task") return undefined;

  const state = isRecord(part.state) ? part.state : undefined;
  if (!state) return undefined;

  const metadata = isRecord(state.metadata) ? state.metadata : isRecord(part.metadata) ? part.metadata : undefined;
  const id = asString(metadata?.sessionId) ?? sessionIdFromTaskOutput(asString(state.output));
  const parentID = asString(metadata?.parentSessionId) ?? asString(evt.properties?.sessionID);
  if (!id || !parentID || id === parentID) return undefined;

  const status = taskToolStatus(state);
  const startedMs = numberFromPath(state.time, "start") ?? numberFromPath(state.time, "created") ?? Date.now();
  const endedMs = numberFromPath(state.time, "end");
  const updatedMs = endedMs ?? numberFromPath(state.time, "updated") ?? startedMs;
  const input = isRecord(state.input) ? state.input : undefined;
  const agent = asString(input?.subagent_type);
  const taskTitle = asString(state.title) ?? asString(input?.description) ?? "task";

  return {
    id,
    parentID,
    title: agent ? `${agentTitle(agent)}: ${taskTitle}` : taskTitle,
    status,
    startedAt: new Date(startedMs).toISOString(),
    updatedAt: new Date(updatedMs).toISOString(),
    endedAt: status === "running" || typeof endedMs !== "number" ? undefined : new Date(endedMs).toISOString(),
    elapsedMs: Math.max(0, updatedMs - startedMs),
    tokens: extractTokens(state.tokens)
  };
}

function taskToolStatus(state: Record<string, unknown>): SubagentStatus {
  const status = asString(state.status);
  if (status === "completed") return "done";
  if (status === "error") return "error";
  return "running";
}

function sessionIdFromTaskOutput(output: string | undefined) {
  return output?.match(/<task\s+id="([^"]+)"/)?.[1];
}

function agentTitle(agent: string) {
  return agent
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function extractSubagent(event: unknown): SubagentInfo | undefined {
  if (!isRecord(event)) return undefined;
  const evt = event as EventLike;
  if (evt.type !== "session.created" && evt.type !== "session.updated") return undefined;

  const info = isRecord(evt.properties?.info) ? evt.properties.info : undefined;
  if (!info) return undefined;

  const parentID = asString(info.parentID);
  const id = asString(info.id);
  if (!parentID || !id || id === parentID) return undefined;

  const startedMs = numberFromPath(info.time, "created") ?? numberFromPath(info.time, "started") ?? Date.now();
  const completedMs = numberFromPath(info.time, "completed");
  const explicitUpdatedMs = numberFromPath(info.time, "updated");
  const updatedMs = completedMs ?? explicitUpdatedMs ?? startedMs;
  const hasError = info.error !== undefined || asString(info.status) === "error";
  const status: SubagentStatus =
    hasError
      ? "error"
      : typeof completedMs === "number"
        ? "done"
        : "running";
  const terminalMs =
    typeof completedMs === "number"
      ? updatedMs
      : status === "error" && typeof explicitUpdatedMs === "number"
        ? explicitUpdatedMs
        : undefined;
  const endedAt = typeof terminalMs === "number" ? new Date(terminalMs).toISOString() : undefined;

  return {
    id,
    parentID,
    title: asString(info.title) ?? asString(info.name) ?? "subagent",
    status,
    startedAt: new Date(startedMs).toISOString(),
    updatedAt: new Date(updatedMs).toISOString(),
    endedAt,
    elapsedMs: Math.max(0, updatedMs - startedMs),
    tokens: extractTokens(info.tokens)
  };
}

function updateExistingSubagent(state: SubagentState, event: unknown): SubagentInfo | undefined {
  if (!isRecord(event)) return undefined;
  const evt = event as EventLike;
  const sessionID = asString(evt.properties?.sessionID) ?? asString(evt.properties?.sessionId);
  if (!sessionID) return undefined;

  const previous = state.children[sessionID];
  if (!previous) return undefined;

  const info = isRecord(evt.properties?.info) ? evt.properties.info : undefined;
  const status = statusFromEvent(event) ?? previous.status;
  const timestamp = new Date().toISOString();
  const done = status === "done" || status === "error";
  return {
    ...previous,
    status,
    updatedAt: timestamp,
    endedAt: done ? previous.endedAt ?? timestamp : previous.endedAt,
    tokens: extractTokens(info?.tokens) ?? previous.tokens
  };
}

function statusFromEvent(event: unknown): SubagentStatus | undefined {
  if (!isRecord(event)) return undefined;
  const evt = event as EventLike;
  if (evt.type === "session.error") return "error";
  if (evt.type === "session.status" && isRecord(evt.properties?.status)) {
    const statusType = asString(evt.properties.status.type);
    if (statusType === "busy" || statusType === "running") return "running";
    if (statusType === "error") return "error";
  }
  return undefined;
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

function numberFromPath(value: unknown, key: string) {
  if (!isRecord(value)) return undefined;
  return asNumber(value[key]);
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
