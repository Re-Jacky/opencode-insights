import { recordChild, recordCompaction, recordStep, recordToolPart, type ActivityState } from "./activity.js";

export type ActivityClient = {
  session: {
    list(input: { limit?: number }): Promise<{ data?: Array<{ id: string; parentID?: string; title?: string }> }>;
    messages(input: { sessionID: string }): Promise<{ data?: Array<{ parts?: Array<Record<string, unknown>> }> }>;
  };
};

const CONCURRENCY_LIMIT = 4;
const LIST_LIMIT = 1000;

function isSessionID(value: string): boolean {
  return value.startsWith("ses");
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
    const children = state.childrenByParent[sessionID] ?? [];
    for (const child of children) {
      if (!visited.has(child)) stack.push(child);
    }
  }
  return result;
}

function applyParts(state: ActivityState, sessionID: string, parts: Array<Record<string, unknown>>): void {
  for (const part of parts) {
    const id = typeof part.id === "string" ? part.id : undefined;
    const type = part.type;
    if (type === "tool" && typeof part.tool === "string") {
      recordToolPart(state, sessionID, {
        ...(id !== undefined ? { id } : {}),
        tool: part.tool,
        ...(typeof part.state === "object" && part.state !== null && !Array.isArray(part.state)
          ? { state: part.state as { status?: string; input?: { name?: string }; error?: string } }
          : {})
      });
    } else if (type === "compaction" && id !== undefined) {
      recordCompaction(state, sessionID, id, part.auto === true);
    } else if (type === "step-finish" && id !== undefined) {
      recordStep(state, sessionID, id);
    }
  }
}

export async function hydrateActivity(client: ActivityClient, state: ActivityState, rootSessionID: string): Promise<void> {
  if (!isSessionID(rootSessionID)) return;
  let sessions: Array<{ id: string; parentID?: string; title?: string }> = [];
  try {
    const response = await client.session.list({ limit: LIST_LIMIT });
    sessions = response.data ?? [];
  } catch {
    return; // degrade to live-only data
  }
  for (const session of sessions) {
    if (session.id) {
      if (session.title) state.titles[session.id] = session.title;
      if (session.parentID) recordChild(state, session.id, session.parentID);
    }
  }

  const toHydrate = collectUnhydrated(state, rootSessionID);
  for (const sessionID of toHydrate) state.loading.add(sessionID);
  await mapConcurrent(toHydrate, CONCURRENCY_LIMIT, async (sessionID) => {
    try {
      const response = await client.session.messages({ sessionID });
      const messages = response.data ?? [];
      for (const message of messages) {
        if (message.parts && message.parts.length > 0) {
          applyParts(state, sessionID, message.parts);
        }
      }
      state.hydrated.add(sessionID);
    } catch {
      // leave unhydrated so the next navigation retries
    } finally {
      state.loading.delete(sessionID);
    }
  });
}
