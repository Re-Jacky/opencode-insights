import { formatActivitySuffix, type SessionActivity } from "./activity.js";
import { formatTokenCount } from "./metrics.js";

export type SubagentStatus = "running" | "done" | "error";

export type SubagentTokens = {
  input?: number | undefined;
  output?: number | undefined;
  reasoning?: number | undefined;
  cache?: { read?: number | undefined; write?: number | undefined } | undefined;
};

/**
 * The host's native view of one child session (`data.session.list()` plus
 * `data.session.status()`). Liveness and identity live in that store, so this
 * plugin never derives subagent state from the event stream.
 */
export type SubagentSession = {
  id: string;
  title?: string | undefined;
  agent?: string | undefined;
  outcome?: string | undefined;
  status: "idle" | "running";
  time?: { created?: number | undefined; idle?: number | undefined; updated?: number | undefined } | undefined;
  tokens?: SubagentTokens | undefined;
};

/** Anything the host reports tokens for — a child session or a bare usage record. */
export type TokenBearing = { tokens?: SubagentTokens | undefined };

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

export function subagentStatus(session: SubagentSession): SubagentStatus {
  // The host store owns liveness: only it can say a child is still working.
  if (session.status === "running") return "running";
  return session.outcome === "failed" ? "error" : "done";
}

/**
 * When a finished subagent stopped. The host's `time.idle` is the real stamp;
 * `time.updated` is not (it is left alone when an execution ends), so an
 * unstamped session falls back to the moment we first saw it idle rather than
 * to a duration that would be wrong or would keep counting.
 */
function endedAt(session: SubagentSession, observedIdleAt?: (id: string) => number | undefined): number | undefined {
  if (session.status === "running") return undefined;
  const idle = session.time?.idle;
  if (idle !== undefined) return idle;
  return observedIdleAt?.(session.id);
}

function lastSeenAt(session: SubagentSession, observedIdleAt?: (id: string) => number | undefined): number | undefined {
  return endedAt(session, observedIdleAt) ?? session.time?.updated ?? session.time?.created;
}

export function getSubagentSidebarModel(
  sessions: SubagentSession[],
  options: {
    now?: number | undefined;
    staleMs?: number | undefined;
    activity?: ((id: string) => SessionActivity | undefined) | undefined;
    observedIdleAt?: ((id: string) => number | undefined) | undefined;
  } = {}
): SubagentSidebarModel | undefined {
  const now = options.now ?? Date.now();
  const staleMs = options.staleMs ?? 180_000;

  const visible = sessions.filter((session) => {
    if (session.id.length === 0) return false;
    if (session.status === "running") return true;
    const last = lastSeenAt(session, options.observedIdleAt);
    return last === undefined || now - last <= staleMs;
  });
  if (visible.length === 0) return undefined;

  const rows = visible
    .map((session) => ({ session, status: subagentStatus(session) }))
    .sort((a, b) => {
      const rank = statusRank(a.status) - statusRank(b.status);
      if (rank !== 0) return rank;
      return (b.session.time?.created ?? 0) - (a.session.time?.created ?? 0);
    })
    .map(({ session, status }) => ({
      id: session.id,
      title: formatSubagentTitle(session),
      subtitle: [
        formatSubagentDuration(session, now, options.observedIdleAt),
        formatSubagentTokens(session),
        formatActivitySuffix(options.activity?.(session.id))
      ]
        .filter(Boolean)
        .join(" · "),
      status
    }));

  const running = rows.filter((row) => row.status === "running").length;
  const done = rows.filter((row) => row.status === "done").length;
  const error = rows.filter((row) => row.status === "error").length;

  return { title: "Subagents", summary: `${running} running · ${done} done · ${error} error`, rows };
}

/** Total tokens the host attributed to this session, across every bucket it reports. */
export function subagentTokenTotal(session: TokenBearing): number | undefined {
  const values = [
    session.tokens?.input,
    session.tokens?.output,
    session.tokens?.reasoning,
    session.tokens?.cache?.read,
    session.tokens?.cache?.write
  ].filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  if (values.length === 0) return undefined;
  return values.reduce((sum, value) => sum + value, 0);
}

export function sumSubagentTokens(sessions: TokenBearing[]): number {
  return sessions.reduce((sum, session) => sum + (subagentTokenTotal(session) ?? 0), 0);
}

function statusRank(status: SubagentStatus) {
  if (status === "running") return 0;
  if (status === "error") return 1;
  return 2;
}

/** The host suffixes some child titles with `(@agent subagent)`; the row shows the agent itself. */
const NATIVE_TITLE_SUFFIX = /\s*\(@[\w.-]+ subagent\)\s*$/u;

function formatSubagentTitle(session: SubagentSession) {
  const task = (session.title ?? "").replace(NATIVE_TITLE_SUFFIX, "").trim();
  const agent = session.agent?.trim();
  const label = agent && task ? `${agent}: ${task}` : task || agent || "subagent";
  return truncateMiddle(label, 36);
}

function formatSubagentDuration(
  session: SubagentSession,
  now: number,
  observedIdleAt?: (id: string) => number | undefined
) {
  const start = session.time?.created;
  if (start === undefined) return "";
  const end = session.status === "running" ? now : endedAt(session, observedIdleAt);
  if (end === undefined) return "";
  return formatDuration(elapsedMs(start, end));
}

function formatSubagentTokens(session: SubagentSession) {
  const total = subagentTokenTotal(session);
  if (total === undefined || total <= 0) return "";
  return `${formatTokenCount(total)} tokens`;
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

function truncateMiddle(value: string, maxLength: number) {
  if (value.length <= maxLength) return value;
  if (maxLength <= 3) return value.slice(0, maxLength);
  const marker = "...";
  const left = Math.ceil((maxLength - marker.length) / 2);
  const right = Math.floor((maxLength - marker.length) / 2);
  return `${value.slice(0, left)}${marker}${value.slice(value.length - right)}`;
}

function elapsedMs(start: number, end: number) {
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0;
  return Math.max(0, end - start);
}
