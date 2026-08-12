export type SessionActivity = {
  toolCalls: number;
  toolBreakdown: Record<string, number>;
  errors: number;
  errorDetails: Array<{ tool: string; message: string }>;
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
  return { toolCalls: 0, toolBreakdown: {}, errors: 0, errorDetails: [], skills: {}, autoCompacts: 0, steps: 0 };
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
  part: { id?: string; tool: string; state?: { status?: string; input?: { name?: string }; error?: string } }
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
    if (!seen(state, sessionID, `error:${part.id}`)) {
      activity.errors += 1;
      if (typeof partState.error === "string" && partState.error.length > 0) {
        activity.errorDetails.push({ tool: part.tool, message: partState.error });
      }
    }
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
    for (const detail of activity.errorDetails) {
      result.errorDetails.push(detail);
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

function pluralize(count: number, singular: string, plural?: string): string {
  return `${count} ${count === 1 ? singular : (plural ?? `${singular}s`)}`;
}

export function formatActivitySuffix(a: SessionActivity | undefined): string {
  if (!hasActivity(a)) return "";
  const parts: string[] = [];
  if (a && a.toolCalls > 0) parts.push(pluralize(a.toolCalls, "tool call"));
  if (a && a.autoCompacts > 0) parts.push(pluralize(a.autoCompacts, "auto-compact"));
  if (a && Object.keys(a.skills).length > 0) {
    const total = Object.values(a.skills).reduce((sum, count) => sum + count, 0);
    parts.push(pluralize(total, "skill"));
  }
  if (a && a.errors > 0) parts.push(pluralize(a.errors, "error"));
  return parts.join(" · ");
}

export function formatActivityBriefRows(a: SessionActivity | undefined, subagentCount: number): string[] {
  if (!hasActivity(a) && subagentCount <= 0) return [];
  const rows: string[] = [];
  if (a && a.toolCalls > 0) rows.push(pluralize(a.toolCalls, "tool call"));
  if (a && a.autoCompacts > 0) rows.push(pluralize(a.autoCompacts, "auto-compact"));
  if (a && Object.keys(a.skills).length > 0) {
    const total = Object.values(a.skills).reduce((sum, count) => sum + count, 0);
    rows.push(pluralize(total, "skill"));
  }
  if (a && a.steps > 0) rows.push(pluralize(a.steps, "model request"));
  if (subagentCount > 0) rows.push(pluralize(subagentCount, "subagent"));
  if (a && a.errors > 0) rows.push(pluralize(a.errors, "error"));
  return rows;
}

function truncateMiddle(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  if (maxLength <= 3) return value.slice(0, maxLength);
  const marker = "...";
  const left = Math.ceil((maxLength - marker.length) / 2);
  const right = Math.floor((maxLength - marker.length) / 2);
  return `${value.slice(0, left)}${marker}${value.slice(value.length - right)}`;
}

function sortedBreakdown(breakdown: Record<string, number>): Array<[string, number]> {
  return Object.entries(breakdown).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

function indent(lines: string[], depth: number): string[] {
  return lines.map((text) => `${"  ".repeat(depth)}${text}`);
}

export type SessionAnalysisRow = {
  text: string;
  header: boolean;
  key?: string | undefined;
};

export function treeSubagentCount(state: ActivityState, rootSessionID: string): number {
  return Math.max(0, collectTreeSessions(state, rootSessionID).length - 1);
}

export function formatSubagentCount(count: number): string {
  if (count <= 0) return "";
  return pluralize(count, "subagent");
}

export function buildSessionAnalysisRows(state: ActivityState, rootSessionID: string): SessionAnalysisRow[] {
  const rows: string[] = [];
  const children = (sessionID: string) => state.childrenByParent[sessionID] ?? [];
  const activityOf = (sessionID: string) => state.bySessionID[sessionID] ?? emptyActivity();
  const titleOf = (sessionID: string) => state.titles[sessionID] ?? sessionID;
  const childIds: string[] = [];

  const visit = (sessionID: string, depth: number) => {
    for (const childID of children(sessionID)) {
      childIds.push(childID);
      const childActivity = activityOf(childID);
      const suffix = formatActivitySuffix(childActivity);
      const line = `· ${truncateMiddle(titleOf(childID), 36)}${suffix ? `  ${suffix}` : ""}`;
      rows.push(`${"  ".repeat(depth + 1)}${line}`);
      visit(childID, depth + 1);
    }
  };
  visit(rootSessionID, 0);

  const tree = treeActivity(state, rootSessionID);

  const sections: Array<[string, string[]]> = [];
  if (tree.toolCalls > 0) {
    sections.push([`Tool calls (${tree.toolCalls})`, indent(sortedBreakdown(tree.toolBreakdown).map(([tool, count]) => `· ${tool} ${count}`), 1)]);
  }
  if (Object.keys(tree.skills).length > 0) {
    const total = Object.values(tree.skills).reduce((sum, count) => sum + count, 0);
    sections.push([`Skills (${total})`, indent(sortedBreakdown(tree.skills).map(([name, count]) => `· ${name} ${count}`), 1)]);
  }
  if (tree.autoCompacts > 0) {
    sections.push([`Auto-compactions`, [`  · ${tree.autoCompacts}`]]);
  }
  if (tree.steps > 0) {
    sections.push([`Model requests (${tree.steps})`, [`  · ${tree.steps}`]]);
  }
  if (childIds.length > 0 && hasActivity(tree)) {
    sections.push([`Subagents`, rows]);
  }
  if (tree.errors > 0) {
    const details =
      tree.errorDetails.length > 0
        ? tree.errorDetails.map((detail) => `  · ${truncateMiddle(detail.tool, 24)} — ${truncateMiddle(detail.message, 72)}`)
        : [`  · ${pluralize(tree.errors, "error")}`];
    sections.push([`Tool errors (${tree.errors})`, details]);
  }

  return sections.flatMap(([title, body]) => [
    { text: title, header: true },
    ...body.map((text) => ({ text, header: false }))
  ]);
}
