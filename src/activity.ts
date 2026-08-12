export type SessionActivity = {
  toolCalls: number;
  toolBreakdown: Record<string, number>;
  errors: number;
  skills: Record<string, number>;
  autoCompacts: number;
  steps: number;
};

export type ActivityState = {
  bySessionID: Record<string, SessionActivity>;
  childrenByParent: Record<string, string[]>;
  titles: Record<string, string>;
  hydrated: Set<string>;
  seenKeys: Record<string, Set<string>>;
  loading: Set<string>;
};

export function createActivityState(): ActivityState {
  return {
    bySessionID: {},
    childrenByParent: {},
    titles: {},
    hydrated: new Set(),
    seenKeys: {},
    loading: new Set()
  };
}

export function emptyActivity(): SessionActivity {
  return { toolCalls: 0, toolBreakdown: {}, errors: 0, skills: {}, autoCompacts: 0, steps: 0 };
}

export function hasActivity(a: SessionActivity | undefined): boolean {
  if (!a) return false;
  return (
    a.toolCalls > 0 ||
    a.errors > 0 ||
    a.autoCompacts > 0 ||
    a.steps > 0 ||
    Object.keys(a.skills).length > 0
  );
}

export function recordChild(state: ActivityState, sessionID: string, parentID: string): void {
  const children = state.childrenByParent[parentID];
  if (!children) {
    state.childrenByParent[parentID] = [sessionID];
    return;
  }
  if (!children.includes(sessionID)) children.push(sessionID);
}

function activityFor(state: ActivityState, sessionID: string): SessionActivity {
  return (state.bySessionID[sessionID] ??= emptyActivity());
}

function seen(state: ActivityState, sessionID: string, key: string): boolean {
  const keys = state.seenKeys[sessionID];
  if (!keys) {
    state.seenKeys[sessionID] = new Set([key]);
    return false;
  }
  if (keys.has(key)) return true;
  keys.add(key);
  return false;
}

export function recordToolPart(
  state: ActivityState,
  sessionID: string,
  part: { id?: string; tool: string; state?: { status?: string; input?: { name?: string } } }
): boolean {
  const activity = activityFor(state, sessionID);
  let counted = false;
  if (part.id !== undefined) {
    if (!seen(state, sessionID, `tool:${part.id}`)) {
      activity.toolCalls += 1;
      activity.toolBreakdown[part.tool] = (activity.toolBreakdown[part.tool] ?? 0) + 1;
      counted = true;
    }
  } else {
    activity.toolCalls += 1;
    activity.toolBreakdown[part.tool] = (activity.toolBreakdown[part.tool] ?? 0) + 1;
    counted = true;
  }
  const partState = part.state;
  if (partState?.status === "error" && part.id !== undefined) {
    if (!seen(state, sessionID, `error:${part.id}`)) activity.errors += 1;
  }
  if (part.tool === "skill" && partState?.input && typeof partState.input.name === "string" && partState.input.name.length > 0) {
    if (part.id !== undefined) {
      if (!seen(state, sessionID, `skill:${part.id}`)) {
        activity.skills[partState.input.name] = (activity.skills[partState.input.name] ?? 0) + 1;
      }
    } else {
      activity.skills[partState.input.name] = (activity.skills[partState.input.name] ?? 0) + 1;
    }
  }
  return counted;
}

export function recordCompaction(state: ActivityState, sessionID: string, id: string, auto: boolean): boolean {
  if (!auto) return false;
  const activity = activityFor(state, sessionID);
  if (seen(state, sessionID, `compact:${id}`)) return false;
  activity.autoCompacts += 1;
  return true;
}

export function recordStep(state: ActivityState, sessionID: string, id: string): boolean {
  const activity = activityFor(state, sessionID);
  if (seen(state, sessionID, `step:${id}`)) return false;
  activity.steps += 1;
  return true;
}

export function mergeActivity(...activities: SessionActivity[]): SessionActivity {
  const result = emptyActivity();
  for (const activity of activities) {
    result.toolCalls += activity.toolCalls;
    result.errors += activity.errors;
    result.autoCompacts += activity.autoCompacts;
    result.steps += activity.steps;
    for (const [tool, count] of Object.entries(activity.toolBreakdown)) {
      result.toolBreakdown[tool] = (result.toolBreakdown[tool] ?? 0) + count;
    }
    for (const [name, count] of Object.entries(activity.skills)) {
      result.skills[name] = (result.skills[name] ?? 0) + count;
    }
  }
  return result;
}

function collectTreeSessions(state: ActivityState, rootSessionID: string): string[] {
  const visited = new Set<string>();
  const result: string[] = [];
  const stack = [rootSessionID];
  while (stack.length > 0) {
    const sessionID = stack.pop();
    if (sessionID === undefined || visited.has(sessionID)) continue;
    visited.add(sessionID);
    result.push(sessionID);
    const children = state.childrenByParent[sessionID] ?? [];
    for (const child of children) {
      if (!visited.has(child)) stack.push(child);
    }
  }
  return result;
}

export function treeActivity(state: ActivityState, rootSessionID: string): SessionActivity {
  const activities: SessionActivity[] = [];
  for (const sessionID of collectTreeSessions(state, rootSessionID)) {
    const activity = state.bySessionID[sessionID];
    if (activity) activities.push(activity);
  }
  return mergeActivity(...activities);
}

export function treeLoading(state: ActivityState, rootSessionID: string): boolean {
  return collectTreeSessions(state, rootSessionID).some((sessionID) => state.loading.has(sessionID));
}
