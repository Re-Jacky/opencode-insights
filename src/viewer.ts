import { createServer, type ServerResponse } from "node:http";
import { resolveCapturePath, type InsightsOptions } from "./capture.js";
import { buildRequestHistory, readCaptureRecord, readViewerCaptures, type HistoryMessage, type RequestHistory } from "./inspect.js";

export type ViewerOptions = InsightsOptions & {
  limit?: number | undefined;
  host?: string | undefined;
  port?: number | undefined;
};

export type ViewerVisibleStep = {
  label: string;
  text: string;
};

export type ViewerHiddenContext = {
  title: string;
  step: string;
  preview: string;
  text: string;
  count: number;
};

const REQUEST_PATH_RE = /^\/api\/request\/(.+)$/;

export async function serveViewer(options: ViewerOptions = {}) {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 8765;

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", `http://${host}:${port}`);

    if (url.pathname === "/api/history") {
      const history = await readHistory(options);
      sendJson(response, history);
      return;
    }

    const requestMatch = REQUEST_PATH_RE.exec(url.pathname);
    if (requestMatch) {
      const requestId = requestMatch[1];
      if (!requestId) {
        sendJson(response, { error: "not found" });
        return;
      }
      const record = await readCaptureRecord(requestId, options);
      if (!record) {
        sendJson(response, { error: "not found" });
        return;
      }
      sendJson(response, record.payload);
      return;
    }

    if (url.pathname === "/" || url.pathname === "/index.html") {
      sendHtml(response, renderViewerHtml(resolveCapturePath(options)));
      return;
    }

    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found");
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  return {
    url: `http://${host}:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  };
}

export async function readHistory(options: ViewerOptions = {}) {
  const readOptions: InsightsOptions & { limit?: number } = {
    dataDir: options.dataDir,
    dbPath: options.dbPath,
    limit: options.limit ?? 5000
  };
  const records = await readViewerCaptures(readOptions);
  const history = buildRequestHistory(records);
  prepareHistoryForViewer(history);
  stripPayloadsForViewer(history);
  return history;
}

function prepareHistoryForViewer(history: RequestHistory) {
  for (const session of history.sessions) {
    for (const message of session.messages) {
      const viewerMessage = message as HistoryMessage & {
        visibleSteps?: ViewerVisibleStep[];
        hiddenContexts?: ViewerHiddenContext[];
      };
      viewerMessage.visibleSteps = buildViewerVisibleSteps(message);
      viewerMessage.hiddenContexts = buildViewerHiddenContexts(message);
    }
  }
}

function stripPayloadsForViewer(history: RequestHistory) {
  history.requests = history.requests.map(viewerRequestSummary);
  for (const session of history.sessions) {
    session.requests = [];
    for (const message of session.messages) {
      message.requests = [];
      message.response = undefined;
    }
  }
}

export function buildViewerVisibleSteps(message: HistoryMessage): ViewerVisibleStep[] {
  const steps: ViewerVisibleStep[] = [];
  for (const request of (message.requests || []).filter((item) => item.agent !== "title" && item.agent !== "messages.transform")) {
    const label = [request.agent || "agent", request.providerID, request.modelID].filter(Boolean).join(" · ");
    const response = request.response;
    const reasoning = response?.reasoning;
    const text = response?.text;
    if (reasoning) {
      steps.push({ label: `${label} thinking`, text: reasoning });
    }
    for (const tool of viewerToolSteps(response)) {
      steps.push({ label: `${label} tool`, text: tool });
    }
    if (text && normalizeDisplayText(text) !== normalizeDisplayText(reasoning)) {
      steps.push({ label: `${label} response`, text });
    }
    if (!reasoning && !text && viewerToolSteps(response).length === 0) {
      steps.push({ label, text: "Model step captured, but no visible thinking or response text was recorded." });
    }
  }
  return steps;
}

export function buildViewerHiddenContexts(message: HistoryMessage): ViewerHiddenContext[] {
  const contexts = new Map<string, ViewerHiddenContext>();
  for (const request of message.requests || []) {
    const step = [request.agent || "agent", request.providerID, request.modelID].filter(Boolean).join(" · ");
    if (request.system?.payload?.output) {
      addHiddenContext(contexts, "System Transform Output", step, request.system.payload.output);
    }
    if (request.agent === "messages.transform" && request.payload) {
      addHiddenContext(contexts, "Messages Transform Output", step, request.payload.output || request.payload);
    }
  }
  return [...contexts.values()];
}

function addHiddenContext(contexts: Map<string, ViewerHiddenContext>, title: string, step: string, value: unknown) {
  const text = hiddenContextText(value);
  if (!text) return;
  const key = `${title}:${normalizeDisplayText(text)}`;
  const existing = contexts.get(key);
  if (existing) {
    existing.count += 1;
    if (!existing.step.split(", ").includes(step)) existing.step = `${existing.step}, ${step}`;
    return;
  }
  contexts.set(key, {
    title,
    step,
    preview: previewText(text, 180),
    text,
    count: 1
  });
}

function hiddenContextText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(hiddenContextText).filter(Boolean).join("\n\n");
  if (!isRecord(value)) return value === undefined || value === null ? "" : String(value);
  if (value.system !== undefined) return hiddenContextText(value.system);
  if (Array.isArray(value.messages)) {
    return value.messages.map(messageContextText).filter(Boolean).join("\n\n");
  }
  const strings = collectStrings(value);
  return strings.length ? strings.join("\n\n") : JSON.stringify(value, null, 2);
}

function messageContextText(value: unknown) {
  if (!isRecord(value)) return hiddenContextText(value);
  const info = isRecord(value.info) ? value.info : {};
  const role = typeof info.role === "string" ? info.role : "message";
  const parts = Array.isArray(value.parts) ? value.parts : [];
  const text = parts.map(partText).filter(Boolean).join("\n");
  return text ? `${role}: ${text}` : `${role}: ${hiddenContextText(value)}`;
}

function partText(value: unknown) {
  if (!isRecord(value)) return "";
  return typeof value.text === "string" ? value.text : typeof value.content === "string" ? value.content : "";
}

function viewerToolSteps(response: HistoryMessage["response"]) {
  const tools: string[] = [];
  const seen = new Set<string>();
  for (const wrapper of response?.events || []) {
    const event = isRecord(wrapper.event) ? wrapper.event : undefined;
    const properties = isRecord(event?.properties) ? event.properties : undefined;
    const part = isRecord(properties?.part) ? properties.part : undefined;
    if (event?.type !== "message.part.updated" || part?.type !== "tool") continue;
    const state = isRecord(part.state) ? part.state : undefined;
    const key = [part.id, part.tool, state?.status].filter(Boolean).join(":");
    if (seen.has(key)) continue;
    seen.add(key);
    tools.push([part.tool || "tool", state?.status].filter(Boolean).join(" · "));
  }
  return tools;
}

function collectStrings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(collectStrings);
  if (!isRecord(value)) return [];
  return Object.values(value).flatMap(collectStrings);
}

function previewText(value: string, size: number) {
  const text = normalizeDisplayText(value);
  return text.length > size ? `${text.slice(0, size - 1)}...` : text || "(empty)";
}

function normalizeDisplayText(value: unknown) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function viewerRequestSummary(request: RequestHistory["requests"][number]) {
  return {
    id: request.id,
    sessionID: request.sessionID,
    messageID: request.messageID,
    timestamp: request.timestamp,
    agent: request.agent,
    purpose: request.purpose,
    providerID: request.providerID,
    modelID: request.modelID,
    summary: request.summary,
    payload: {}
  };
}

function sendJson(response: ServerResponse, value: unknown) {
  response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(value));
}

function sendHtml(response: ServerResponse, html: string) {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(html);
}

export function renderViewerHtml(dbPath: string) {
  const escapedDbPath = escapeHtml(dbPath);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>OpenCode Insights</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #101214;
      --header: #0d0f11;
      --panel: #171a1d;
      --panel-2: #20242a;
      --surface: #0b0d0f;
      --field: #0d0f11;
      --line: #30363d;
      --text: #eef2f5;
      --muted: #9aa6b2;
      --accent: #7dd3fc;
      --ok: #86efac;
      --warn: #fbbf24;
      --bad: #fca5a5;
      --pill-text: #0d0f11;
      --json-key: #bae6fd;
      --json-string: #bbf7d0;
      --json-number: #fde68a;
      --json-boolean: #f0abfc;
    }
    body[data-theme="light"] {
      color-scheme: light;
      --bg: #f6f7f9;
      --header: #ffffff;
      --panel: #ffffff;
      --panel-2: #edf2f7;
      --surface: #ffffff;
      --field: #ffffff;
      --line: #d7dde5;
      --text: #18212f;
      --muted: #667085;
      --accent: #2563eb;
      --ok: #16a34a;
      --warn: #b45309;
      --bad: #dc2626;
      --pill-text: #ffffff;
      --json-key: #1d4ed8;
      --json-string: #15803d;
      --json-number: #a16207;
      --json-boolean: #9333ea;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      background: var(--bg);
      color: var(--text);
      font: 13px/1.45 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
    }
    header {
      height: 56px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      padding: 0 18px;
      border-bottom: 1px solid var(--line);
      background: var(--header);
    }
    h1 { margin: 0; font-size: 15px; font-weight: 700; }
    .brand, .header-side {
      display: flex;
      align-items: center;
      gap: 14px;
      min-width: 0;
    }
    .header-meta { min-width: 0; }
    .theme-toggle {
      display: inline-flex;
      gap: 2px;
      padding: 3px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--panel);
    }
    .theme-toggle button {
      padding: 5px 8px;
      border: 0;
      border-radius: 5px;
      background: transparent;
      color: var(--muted);
    }
    .theme-toggle button.active {
      background: var(--panel-2);
      color: var(--text);
    }
    main {
      display: grid;
      grid-template-columns: 300px minmax(340px, 0.95fr) minmax(460px, 1.25fr);
      height: calc(100vh - 56px);
      min-height: 540px;
    }
    section { min-width: 0; overflow: auto; border-right: 1px solid var(--line); }
    section:last-child { border-right: 0; }
    .toolbar {
      position: sticky;
      top: 0;
      display: flex;
      gap: 8px;
      padding: 10px;
      background: var(--panel);
      border-bottom: 1px solid var(--line);
      z-index: 2;
    }
    input, select {
      width: 100%;
      border: 1px solid var(--line);
      background: var(--field);
      color: var(--text);
      border-radius: 6px;
      padding: 8px 10px;
      font: inherit;
    }
    select { cursor: pointer; }
    .toolbar.stack { flex-direction: column; }
    button {
      border: 1px solid var(--line);
      background: var(--panel-2);
      color: var(--text);
      border-radius: 6px;
      padding: 8px 10px;
      font: inherit;
      cursor: pointer;
    }
    button:hover { border-color: var(--accent); }
    button:disabled { cursor: wait; opacity: 0.6; }
    .item {
      width: 100%;
      display: block;
      border: 0;
      border-bottom: 1px solid var(--line);
      border-radius: 0;
      background: transparent;
      text-align: left;
      padding: 11px 12px;
    }
    .item:hover, .item.active { background: var(--panel-2); }
    .session-child { padding-left: 28px; }
    .title { color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .meta {
      margin-top: 4px;
      color: var(--muted);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .muted { color: var(--muted); }
    .pill {
      color: var(--pill-text);
      background: var(--accent);
      border-radius: 999px;
      padding: 1px 6px;
      font-weight: 700;
    }
    .pill.msg { background: var(--ok); }
    .pill.missing { background: var(--warn); }
    .detail { padding: 14px; }
    .tabs { display: flex; gap: 6px; margin-bottom: 10px; flex-wrap: wrap; }
    .tabs button.active { border-color: var(--accent); color: var(--accent); }
    .tabs .json-control { display: none; margin-left: auto; }
    .tabs .json-control + .json-control { margin-left: 0; }
    .tabs.json-mode .json-control { display: inline-block; }
    .panel, pre {
      margin: 0;
      padding: 14px;
      overflow: auto;
      white-space: pre-wrap;
      word-break: break-word;
      background: var(--surface);
      border: 1px solid var(--line);
      border-radius: 8px;
      min-height: 220px;
    }
    .empty { color: var(--muted); padding: 16px; }
    .status { color: var(--muted); min-width: 220px; text-align: right; }
    .status.error { color: var(--bad); }
    .kv { display: grid; grid-template-columns: 140px minmax(0, 1fr); gap: 8px 12px; }
    .kv div:nth-child(odd) { color: var(--muted); }
    .explain {
      margin: 0 0 12px;
      color: var(--muted);
    }
    .subhead {
      margin: 16px 0 8px;
      color: var(--text);
      font-weight: 700;
    }
    .step {
      margin: 0 0 10px;
      padding: 12px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--surface);
    }
    .step-label {
      color: var(--accent);
      font-weight: 700;
      margin-bottom: 6px;
    }
    .step-text { white-space: pre-wrap; word-break: break-word; }
    details.hidden-context {
      margin: 10px 0;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--surface);
    }
    details.hidden-context summary {
      cursor: pointer;
      padding: 10px 12px;
      color: var(--accent);
    }
    .hidden-body { padding: 0 12px 12px; }
    .hidden-text {
      margin: 0;
      white-space: pre-wrap;
      word-break: break-word;
      color: var(--text);
    }
    .json-tree { font-size: 12px; line-height: 1.55; }
    .json-tree details { margin-left: 14px; }
    .json-tree summary { cursor: pointer; color: var(--accent); }
    .json-tree .leaf { margin-left: 14px; }
    .json-key { color: var(--json-key); }
    .json-string { color: var(--json-string); }
    .json-number { color: var(--json-number); }
    .json-boolean { color: var(--json-boolean); }
    .json-null { color: var(--muted); }
    @media (max-width: 1000px) {
      main { grid-template-columns: 1fr; height: auto; }
      section { min-height: 360px; border-right: 0; border-bottom: 1px solid var(--line); }
    }
  </style>
</head>
<body data-theme="dark">
  <header>
    <div class="brand">
      <h1>OpenCode Insights</h1>
      <div id="theme-toggle" class="theme-toggle" aria-label="Theme">
        <button type="button" data-theme-option="dark">Dark</button>
        <button type="button" data-theme-option="light">Light</button>
      </div>
    </div>
    <div class="header-side">
      <div class="header-meta">
        <div class="meta">${escapedDbPath}</div>
        <div id="status" class="status">Loading history...</div>
      </div>
    </div>
  </header>
  <main>
    <section>
      <div class="toolbar stack">
        <select id="project-filter"><option value="">All projects</option></select>
        <input id="session-filter" placeholder="Filter sessions">
      </div>
      <div id="sessions"></div>
    </section>
    <section>
      <div class="toolbar"><input id="timeline-filter" placeholder="Filter conversation"></div>
      <div id="timeline"></div>
    </section>
    <section>
      <div class="toolbar">
        <button id="copy">Copy Summary</button>
        <button id="refresh">Refresh</button>
      </div>
      <div class="detail">
        <div class="tabs">
          <button data-tab="summary" class="active">Summary</button>
        </div>
        <div id="detail" class="panel">Select a user message.</div>
      </div>
    </section>
  </main>
  <script>
    const state = {
      history: { sessions: [], requests: [] },
      sessionID: null,
      messageID: null,
      requestID: null,
      tab: "summary",
      project: "",
      loading: true,
      error: null,
      loadedMs: 0,
      payloadCache: {}
    };

    const THEME_KEY = "opencode-insights-theme";
    const qs = (id) => document.getElementById(id);
    const fmt = (ms) => ms ? new Date(ms).toLocaleString() : "-";
    const short = (value, size = 90) => {
      const text = String(value || "").replace(/\\s+/g, " ").trim();
      return text.length > size ? text.slice(0, size - 1) + "..." : text;
    };

    function applyTheme(theme) {
      const next = theme === "light" ? "light" : "dark";
      document.body.dataset.theme = next;
      localStorage.setItem(THEME_KEY, next);
      for (const item of document.querySelectorAll("[data-theme-option]")) {
        item.classList.toggle("active", item.dataset.themeOption === next);
      }
    }

    async function load() {
      state.loading = true;
      state.error = null;
      renderStatus();
      qs("sessions").innerHTML = '<div class="empty">Loading sessions...</div>';
      qs("timeline").innerHTML = '<div class="empty">Waiting for history data...</div>';
      try {
        const started = performance.now();
        const res = await fetch("/api/history");
        if (!res.ok) throw new Error("HTTP " + res.status + " " + res.statusText);
        state.history = await res.json();
        state.loadedMs = Math.round(performance.now() - started);
        if (!state.sessionID && state.history.sessions[0]) state.sessionID = state.history.sessions[0].id;
        if (state.sessionID && !state.history.sessions.some((session) => session.id === state.sessionID)) {
          state.sessionID = state.history.sessions[0]?.id || null;
          state.messageID = null;
          state.requestID = null;
        }
        renderProjectOptions();
        const session = selectedSession();
        if (session && !state.messageID) state.messageID = firstUserMessage(session)?.id || null;
      } catch (error) {
        state.error = error instanceof Error ? error.message : String(error);
      } finally {
        state.loading = false;
        render();
      }
    }

    function selectedSession() {
      return state.history.sessions.find((session) => session.id === state.sessionID);
    }

    function selectedMessage() {
      const session = selectedSession();
      return session?.messages.find((message) => message.id === state.messageID) || null;
    }

    function firstUserMessage(session) {
      return session?.messages.find((message) => message.role === "user") || session?.messages[0] || null;
    }

    function render() {
      renderStatus();
      if (state.error) {
        qs("sessions").innerHTML = '<div class="empty">Failed to load history.</div>';
        qs("timeline").innerHTML = '<div class="empty">' + escapeHtml(state.error) + '</div>';
        qs("detail").textContent = "Refresh after checking the viewer server.";
        return;
      }
      renderSessions();
      renderTimeline();
      renderDetail();
    }

    function renderStatus() {
      const status = qs("status");
      status.classList.toggle("error", Boolean(state.error));
      if (state.error) status.textContent = "Load failed";
      else if (state.loading) status.textContent = "Loading history...";
      else status.textContent = state.history.sessions.length + " sessions · " + state.history.requests.length + " model steps · " + state.loadedMs + "ms";
      qs("refresh").disabled = state.loading;
      qs("refresh").textContent = state.loading ? "Loading..." : "Refresh";
    }

    function renderProjectOptions() {
      const select = qs("project-filter");
      const current = state.project;
      const projects = [...new Set(state.history.sessions.map((session) => session.project || session.cwd || "Unknown").filter(Boolean))].sort();
      select.innerHTML = '<option value="">All projects</option>' + projects.map((project) =>
        '<option value="' + escapeAttr(project) + '">' + escapeHtml(project) + '</option>'
      ).join("");
      if (projects.includes(current)) select.value = current;
      else state.project = "";
    }

    function renderSessions() {
      const filter = qs("session-filter").value.toLowerCase();
      const project = state.project;
      const all = state.history.sessions;
      const byParent = new Map();
      const byId = new Map(all.map((session) => [session.id, session]));
      for (const session of all) {
        const parent = session.parentID && byId.has(session.parentID) ? session.parentID : "";
        const list = byParent.get(parent) || [];
        list.push(session);
        byParent.set(parent, list);
      }
      for (const list of byParent.values()) list.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
      const matches = (session) => {
        const projectMatch = !project || (session.project || session.cwd || "Unknown") === project;
        const text = [session.id, session.title, session.project, session.cwd].filter(Boolean).join(" ").toLowerCase();
        return projectMatch && (!filter || text.includes(filter));
      };
      const renderNode = (session, depth = 0) => {
        const children = byParent.get(session.id) || [];
        const childHtml = children.map((child) => renderNode(child, depth + 1)).join("");
        if (!matches(session) && !childHtml) return "";
        const cls = "item" + (depth > 0 ? " session-child" : "") + (session.id === state.sessionID ? " active" : "");
        return '<button class="' + cls + '" data-session="' + escapeAttr(session.id) + '">' +
          '<div class="title">' + (depth > 0 ? "sub: " : "") + escapeHtml(session.title || session.id) + '</div>' +
          '<div class="meta">' + escapeHtml(session.project || session.cwd || "Unknown project") + ' · ' + userMessages(session).length + ' messages · ' + fmt(session.updatedAt) + '</div>' +
        '</button>' + childHtml;
      };
      const html = (byParent.get("") || []).map((session) => renderNode(session)).join("");
      qs("sessions").innerHTML = html || '<div class="empty">No sessions found.</div>';
      for (const item of document.querySelectorAll("[data-session]")) {
        item.onclick = () => {
          state.sessionID = item.dataset.session;
          const session = selectedSession();
          state.messageID = firstUserMessage(session)?.id || null;
          state.requestID = null;
          render();
        };
      }
    }

    function userMessages(session) {
      return (session?.messages || []).filter((message) => message.role === "user");
    }

    function renderTimeline() {
      const session = selectedSession();
      if (!session) {
        qs("timeline").innerHTML = '<div class="empty">Select a session.</div>';
        return;
      }
      const filter = qs("timeline-filter").value.toLowerCase();
      const blocks = [];
      for (const message of userMessages(session)) {
        const searchable = JSON.stringify(message).toLowerCase();
        if (filter && !searchable.includes(filter)) continue;
        blocks.push(
          '<button class="item ' + (message.id === state.messageID ? "active" : "") + '" data-message="' + escapeAttr(message.id) + '">' +
            '<div class="title"><span class="pill msg">USER</span> ' + escapeHtml(short(message.text || message.id, 130)) + '</div>' +
            '<div class="meta">' + visibleSteps(message).length + ' visible steps · ' + hiddenContexts(message).length + ' hidden context items · ' + fmt(message.createdAt) + '</div>' +
          '</button>'
        );
      }
      qs("timeline").innerHTML = blocks.length ? blocks.join("") : '<div class="empty">No user messages found.</div>';
      for (const item of document.querySelectorAll("[data-message]")) {
        item.onclick = () => {
          state.messageID = item.dataset.message;
          state.requestID = null;
          render();
        };
      }
    }

    function renderDetail() {
      const message = selectedMessage();
      if (!message) {
        qs("detail").textContent = "Select a user message.";
        return;
      }

      const session = selectedSession();
      const steps = visibleSteps(message);
      const hidden = hiddenContexts(message);
      qs("detail").innerHTML =
        '<div class="kv">' +
          kv("Session", session?.title || session?.id || "-") +
          kv("Project", session?.project || session?.cwd || "Unknown") +
          kv("User message", message.text || "(no user text captured)") +
          kv("Visible steps", String(steps.length)) +
          kv("Hidden context", hidden.length ? hidden.length + " item(s)" : "none captured") +
        '</div>' +
        '<div class="subhead">Agent Thinking / Response Sequence</div>' +
        (steps.length ? steps.map(renderStep).join("") : '<div class="empty">No assistant thinking or response text captured for this message.</div>') +
        '<div class="subhead">Hidden Context</div>' +
        (hidden.length ? hidden.map(renderHiddenContext).join("") : '<div class="empty">No system prompt or hidden prompt-like context captured.</div>');
    }

    function visibleSteps(message) {
      return message.visibleSteps || [];
    }

    function hiddenContexts(message) {
      return message.hiddenContexts || [];
    }

    function renderStep(step) {
      return '<div class="step">' +
        '<div class="step-label">' + escapeHtml(step.label) + '</div>' +
        '<div class="step-text">' + escapeHtml(step.text) + '</div>' +
      '</div>';
    }

    function renderHiddenContext(item) {
      const count = item.count > 1 ? ' · used by ' + item.count + ' model steps' : "";
      return '<details class="hidden-context">' +
        '<summary>' + escapeHtml(item.title) + ' · ' + escapeHtml(item.step || "-") + count + ' · ' + escapeHtml(item.preview) + '</summary>' +
        '<div class="hidden-body"><pre class="hidden-text">' + escapeHtml(item.text) + '</pre></div>' +
      '</details>';
    }

    function kv(key, value) {
      return '<div>' + escapeHtml(key) + '</div><div>' + escapeHtml(value) + '</div>';
    }

    function renderJson(value) {
      qs("detail").innerHTML = '<div class="json-tree">' + jsonNode(value, "root", true) + '</div>';
    }

    function renderRequestDetail(request) {
      if (!request) {
        renderJson({ status: "missing", note: "Select a hook row to inspect hook details." });
        return;
      }
      const cached = state.payloadCache[request.id];
      if (cached === undefined || cached === null) {
        qs("detail").innerHTML = '<div class="empty">Loading hook payload...</div>';
        return;
      }
      if (cached.error) {
        renderJson({ error: cached.error });
        return;
      }
      const payload = cached;
      const hookInput = payload.input || {};
      const hookOutput = payload.output || {};
      const systemOutput = request.system?.payload?.output || null;
      const headerOutput = request.headers?.payload?.output || null;
      qs("detail").innerHTML =
        '<p class="explain">These are OpenCode plugin hook values, not a raw HTTP request. <b>Hook input</b> is the context OpenCode passed to the plugin before the model call. <b>Hook output</b> is the model settings returned by the plugin hook. <b>System transform</b> is the system prompt OpenCode prepared for this same call. <b>Headers output</b> is the provider headers hook result.</p>' +
        '<div class="kv">' +
          kv("Hook id", request.id) +
          kv("Agent", request.agent || "-") +
          kv("Purpose", request.purpose || "-") +
          kv("Provider/model", [request.providerID, request.modelID].filter(Boolean).join("/") || "-") +
          kv("User message id", request.messageID || "-") +
          kv("Time", fmt(request.timestamp)) +
        '</div>' +
        '<div class="subhead">Hook Input: context OpenCode supplied</div>' +
        '<div class="json-tree">' + jsonNode(summarizeHookInput(hookInput), "hookInput", true) + '</div>' +
        '<div class="subhead">Hook Output: model-call settings</div>' +
        '<div class="json-tree">' + jsonNode(hookOutput, "hookOutput", true) + '</div>' +
        '<div class="subhead">System Transform Output</div>' +
        '<div class="json-tree">' + jsonNode(systemOutput, "systemOutput", true) + '</div>' +
        '<div class="subhead">Headers Hook Output</div>' +
        '<div class="json-tree">' + jsonNode(headerOutput, "headersOutput", true) + '</div>' +
        '<div class="subhead">Raw Full-Fidelity Payload</div>' +
        '<div class="json-tree">' + jsonNode({ system: request.system?.payload || null, params: payload, headers: request.headers?.payload || null }, "raw", false) + '</div>';
    }

    function summarizeHookInput(input) {
      return {
        sessionID: input?.sessionID,
        agent: input?.agent,
        model: input?.model ? {
          id: input.model.id,
          providerID: input.model.providerID,
          name: input.model.name,
          family: input.model.family,
          api: input.model.api,
          limit: input.model.limit,
          capabilities: input.model.capabilities,
          cost: input.model.cost
        } : null,
        provider: input?.provider ? {
          id: input.provider.id,
          source: input.provider.source,
          name: input.provider.name,
          env: input.provider.env,
          options: input.provider.options,
          key: input.provider.key
        } : null,
        message: input?.message || null
      };
    }

    function setJsonExpanded(expanded) {
      for (const node of qs("detail").querySelectorAll("details")) node.open = expanded;
    }

    function jsonNode(value, key, open) {
      if (value === null) return leaf(key, '<span class="json-null">null</span>');
      if (Array.isArray(value)) {
        const children = value.map((item, index) => jsonNode(item, String(index), false)).join("");
        return '<details ' + (open ? "open" : "") + '><summary>' + label(key) + ' Array(' + value.length + ')</summary>' + children + '</details>';
      }
      if (typeof value === "object") {
        const keys = Object.keys(value);
        const children = keys.map((childKey) => jsonNode(value[childKey], childKey, false)).join("");
        return '<details ' + (open ? "open" : "") + '><summary>' + label(key) + ' Object(' + keys.length + ')</summary>' + children + '</details>';
      }
      if (typeof value === "string") return leaf(key, '<span class="json-string">' + escapeHtml(JSON.stringify(value)) + '</span>');
      if (typeof value === "number") return leaf(key, '<span class="json-number">' + value + '</span>');
      if (typeof value === "boolean") return leaf(key, '<span class="json-boolean">' + value + '</span>');
      return leaf(key, escapeHtml(String(value)));
    }

    function label(key) {
      return '<span class="json-key">' + escapeHtml(key) + '</span>: ';
    }

    function leaf(key, value) {
      return '<div class="leaf">' + label(key) + value + '</div>';
    }

    function escapeHtml(value) {
      return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
    }

    function escapeAttr(value) {
      return escapeHtml(value).replace(new RegExp(String.fromCharCode(96), "g"), "&#96;");
    }

    qs("session-filter").oninput = render;
    qs("project-filter").onchange = () => {
      state.project = qs("project-filter").value;
      render();
    };
    qs("timeline-filter").oninput = render;
    qs("refresh").onclick = load;
    for (const item of document.querySelectorAll("[data-theme-option]")) {
      item.onclick = () => applyTheme(item.dataset.themeOption);
    }
    qs("copy").onclick = async () => {
      const message = selectedMessage();
      const value = message ? {
        messageID: message.id,
        text: message.text,
        steps: visibleSteps(message),
        hiddenContext: hiddenContexts(message)
      } : null;
      await navigator.clipboard.writeText(JSON.stringify(value, null, 2));
    };
    for (const tab of document.querySelectorAll("[data-tab]")) {
      tab.onclick = () => {
        state.tab = tab.dataset.tab;
        for (const item of document.querySelectorAll("[data-tab]")) item.classList.toggle("active", item === tab);
        renderDetail();
      };
    }
    applyTheme(localStorage.getItem(THEME_KEY));
    load();
  </script>
</body>
</html>`;
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (char) => {
    if (char === "&") return "&amp;";
    if (char === "<") return "&lt;";
    if (char === ">") return "&gt;";
    if (char === '"') return "&quot;";
    return "&#39;";
  });
}
