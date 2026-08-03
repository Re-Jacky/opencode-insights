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

export type AssistantResponseUsage = {
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  reasoningTokens?: number | undefined;
  cacheReadTokens?: number | undefined;
  cacheWriteTokens?: number | undefined;
  finish?: string | undefined;
};

export type PromptRightMetric = "tps" | "avg" | "ttft" | "used" | "cache" | "input" | "output" | "reasoning";

export const DEFAULT_PROMPT_RIGHT_METRICS: PromptRightMetric[] = ["tps", "avg", "used", "cache"];

export type MetricsState = {
  streamSamplesBySession: Record<string, StreamSample[]>;
  messageTimingByID: Record<string, MessageTiming>;
  sessionAverageByID: Record<string, SessionAverage>;
  latestResponseUsageBySession: Record<string, AssistantResponseUsage>;
};

const STREAM_WINDOW_MS = 5_000;
const LIVE_STALE_MS = 1_500;
const SINGLE_SAMPLE_MS = 1_000;

export function createMetricsState(): MetricsState {
  return {
    streamSamplesBySession: {},
    messageTimingByID: {},
    sessionAverageByID: {},
    latestResponseUsageBySession: {}
  };
}

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
  if (hasTokenUsage(usage)) state.latestResponseUsageBySession[input.sessionID] = usage;

  const timing = state.messageTimingByID[input.messageID];
  if (timing?.sessionID === input.sessionID && typeof timing.firstResponseAt === "number") {
    const totalTokens = (input.outputTokens ?? 0) + (input.reasoningTokens ?? 0);
    const endAt = input.finish === "tool-calls" ? timing.lastToolCallAt : input.completedAt;
    const durationMs = typeof endAt === "number" ? Math.max(endAt - timing.firstResponseAt, 1) : undefined;
    const ttftMs = Math.max(timing.firstResponseAt - timing.requestStartAt, 0);
    if (totalTokens > 0 && durationMs) {
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
        totalTtftMs: totals.totalTtftMs + ttftMs,
        messageCount: totals.messageCount + 1
      };
    }
  }

  delete state.messageTimingByID[input.messageID];
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
  state.streamSamplesBySession[input.sessionID] = [
    ...(state.streamSamplesBySession[input.sessionID] ?? []).filter((item) => input.at - item.at <= STREAM_WINDOW_MS),
    sample
  ];

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
  const avg = sessionAverage(state, sessionID) ?? "-";
  const ttft = sessionTtft(state, sessionID) ?? "-";
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
  const values: Record<PromptRightMetric, string> = {
    tps: `TPS ${liveTps(state, sessionID, options) ?? "-"}`,
    avg: `AVG ${sessionAverage(state, sessionID) ?? "-"}`,
    ttft: `TTFT ${sessionTtft(state, sessionID) ?? "-"}`,
    used: `${used === undefined ? "-" : formatTokenCount(used)} used`,
    cache: `${cacheRate === undefined ? "-" : formatPercent(cacheRate)} cache`,
    input: `${usage?.inputTokens === undefined ? "-" : formatTokenCount(usage.inputTokens)} in`,
    output: `${usage?.outputTokens === undefined ? "-" : formatTokenCount(usage.outputTokens)} out`,
    reasoning: `${usage?.reasoningTokens === undefined ? "-" : formatTokenCount(usage.reasoningTokens)} think`
  };
  return (options.metrics?.length ? options.metrics : DEFAULT_PROMPT_RIGHT_METRICS).map((metric) => values[metric]).join(" | ");
}

function pruneSamples(state: MetricsState, now = Date.now()) {
  for (const [sessionID, samples] of Object.entries(state.streamSamplesBySession)) {
    const next = samples.filter((sample) => now - sample.at <= STREAM_WINDOW_MS);
    if (next.length > 0) state.streamSamplesBySession[sessionID] = next;
    else delete state.streamSamplesBySession[sessionID];
  }
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
  const samples = state.streamSamplesBySession[sessionID] ?? [];
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
  return `${(Math.round(value * 10) / 10).toFixed(1).replace(/\.0$/u, "")}%`;
}

function formatAbbreviatedTokenCount(value: number, divisor: number) {
  return (Math.round((value / divisor) * 10) / 10).toFixed(1);
}
