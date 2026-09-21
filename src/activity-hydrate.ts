import { recordChild, recordCompaction, recordSkill, recordToolPart, type ActivityState, type ToolPartInput } from "./activity.js";
import type { CopilotProviderTracker } from "./copilot-usage.js";
import type { GoProviderTracker } from "./go-usage.js";
import { recordAssistantMessage, resetTurnAverage, type MetricsState } from "./metrics.js";

export type ActivitySession = {
  id: string;
  parentID?: string;
  title?: string;
  model?: { providerID?: string };
};

export type MessagePageInput = {
  sessionID: string;
  limit: number;
  order?: "asc" | "desc" | undefined;
  cursor?: string | undefined;
};

export type MessagePage = {
  data: Array<Record<string, unknown>>;
  cursor?: { previous?: string | null; next?: string | null } | undefined;
};

export type ActivityData = {
  session: {
    list(): ActivitySession[];
    message: {
      sync(sessionID: string): Promise<void>;
      list(sessionID: string): Array<Record<string, unknown>>;
      /**
       * Full session history through the client. The host's `message.sync()`
       * loads one newest-first page (20 messages by default), which is the
       * transcript window rather than the whole session.
       */
      history?(sessionID: string): Promise<Array<Record<string, unknown>>>;
    };
  };
};

export type HydrationState = {
  activity: ActivityState;
  metrics: MetricsState;
  goProviders: GoProviderTracker;
  copilotProviders: CopilotProviderTracker;
};

const CONCURRENCY_LIMIT = 4;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isSessionID(value: string): boolean {
  return value.startsWith("ses");
}

