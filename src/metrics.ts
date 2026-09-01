export type StreamSample = {
  at: number;
  tokens: number;
};

export type MessageTiming = {
  sessionID: string;
  requestStartAt: number;
  firstResponseAt?: number | undefined;
  firstTokenAt?: number | undefined;
  lastTokenAt?: number | undefined;
  lastToolCallAt?: number | undefined;
};

export type SessionAverage = {
  totalTokens: number;
  totalDurationMs: number;
  totalTtftMs: number;
  messageCount: number;
};

/**
 * Per-message metrics for input-box (current round).
 * AVG = totalTokens(=output+reasoning)/duration where duration = firstTokenAt→endAt (fallback completed-created if hydrated).
 * TTFT = firstTokenAt - requestStartAt. TPS = live estimated tokens / active burst duration (5s window) for this messageID only.
 * Session totals (Token Usage sidebar) remain in SessionTokenUsage/sessionAverageByID (deprecated for prompt-right).
 */
export type MessageMetrics = {
  totalTokens: number;
  durationMs: number;
  ttftMs: number | undefined;
  createdAt: number;
  completedAt: number;
};

export type AssistantResponseUsage = {
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  reasoningTokens?: number | undefined;
  cacheReadTokens?: number | undefined;
  cacheWriteTokens?: number | undefined;
  finish?: string | undefined;
};

export type SessionTokenUsage = {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  responseCount: number;
};

export type PromptRightMetric = "tps" | "avg" | "ttft" | "used" | "cache" | "input" | "output" | "reasoning";

export const DEFAULT_PROMPT_RIGHT_METRICS: PromptRightMetric[] = ["tps", "avg", "used", "cache"];

export type MetricsState = {
  streamSamplesBySession: Record<string, StreamSample[]>;
  streamSamplesByMessageID: Record<string, StreamSample[]>;
  messageTimingByID: Record<string, MessageTiming>;
  messageMetricsByID: Record<string, MessageMetrics>;
  latestMessageIDBySession: Record<string, string>;
  sessionAverageByID: Record<string, SessionAverage>;
  latestResponseUsageBySession: Record<string, AssistantResponseUsage>;
  responseUsageByMessageID: Record<string, { sessionID: string; usage: AssistantResponseUsage }>;
  sessionTokenUsageByID: Record<string, SessionTokenUsage>;
};

const STREAM_WINDOW_MS = 5_000;
const LIVE_STALE_MS = 1_500;
const SINGLE_SAMPLE_MS = 1_000;

export function createMetricsState(): MetricsState {
  return {
    streamSamplesBySession: {},
    streamSamplesByMessageID: {},
    messageTimingByID: {},
    messageMetricsByID: {},
    latestMessageIDBySession: {},
    sessionAverageByID: {},
    latestResponseUsageBySession: {},
    responseUsageByMessageID: {},
    sessionTokenUsageByID: {}
  };
}

/**
 * Estimated tokens for live TPS: ceil(bytes/5). Differs from per-message AVG which uses real output+reasoning tokens.
 * Multibyte (CJK/emoji) inflates bytes but may over/undercount vs real tokenizer.
 */
export function estimateStreamTokens(delta: string) {
  return Math.max(1, Math.ceil(Buffer.byteLength(delta, "utf8") / 5));
}

