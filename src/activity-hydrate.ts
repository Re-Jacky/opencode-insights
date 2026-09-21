import { recordChild, recordCompaction, recordToolPart, type ActivityState } from "./activity.js";

export type ActivityData = {
  session: {
    list(): Array<{ id: string; parentID?: string; title?: string }>;
    message: {
      sync(sessionID: string): Promise<void>;
      list(sessionID: string): Array<Record<string, unknown>>;
    };
  };
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

function collectUnhydrated(state: ActivityState, rootSessionID: string): string[] {
  const visited = new Set<string>();
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

function applyContent(state: ActivityState, sessionID: string, content: Array<Record<string, unknown>>): void {
  for (const item of content) {
    const id = stringFrom(item.id);
    if (item.type === "tool" && typeof item.name === "string") {
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
                ...(input !== undefined ? { input: input as { name?: string } } : {}),
                ...(error !== undefined ? { error } : {})
              }
            }
          : {})
      });
    } else if (item.type === "compaction" && id !== undefined) {
      recordCompaction(state, sessionID, id, item.reason === "auto");
    }
  }
}

export async function hydrateActivity(data: ActivityData, state: ActivityState, rootSessionID: string): Promise<void> {
  if (!isSessionID(rootSessionID)) return;

  let sessions: Array<{ id: string; parentID?: string; title?: string }> = [];
  try {
    sessions = data.session.list();
  } catch {
    return; // degrade to live-only data
  }
  for (const session of sessions) {
    if (!session.id) continue;
    if (session.title) state.titles[session.id] = session.title;
    if (session.parentID) recordChild(state, session.id, session.parentID);
  }

  const toHydrate = collectUnhydrated(state, rootSessionID);
  for (const sessionID of toHydrate) state.loading.add(sessionID);
  await mapConcurrent(toHydrate, CONCURRENCY_LIMIT, async (sessionID) => {
    try {
      await data.session.message.sync(sessionID);
      const messages = data.session.message.list(sessionID);
      for (const message of messages) {
        const content = Array.isArray(message.content) ? message.content.filter(isRecord) : [];
        if (content.length > 0) applyContent(state, sessionID, content);
      }
      state.hydrated.add(sessionID);
    } catch {
      // leave unhydrated so the next navigation retries
    } finally {
      state.loading.delete(sessionID);
    }
  });
}
