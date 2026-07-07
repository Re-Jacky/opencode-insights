import { createServer, type ServerResponse } from "node:http";
import { resolveCapturePath, type InsightsOptions } from "./capture.js";
import { buildRequestHistory, readRecentCaptures, type RequestHistory } from "./inspect.js";

export type ViewerOptions = InsightsOptions & {
  limit?: number | undefined;
  host?: string | undefined;
  port?: number | undefined;
};

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
  const records = await readRecentCaptures(readOptions);
  return buildRequestHistory(records);
}

function sendJson(response: ServerResponse, value: unknown) {
  response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(value));
}

function sendHtml(response: ServerResponse, html: string) {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(html);
}

function renderViewerHtml(dbPath: string) {
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
      --panel: #171a1d;
      --panel-2: #20242a;
      --line: #30363d;
      --text: #eef2f5;
      --muted: #9aa6b2;
      --accent: #7dd3fc;
      --ok: #86efac;
      --warn: #fbbf24;
      --bad: #fca5a5;
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
      background: #0d0f11;
    }
    h1 { margin: 0; font-size: 15px; font-weight: 700; }
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
    input {
      width: 100%;
      border: 1px solid var(--line);
      background: #0d0f11;
      color: var(--text);
      border-radius: 6px;
      padding: 8px 10px;
      font: inherit;
    }
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
    .request-item { padding-left: 28px; }
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
      color: #0d0f11;
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
      background: #0b0d0f;
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
    .json-tree { font-size: 12px; line-height: 1.55; }
    .json-tree details { margin-left: 14px; }
    .json-tree summary { cursor: pointer; color: var(--accent); }
    .json-tree .leaf { margin-left: 14px; }
    .json-key { color: #bae6fd; }
    .json-string { color: #bbf7d0; }
    .json-number { color: #fde68a; }
    .json-boolean { color: #f0abfc; }
    .json-null { color: var(--muted); }
    @media (max-width: 1000px) {
      main { grid-template-columns: 1fr; height: auto; }
      section { min-height: 360px; border-right: 0; border-bottom: 1px solid var(--line); }
    }
  </style>
</head>
<body>
  <header>
    <h1>OpenCode Insights</h1>
    <div>
      <div class="meta">${escapedDbPath}</div>
      <div id="status" class="status">Loading history...</div>
    </div>
  </header>
  <main>
    <section>
      <div class="toolbar"><input id="session-filter" placeholder="Filter sessions"></div>
      <div id="sessions"></div>
    </section>
    <section>
      <div class="toolbar"><input id="timeline-filter" placeholder="Filter messages and hooks"></div>
      <div id="timeline"></div>
    </section>
    <section>
      <div class="toolbar">
        <button id="copy">Copy JSON</button>
        <button id="refresh">Refresh</button>
      </div>
      <div class="detail">
        <div class="tabs">
          <button data-tab="summary" class="active">Summary</button>
          <button data-tab="request">Request</button>
          <button data-tab="response">Response</button>
          <button data-tab="raw">Raw</button>
          <button id="expand-json" class="json-control">Expand All</button>
          <button id="collapse-json" class="json-control">Collapse All</button>
        </div>
        <div id="detail" class="panel">Select a message or request.</div>
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
      loading: true,
      error: null,
      loadedMs: 0
    };

    const qs = (id) => document.getElementById(id);
    const fmt = (ms) => ms ? new Date(ms).toLocaleString() : "-";
    const short = (value, size = 90) => {
      const text = String(value || "").replace(/\\s+/g, " ").trim();
      return text.length > size ? text.slice(0, size - 1) + "..." : text;
    };

    async function load() {
      state.loading = true;
      state.error = null;
      renderStatus();
      qs("sessions").innerHTML = '<div class="empty">Loading sessions and hooks...</div>';
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
        const session = selectedSession();
        if (session && !state.messageID && session.messages[0]) state.messageID = session.messages[0].id;
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

    function selectedRequest() {
      const message = selectedMessage();
      return message?.requests.find((request) => request.id === state.requestID)
        || state.history.requests.find((request) => request.id === state.requestID)
        || null;
    }

    function activeContext() {
      const message = selectedMessage();
      const request = selectedRequest();
      return { message, request: request || message?.requests[0] || null };
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
      else status.textContent = state.history.sessions.length + " sessions · " + state.history.requests.length + " hooks · " + state.loadedMs + "ms";
      qs("refresh").disabled = state.loading;
      qs("refresh").textContent = state.loading ? "Loading..." : "Refresh";
    }

    function renderSessions() {
      const filter = qs("session-filter").value.toLowerCase();
      const sessions = state.history.sessions.filter((session) =>
        [session.id, session.title].filter(Boolean).join(" ").toLowerCase().includes(filter)
      );
      qs("sessions").innerHTML = sessions.length ? sessions.map((session) =>
        '<button class="item ' + (session.id === state.sessionID ? "active" : "") + '" data-session="' + escapeAttr(session.id) + '">' +
          '<div class="title">' + escapeHtml(session.title || session.id) + '</div>' +
          '<div class="meta">' + session.messages.length + ' messages · ' + session.requests.length + ' hooks · ' + fmt(session.updatedAt) + '</div>' +
        '</button>'
      ).join("") : '<div class="empty">No sessions found.</div>';
      for (const item of document.querySelectorAll("[data-session]")) {
        item.onclick = () => {
          state.sessionID = item.dataset.session;
          const session = selectedSession();
          state.messageID = session?.messages[0]?.id || null;
          state.requestID = null;
          render();
        };
      }
    }

    function renderTimeline() {
      const session = selectedSession();
      if (!session) {
        qs("timeline").innerHTML = '<div class="empty">Select a session.</div>';
        return;
      }
      const filter = qs("timeline-filter").value.toLowerCase();
      const blocks = [];
      for (const message of session.messages) {
        const searchable = JSON.stringify(message).toLowerCase();
        if (filter && !searchable.includes(filter)) continue;
        blocks.push(
          '<button class="item ' + (message.id === state.messageID && !state.requestID ? "active" : "") + '" data-message="' + escapeAttr(message.id) + '">' +
            '<div class="title"><span class="pill msg">MSG</span> ' + escapeHtml(message.role) + ' · ' + escapeHtml(short(message.text || message.id, 110)) + '</div>' +
            '<div class="meta">' + message.requests.length + ' hooks · response ' + (message.response?.text ? "captured" : "missing") + ' · ' + fmt(message.createdAt) + '</div>' +
          '</button>'
        );
        for (const request of message.requests) {
          blocks.push(
            '<button class="item request-item ' + (request.id === state.requestID ? "active" : "") + '" data-message="' + escapeAttr(message.id) + '" data-request="' + escapeAttr(request.id) + '">' +
              '<div class="title"><span class="pill">HOOK</span> ' + escapeHtml(request.agent || "agent") + ' · ' + escapeHtml([request.providerID, request.modelID].filter(Boolean).join("/") || "-") + '</div>' +
              '<div class="meta">' + escapeHtml(short(request.summary, 120)) + ' · ' + (request.headers ? "headers" : "no headers") + ' · ' + (request.response?.text ? "response" : "no response") + '</div>' +
            '</button>'
          );
        }
      }
      qs("timeline").innerHTML = blocks.length ? blocks.join("") : '<div class="empty">No messages or hooks found.</div>';
      for (const item of document.querySelectorAll("[data-message]")) {
        item.onclick = () => {
          state.messageID = item.dataset.message;
          state.requestID = item.dataset.request || null;
          render();
        };
      }
    }

    function renderDetail() {
      const { message, request } = activeContext();
      document.querySelector(".tabs").classList.toggle("json-mode", state.tab !== "summary");
      if (!message && !request) {
        qs("detail").textContent = "Select a message or request.";
        return;
      }

      if (state.tab === "summary") {
        const response = request?.response || message?.response;
        qs("detail").innerHTML = '<div class="kv">' +
          kv("Message", message?.id || "-") +
          kv("Message text", message?.text || "(no user text captured)") +
          kv("Selected hook", request?.id || "-") +
          kv("Agent", request?.agent || "-") +
          kv("Purpose", request?.purpose || "-") +
          kv("Provider/model", [request?.providerID, request?.modelID].filter(Boolean).join("/") || "-") +
          kv("Request time", fmt(request?.timestamp)) +
          kv("Headers hook", request?.headers ? "captured" : "empty / not captured") +
          kv("Direct response", request?.response?.text ? "captured" : request ? "none for this hook" : "-") +
          kv("Message response", response?.id || "-") +
          kv("Response text", response?.text || "(no assistant text captured)") +
          kv("Finish", response?.finish || "-") +
          kv("Cost", response?.cost === undefined ? "-" : String(response.cost)) +
        '</div>';
        return;
      }

      if (state.tab === "request") {
        renderRequestDetail(request);
        return;
      }

      if (state.tab === "response") {
        const response = state.requestID ? request?.response : message?.response;
        renderJson(response || {
          status: "missing",
          note: request?.agent === "title"
            ? "The title request does not produce the assistant reply. Select the build request or MSG row to inspect the conversation response."
            : "No assistant response events were captured for this message yet."
        });
        return;
      }

      renderJson({ message, request });
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
      const payload = request.payload || {};
      const hookInput = payload.input || {};
      const hookOutput = payload.output || {};
      const headerOutput = request.headers?.payload?.output || null;
      qs("detail").innerHTML =
        '<p class="explain">These are OpenCode plugin hook values, not a raw HTTP request. <b>Hook input</b> is the context OpenCode passed to the plugin before the model call. <b>Hook output</b> is the model settings returned by the plugin hook. <b>Headers output</b> is the provider headers hook result.</p>' +
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
        '<div class="subhead">Headers Hook Output</div>' +
        '<div class="json-tree">' + jsonNode(headerOutput, "headersOutput", true) + '</div>' +
        '<div class="subhead">Raw Full-Fidelity Payload</div>' +
        '<div class="json-tree">' + jsonNode({ params: request.payload, headers: request.headers?.payload || null }, "raw", false) + '</div>';
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
    qs("timeline-filter").oninput = render;
    qs("refresh").onclick = load;
    qs("expand-json").onclick = () => setJsonExpanded(true);
    qs("collapse-json").onclick = () => setJsonExpanded(false);
    qs("copy").onclick = async () => {
      const { message, request } = activeContext();
      const value = state.tab === "request" ? { params: request?.payload || null, headers: request?.headers?.payload || null }
        : state.tab === "response" ? (request?.response || message?.response || null)
        : state.tab === "raw" ? { message, request }
        : { messageID: message?.id, requestID: request?.id };
      await navigator.clipboard.writeText(JSON.stringify(value, null, 2));
    };
    for (const tab of document.querySelectorAll("[data-tab]")) {
      tab.onclick = () => {
        state.tab = tab.dataset.tab;
        for (const item of document.querySelectorAll("[data-tab]")) item.classList.toggle("active", item === tab);
        renderDetail();
      };
    }
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