export function recordAssistantMessage(
  state: MetricsState,
  input: {
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
  }
) {
  if (typeof input.completedAt !== "number") {
    const existing = state.messageTimingByID[input.messageID];
    state.messageTimingByID[input.messageID] = {
      sessionID: input.sessionID,
      requestStartAt: input.createdAt,
      firstResponseAt: existing?.firstResponseAt,
      firstTokenAt: existing?.firstTokenAt,
      lastTokenAt: existing?.lastTokenAt,
      lastToolCallAt: existing?.lastToolCallAt
    };
    // Track latest message for per-message live TPS even before completion
    state.latestMessageIDBySession[input.sessionID] = input.messageID;
    return;
  }

  const usage = compactUsage({
    inputTokens: input.inputTokens,
    outputTokens: input.outputTokens,
    reasoningTokens: input.reasoningTokens,
    cacheReadTokens: input.cacheReadTokens,
    cacheWriteTokens: input.cacheWriteTokens,
    finish: input.finish
  });
  if (hasTokenUsage(usage)) {
    state.latestResponseUsageBySession[input.sessionID] = usage;
    state.responseUsageByMessageID[input.messageID] = { sessionID: input.sessionID, usage };
    rebuildSessionTokenUsage(state, input.sessionID);
  }

  // Always track latest message for per-message prompt-right metrics
  state.latestMessageIDBySession[input.sessionID] = input.messageID;

  const timing = state.messageTimingByID[input.messageID];
  const totalTokens = (input.outputTokens ?? 0) + (input.reasoningTokens ?? 0);

  let durationMs: number | undefined;
  let ttftMs: number | undefined;

  if (timing?.sessionID === input.sessionID && typeof (timing.firstTokenAt ?? timing.firstResponseAt) === "number") {
    const first = timing.firstTokenAt ?? timing.firstResponseAt!;
    const endAt = input.finish === "tool-calls" ? (timing.lastToolCallAt ?? input.completedAt) : input.completedAt;
    durationMs = typeof endAt === "number" ? Math.max(endAt - first, 1) : undefined;
    ttftMs = Math.max(first - timing.requestStartAt, 0);
  } else {
    // Hydration or race: no timing, fallback to wall time
    durationMs = Math.max(input.completedAt - input.createdAt, 1);
    ttftMs = undefined;
  }

  if (totalTokens > 0 && durationMs) {
    state.messageMetricsByID[input.messageID] = {
      totalTokens,
      durationMs,
      ttftMs,
      createdAt: input.createdAt,
      completedAt: input.completedAt
    };

    // Keep sessionAverageByID for backward compat / sidebar analytics (weighted throughput)
    if (ttftMs !== undefined) {
      const firstForSession = timing?.firstTokenAt ?? timing?.firstResponseAt;
      const endForSession = timing ? (input.finish === "tool-calls" ? (timing.lastToolCallAt ?? input.completedAt) : input.completedAt) : input.completedAt;
      const sessionDuration = timing && firstForSession && typeof endForSession === "number" ? Math.max(endForSession - firstForSession, 1) : durationMs;
      const sessionTtft = ttftMs;
      const totals =
        state.sessionAverageByID[input.sessionID] ??
        {
          totalTokens: 0,
          totalDurationMs: 0,
          totalTtftMs: 0,
          messageCount: 0
        };
      state.sessionAverageByID[input.sessionID] = {
        totalTokens: totals.totalTokens + totalTokens,
        totalDurationMs: totals.totalDurationMs + sessionDuration,
        totalTtftMs: totals.totalTtftMs + sessionTtft,
        messageCount: totals.messageCount + 1
      };
    } else {
      // Hydrated without TTFT: still count tokens/duration but not TTFT (do not dilute session TTFT average)
      const totals =
        state.sessionAverageByID[input.sessionID] ??
        {
          totalTokens: 0,
          totalDurationMs: 0,
          totalTtftMs: 0,
          messageCount: 0
        };
      state.sessionAverageByID[input.sessionID] = {
        totalTokens: totals.totalTokens + totalTokens,
        totalDurationMs: totals.totalDurationMs + durationMs,
        totalTtftMs: totals.totalTtftMs,
        messageCount: totals.messageCount
      };
    }
  }

  delete state.messageTimingByID[input.messageID];
  delete state.streamSamplesByMessageID[input.messageID];
  pruneSamples(state, input.completedAt);
}

export function recordAssistantDelta(
  state: MetricsState,
  input: { sessionID: string; messageID: string; delta: string; at: number }
) {
  const sample = {
    at: input.at,
    tokens: estimateStreamTokens(input.delta)
  };
  // Per-message samples (primary for live TPS current round)
  state.streamSamplesByMessageID[input.messageID] = [
    ...(state.streamSamplesByMessageID[input.messageID] ?? []).filter((item) => input.at - item.at <= STREAM_WINDOW_MS),
    sample
  ];
  // Keep session copy for backward compat (deprecated)
  state.streamSamplesBySession[input.sessionID] = [
    ...(state.streamSamplesBySession[input.sessionID] ?? []).filter((item) => input.at - item.at <= STREAM_WINDOW_MS),
    sample
  ];

  // Ensure latestMessageIDBySession tracks streaming message
  state.latestMessageIDBySession[input.sessionID] = input.messageID;

  const timing = state.messageTimingByID[input.messageID];
  if (timing) {
    state.messageTimingByID[input.messageID] = timing.firstTokenAt
      ? { ...timing, lastTokenAt: input.at }
      : {
          ...timing,
          firstResponseAt: timing.firstResponseAt ?? input.at,
          firstTokenAt: input.at,
          lastTokenAt: input.at
        };
  }
}