function stringFrom(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberFrom(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

type HydratedUsage = {
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
};

function tokenUsage(value: unknown): HydratedUsage {
  if (!isRecord(value)) return {};
  const cache = isRecord(value.cache) ? value.cache : {};
  const usage: HydratedUsage = {};
  const input = numberFrom(value.input);
  if (input !== undefined) usage.inputTokens = input;
  const output = numberFrom(value.output);
  if (output !== undefined) usage.outputTokens = output;
  const reasoning = numberFrom(value.reasoning);
  if (reasoning !== undefined) usage.reasoningTokens = reasoning;
  const cacheRead = numberFrom(cache.read);
  if (cacheRead !== undefined) usage.cacheReadTokens = cacheRead;
  const cacheWrite = numberFrom(cache.write);
  if (cacheWrite !== undefined) usage.cacheWriteTokens = cacheWrite;
  return usage;
}

async function mapConcurrent<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (true) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await fn(items[index]!);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

/** A session should be hydrated unless it already succeeded or is currently in flight. */
export function needsHydration(state: ActivityState, sessionID: string): boolean {
  return !state.hydrated.has(sessionID) && !state.loading.has(sessionID);
}

function collectUnhydrated(state: ActivityState, rootSessionID: string): string[] {  const visited = new Set<string>();
  const result: string[] = [];
  const stack = [rootSessionID];
  while (stack.length > 0) {
    const sessionID = stack.pop();
    if (sessionID === undefined || visited.has(sessionID)) continue;
    visited.add(sessionID);
    if (!state.hydrated.has(sessionID) && !state.loading.has(sessionID)) result.push(sessionID);
    for (const child of state.childrenByParent[sessionID] ?? []) {
      if (!visited.has(child)) stack.push(child);
    }
  }
  return result;
}

function recordProvider(state: HydrationState, sessionID: string, providerID: string | undefined): void {
  if (!providerID) return;
  state.goProviders.record(sessionID, providerID);
  state.copilotProviders.record(sessionID, providerID);
}

function applyToolContent(state: ActivityState, sessionID: string, content: Array<Record<string, unknown>>): void {
  for (const item of content) {
    if (item.type !== "tool" || typeof item.name !== "string") continue;
    const id = stringFrom(item.id);
    const toolState = isRecord(item.state) ? item.state : undefined;
    const status = stringFrom(toolState?.status);
    const error = isRecord(toolState?.error) ? stringFrom(toolState.error.message) : undefined;
    const input = isRecord(toolState?.input) ? toolState.input : undefined;
    recordToolPart(state, sessionID, {
      ...(id !== undefined ? { id } : {}),
      tool: item.name,
      ...(toolState
        ? {
            state: {
              ...(status !== undefined ? { status } : {}),
              ...(input !== undefined ? { input: input as ToolPartInput } : {}),
              ...(error !== undefined ? { error } : {})
            }
          }
        : {})
    });
  }
}

/**
 * Applies one persisted V2 `SessionMessageInfo` variant. Compaction and skill are
 * top-level message variants in V2 (not items inside assistant `content`).
 */
function applyMessage(state: HydrationState, sessionID: string, message: Record<string, unknown>): void {
  const type = stringFrom(message.type);
  if (type === "assistant") {
    const content = Array.isArray(message.content) ? message.content.filter(isRecord) : [];
    if (content.length > 0) applyToolContent(state.activity, sessionID, content);

    const messageID = stringFrom(message.id);
    const time = isRecord(message.time) ? message.time : {};
    const createdAt = numberFrom(time.created);
    const completed = numberFrom(time.completed);
    const completedAt = completed ?? createdAt;
    const streamedAt = numberFrom(time.streamed);
    const finish = stringFrom(message.finish);
    if (messageID !== undefined && createdAt !== undefined && completedAt !== undefined) {
      recordAssistantMessage(state.metrics, {
        sessionID,
        messageID,
        createdAt,
        completedAt,
        // `completedAt` is synthesized for an in-flight message so its usage still
        // counts, but the turn average only covers finished steps — the same rule
        // as the live path, which records a step when the host completes it.
        ...(completed !== undefined && streamedAt !== undefined ? { streamedAt } : {}),
        ...tokenUsage(message.tokens),
        ...(finish !== undefined ? { finish } : {})
      });
    }

    const model = isRecord(message.model) ? message.model : undefined;
    recordProvider(state, sessionID, model ? stringFrom(model.providerID) : undefined);
    return;
  }

  if (type === "idle") {
    // The host marks the end of an execution with an idle record; the native
    // header's tok/s only ever covers the steps after the last one.
    resetTurnAverage(state.metrics, sessionID);
    return;
  }

  if (type === "compaction") {
    const id = stringFrom(message.id);
    if (id !== undefined) recordCompaction(state.activity, sessionID, id, message.reason === "auto");
    return;
  }

  if (type === "skill") {
    const name = stringFrom(message.name) ?? stringFrom(message.skill);
    if (name !== undefined) recordSkill(state.activity, sessionID, stringFrom(message.id), name);
  }
}

/**
 * Histories are walked oldest-first a page at a time. The cap only guards against
 * a cursor that never terminates; ids repeat across page boundaries, so entries
 * already seen are dropped rather than applied twice.
 */
const MAX_MESSAGE_PAGES = 100;

/** The host rejects a larger `limit` with `InvalidRequestError` ("less than or equal to 200"). */
export const MESSAGE_PAGE_SIZE = 200;

export async function listAllMessages(
  fetchPage: (input: MessagePageInput) => Promise<MessagePage>,
  sessionID: string,
  pageSize = MESSAGE_PAGE_SIZE
): Promise<Array<Record<string, unknown>>> {
  const messages: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();
  let cursor: string | undefined;

  for (let page = 0; page < MAX_MESSAGE_PAGES; page += 1) {
    const input: MessagePageInput =
      cursor === undefined ? { sessionID, limit: pageSize, order: "asc" } : { sessionID, limit: pageSize, cursor };
    const response = await fetchPage(input);
    const data = Array.isArray(response?.data) ? response.data : [];
    for (const message of data) {
      const id = isRecord(message) ? stringFrom(message.id) : undefined;
      if (id !== undefined) {
        if (seen.has(id)) continue;
        seen.add(id);
      }
      messages.push(message);
    }
    const next = response?.cursor?.next;
    if (typeof next !== "string" || next.length === 0) break;
    cursor = next;
  }

  return messages;
}

/** The host's newest-first transcript window, used when history paging is unavailable. */
async function loadWindowedMessages(data: ActivityData, sessionID: string): Promise<Array<Record<string, unknown>>> {
  await data.session.message.sync(sessionID);
  return data.session.message.list(sessionID);
}

/**
 * Backfills activity, token metrics, subagents, and provider tracking for a session
 * tree from the V2 `Data` API. Per-session failures leave the session unhydrated so a
 * later call retries it.
 */
export async function hydrateInsights(data: ActivityData, state: HydrationState, rootSessionID: string): Promise<void> {
  if (!isSessionID(rootSessionID)) return;

  let sessions: ActivitySession[] = [];
  try {
    sessions = data.session.list();
  } catch {
    return; // degrade to live-only data
  }
  for (const session of sessions) {
    if (!session.id) continue;
    if (session.title) state.activity.titles[session.id] = session.title;
    if (session.parentID) {
      recordChild(state.activity, session.id, session.parentID);
    }
    recordProvider(state, session.id, session.model?.providerID);
  }

  const toHydrate = collectUnhydrated(state.activity, rootSessionID);
  for (const sessionID of toHydrate) state.activity.loading.add(sessionID);
  await mapConcurrent(toHydrate, CONCURRENCY_LIMIT, async (sessionID) => {
    try {
      const history = data.session.message.history;
      // Session totals must cover every response, so page the full history when the
      // host exposes it and only fall back to the newest-first transcript window.
      const messages = history ? await history(sessionID) : await loadWindowedMessages(data, sessionID);
      for (const message of messages) applyMessage(state, sessionID, message);
      state.activity.hydrated.add(sessionID);
    } catch {
      // leave unhydrated so the next navigation retries
    } finally {
      state.activity.loading.delete(sessionID);
    }
  });
}
