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

type EventLike = {
  type?: unknown;
  properties?: {
    info?: Record<string, unknown>;
    sessionID?: unknown;
    sessionId?: unknown;
  };
};

export function createSubagentState(): SubagentState {
  return { children: {}, totalExecuted: 0 };
}

export function applySubagentEvent(state: SubagentState, event: unknown) {
  const created = extractSubagent(event);
  if (!created) return false;

  const previous = state.children[created.id];
  const next: SubagentInfo = {
    ...previous,
    ...created,
    status: created.status,
    updatedAt: created.updatedAt,
    elapsedMs: elapsedMs(created.startedAt, created.endedAt ?? created.updatedAt),
    tokens: created.tokens ?? previous?.tokens
  };

  if (!previous) state.totalExecuted += 1;
  state.children[created.id] = next;
  return true;
}

export function renderSubagentStatus(state: SubagentState, options: { now?: number } = {}) {
  const children = Object.values(state.children).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  const running = children.filter((child) => child.status === "running").length;
  const done = children.filter((child) => child.status === "done").length;
  const error = children.filter((child) => child.status === "error").length;
  const aggregate = `↳ ${running} running · ${done} done · ${error} error · Σ ${state.totalExecuted} total`;

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

function extractSubagent(event: unknown): SubagentInfo | undefined {
  if (!isRecord(event)) return undefined;
  const evt = event as EventLike;
  const info = isRecord(evt.properties?.info) ? evt.properties.info : undefined;
  if (!info) return undefined;

  const parentID = asString(info.parentID);
  const id = asString(info.id);
  if (!parentID || !id || id === parentID) return undefined;

  const startedMs = numberFromPath(info.time, "created") ?? numberFromPath(info.time, "started") ?? Date.now();
  const completedMs = numberFromPath(info.time, "completed");
  const hasError = info.error !== undefined || asString(info.status) === "error";
  const status: SubagentStatus = hasError ? "error" : typeof completedMs === "number" ? "done" : "running";
  const updatedMs = completedMs ?? numberFromPath(info.time, "updated") ?? startedMs;
  const endedAt = typeof completedMs === "number" ? new Date(updatedMs).toISOString() : undefined;

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

function extractTokens(value: unknown): SubagentInfo["tokens"] {
  if (!isRecord(value)) return undefined;
  const input = asNumber(value.input);
  const output = asNumber(value.output);
  const total = asNumber(value.total) ?? (input !== undefined || output !== undefined ? (input ?? 0) + (output ?? 0) : undefined);
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