export function recordToolActivity(state: MetricsState, sessionID: string, messageID: string, at = Date.now()) {
  if (state.streamSamplesByMessageID[messageID]?.length) {
    delete state.streamSamplesByMessageID[messageID];
  }
  if (state.streamSamplesBySession[sessionID]?.length) {
    delete state.streamSamplesBySession[sessionID];
  }
  const timing = state.messageTimingByID[messageID];
  if (timing) {
    state.messageTimingByID[messageID] = {
      ...timing,
      lastToolCallAt: at,
      firstResponseAt: timing.firstResponseAt ?? at
    };
  }
}

export function renderMetricsText(
  state: MetricsState,
  sessionID: string,
  options: { now?: number; idle?: boolean } = {}
) {
  const live = liveTps(state, sessionID, options) ?? "-";
  const msgID = state.latestMessageIDBySession[sessionID];
  const hasPerMessage = !!msgID && !!state.messageMetricsByID[msgID];
  const avg = hasPerMessage ? (messageAverage(state, sessionID) ?? "-") : (sessionAverage(state, sessionID) ?? "-");
  const ttft = hasPerMessage ? (messageTtft(state, sessionID) ?? "-") : (sessionTtft(state, sessionID) ?? "-");
  return `TPS ${live} | AVG ${avg} | TTFT ${ttft}`;
}

export function renderResponseMetricsText(state: MetricsState, sessionID: string) {
  const usage = state.latestResponseUsageBySession[sessionID];
  if (!usage || !hasTokenUsage(usage)) return "";

  const used = sumTokens(usage);
  const cacheRate = cacheReadRate(usage);
  const parts = [
    used === undefined ? undefined : `${formatTokenCount(used)} used`,
    cacheRate === undefined ? undefined : `${formatPercent(cacheRate)} cache`,
    usage.outputTokens === undefined ? undefined : `${formatTokenCount(usage.outputTokens)} out`,
    usage.reasoningTokens === undefined ? undefined : `${formatTokenCount(usage.reasoningTokens)} think`
  ].filter((part): part is string => !!part);
  return parts.join(" | ");
}

export function renderPromptRightMetricsText(
  state: MetricsState,
  sessionID: string,
  options: { now?: number; idle?: boolean; metrics?: PromptRightMetric[] } = {}
) {
  const usage = state.latestResponseUsageBySession[sessionID];
  const used = usage ? sumTokens(usage) : undefined;
  const cacheRate = usage ? cacheReadRate(usage) : undefined;
  const msgID = state.latestMessageIDBySession[sessionID];
  const hasPerMessage = !!msgID && !!state.messageMetricsByID[msgID];
  const avgVal = hasPerMessage ? messageAverage(state, sessionID) : sessionAverage(state, sessionID);
  const ttftVal = hasPerMessage ? messageTtft(state, sessionID) : sessionTtft(state, sessionID);
  const values: Record<PromptRightMetric, string> = {
    tps: `TPS ${liveTps(state, sessionID, options) ?? "-"}`,
    avg: `AVG ${avgVal ?? "-"}`,
    ttft: `TTFT ${ttftVal ?? "-"}`,
    used: `${used === undefined ? "-" : formatTokenCount(used)} used`,
    cache: `${cacheRate === undefined ? "-" : formatPercent(cacheRate)} cache`,
    input: `${usage?.inputTokens === undefined ? "-" : formatTokenCount(usage.inputTokens)} in`,
    output: `${usage?.outputTokens === undefined ? "-" : formatTokenCount(usage.outputTokens)} out`,
    reasoning: `${usage?.reasoningTokens === undefined ? "-" : formatTokenCount(usage.reasoningTokens)} think`
  };
  return (options.metrics?.length ? options.metrics : DEFAULT_PROMPT_RIGHT_METRICS).map((metric) => values[metric]).join(" | ");
}

export function getSessionTokenUsage(state: MetricsState, sessionID: string) {
  return state.sessionTokenUsageByID[sessionID];
}

export function renderSessionTokenUsage(state: MetricsState, sessionID: string, subagentTokens = 0) {
  const usage = getSessionTokenUsage(state, sessionID);
  if (!usage) return "";

  const grandTotal = usage.totalTokens + subagentTokens;
  const cachePromptTokens = usage.inputTokens + usage.cacheReadTokens;
  const cacheRate = cachePromptTokens > 0 ? (usage.cacheReadTokens / cachePromptTokens) * 100 : undefined;
  const lines = [
    "Token Usage",
    `${formatTokenCount(grandTotal)} total · ${usage.responseCount} responses`
  ];
  if (subagentTokens > 0) {
    lines.push(`${formatTokenCount(subagentTokens)} used by subagents`);
  }
  lines.push(
    `${formatTokenCount(usage.inputTokens)} input`,
    `${formatTokenCount(usage.outputTokens)} output`,
    `${formatTokenCount(usage.reasoningTokens)} reasoning`,
    `${formatTokenCount(usage.cacheReadTokens)} cache read`,
    `${formatTokenCount(usage.cacheWriteTokens)} cache write`,
    `${cacheRate === undefined ? "-" : formatPercent(cacheRate)} cache rate`
  );
  return lines.join("\n");
}

function pruneSamples(state: MetricsState, now = Date.now()) {
  for (const [messageID, samples] of Object.entries(state.streamSamplesByMessageID)) {
    const next = samples.filter((sample) => now - sample.at <= STREAM_WINDOW_MS);
    if (next.length > 0) state.streamSamplesByMessageID[messageID] = next;
    else delete state.streamSamplesByMessageID[messageID];
  }
  for (const [sessionID, samples] of Object.entries(state.streamSamplesBySession)) {
    const next = samples.filter((sample) => now - sample.at <= STREAM_WINDOW_MS);
    if (next.length > 0) state.streamSamplesBySession[sessionID] = next;
    else delete state.streamSamplesBySession[sessionID];
  }
}

function rebuildSessionTokenUsage(state: MetricsState, sessionID: string) {
  const usage: SessionTokenUsage = {
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    responseCount: 0
  };

  for (const response of Object.values(state.responseUsageByMessageID)) {
    if (response.sessionID !== sessionID) continue;
    usage.inputTokens += response.usage.inputTokens ?? 0;
    usage.outputTokens += response.usage.outputTokens ?? 0;
    usage.reasoningTokens += response.usage.reasoningTokens ?? 0;
    usage.cacheReadTokens += response.usage.cacheReadTokens ?? 0;
    usage.cacheWriteTokens += response.usage.cacheWriteTokens ?? 0;
    usage.responseCount += 1;
  }

  usage.totalTokens = usage.inputTokens + usage.outputTokens + usage.reasoningTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
  state.sessionTokenUsageByID[sessionID] = usage;
}

function messageAverage(state: MetricsState, sessionID: string) {
  const msgID = state.latestMessageIDBySession[sessionID];
  if (!msgID) return undefined;
  const m = state.messageMetricsByID[msgID];
  if (!m || m.totalTokens <= 0 || m.durationMs <= 0) return undefined;
  return formatRate(m.totalTokens / (m.durationMs / 1000), "AVG");
}

function messageTtft(state: MetricsState, sessionID: string) {
  const msgID = state.latestMessageIDBySession[sessionID];
  if (!msgID) return undefined;
  const m = state.messageMetricsByID[msgID];
  if (!m || m.ttftMs === undefined || m.ttftMs < 0) return undefined;
  return formatTtft(m.ttftMs / 1000);
}

function sessionAverage(state: MetricsState, sessionID: string) {
  const totals = state.sessionAverageByID[sessionID];
  if (!totals || totals.totalTokens <= 0 || totals.totalDurationMs <= 0) return undefined;
  return formatRate(totals.totalTokens / (totals.totalDurationMs / 1000), "AVG");
}

function sessionTtft(state: MetricsState, sessionID: string) {
  const totals = state.sessionAverageByID[sessionID];
  if (!totals || totals.messageCount <= 0 || totals.totalTtftMs < 0) return undefined;
  return formatTtft(totals.totalTtftMs / totals.messageCount / 1000);
}

function liveTps(
  state: MetricsState,
  sessionID: string,
  options: { now?: number; idle?: boolean } = {}
) {
  if (options.idle) return undefined;
  const now = options.now ?? Date.now();
  const msgID = state.latestMessageIDBySession[sessionID];
  // Prefer per-message samples, fallback to session for backward compat during transition
  const samples = (msgID ? state.streamSamplesByMessageID[msgID] : undefined) ?? state.streamSamplesBySession[sessionID] ?? [];
  const relevant = samples.filter((sample) => now - sample.at <= STREAM_WINDOW_MS);
  if (relevant.length === 0) return undefined;
  const lastSample = relevant.at(-1);
  if (!lastSample || now - lastSample.at > LIVE_STALE_MS) return undefined;
  const total = relevant.reduce((sum, sample) => sum + sample.tokens, 0);
  const durationSeconds = activeDurationMs(relevant, now) / 1000;
  if (durationSeconds <= 0) return undefined;
  return formatRate(total / durationSeconds, "TPS");
}

function activeDurationMs(samples: StreamSample[], tailAt?: number) {
  if (samples.length === 0) return 0;
  if (samples.length === 1) {
    const tailDuration = tailAt ? Math.max(0, tailAt - samples[0]!.at) : SINGLE_SAMPLE_MS;
    return Math.min(Math.max(tailDuration, 250), SINGLE_SAMPLE_MS);
  }

  let duration = 0;
  for (let index = 1; index < samples.length; index++) {
    duration += Math.max(0, samples[index]!.at - samples[index - 1]!.at);
  }

  if (tailAt) {
    duration += Math.max(0, tailAt - samples.at(-1)!.at);
  }

  return Math.max(duration, SINGLE_SAMPLE_MS);
}

function formatRate(value: number, label: "TPS" | "AVG") {
  if (!Number.isFinite(value) || value <= 0) return undefined;
  const suffix = label === "TPS" ? " TPS" : "";
  if (value >= 100) return `${Math.round(value)}${suffix}`;
  if (value >= 10) return `${value.toFixed(1)}${suffix}`;
  return `${value.toFixed(2)}${suffix}`;
}

function formatTtft(value: number) {
  if (!Number.isFinite(value) || value < 0) return undefined;
  return `${value.toFixed(1)}s`;
}

function compactUsage(usage: AssistantResponseUsage) {
  return Object.fromEntries(Object.entries(usage).filter(([, value]) => value !== undefined)) as AssistantResponseUsage;
}

function hasTokenUsage(usage: AssistantResponseUsage) {
  return [usage.inputTokens, usage.outputTokens, usage.reasoningTokens, usage.cacheReadTokens, usage.cacheWriteTokens].some(
    (value) => typeof value === "number"
  );
}

function sumTokens(usage: AssistantResponseUsage) {
  const values = [usage.inputTokens, usage.outputTokens, usage.reasoningTokens, usage.cacheReadTokens, usage.cacheWriteTokens].filter(
    (value): value is number => typeof value === "number"
  );
  return values.length ? values.reduce((sum, value) => sum + value, 0) : undefined;
}

function cacheReadRate(usage: AssistantResponseUsage) {
  if (typeof usage.cacheReadTokens !== "number") return undefined;
  const promptTokens = (usage.inputTokens ?? 0) + usage.cacheReadTokens;
  return promptTokens > 0 ? (usage.cacheReadTokens / promptTokens) * 100 : undefined;
}

function formatTokenCount(value: number) {
  if (Math.abs(value) >= 1_000_000) return `${formatAbbreviatedTokenCount(value, 1_000_000)}m`;
  if (Math.abs(value) >= 1_000) return `${formatAbbreviatedTokenCount(value, 1_000)}k`;
  return String(Math.round(value));
}

function formatPercent(value: number) {
  return `${(Math.round(value * 100) / 100).toFixed(2)}%`;
}

function formatAbbreviatedTokenCount(value: number, divisor: number) {
  return (Math.round((value / divisor) * 10) / 10).toFixed(1);
}
