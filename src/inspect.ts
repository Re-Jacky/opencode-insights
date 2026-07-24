import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { openDatabase, resolveCapturePath, type CaptureRecord, type InsightsOptions, type SqliteDb } from "./capture.js";

const execFileAsync = promisify(execFile);

type SqliteRow = {
  id: string;
  kind: CaptureRecord["kind"];
  timestamp: number;
  session_id: string | null;
  message_id: string | null;
  provider_id: string | null;
  model_id: string | null;
  payload_json: string;
};

export type HistoryMessage = {
  id: string;
  sessionID: string;
  role: string;
  createdAt?: number | undefined;
  completedAt?: number | undefined;
  text: string;
  requests: HistoryRequest[];
  response?: HistoryResponse | undefined;
};

export type HistoryRequest = {
  id: string;
  sessionID?: string | undefined;
  messageID?: string | undefined;
  timestamp: number;
  agent?: string | undefined;
  purpose: string;
  providerID?: string | undefined;
  modelID?: string | undefined;
  summary: string;
  payload: Record<string, unknown>;
  system?: HistoryRequestHeaders | undefined;
  headers?: HistoryRequestHeaders | undefined;
  response?: HistoryResponse | undefined;
};

export type HistoryRequestHeaders = {
  id: string;
  timestamp: number;
  payload: Record<string, unknown>;
};

export type HistoryResponse = {
  id: string;
  sessionID: string;
  role: string;
  parentID?: string | undefined;
  createdAt?: number | undefined;
  completedAt?: number | undefined;
  text: string;
  reasoning: string;
  tokens?: unknown;
  cost?: number | undefined;
  finish?: string | undefined;
  events: Record<string, unknown>[];
};

export type HistorySession = {
  id: string;
  parentID?: string | undefined;
  title?: string | undefined;
  updatedAt?: number | undefined;
  cwd?: string | undefined;
  root?: string | undefined;
  project?: string | undefined;
  messages: HistoryMessage[];
  requests: HistoryRequest[];
};

export type RequestHistory = {
  sessions: HistorySession[];
  requests: HistoryRequest[];
};

export function parseJsonlRecords(input: string): CaptureRecord[] {
  return input
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as CaptureRecord);
}

export function formatCaptureSummary(records: CaptureRecord[]): string {
  if (records.length === 0) return "No capture records found.";

  const rows = records.map((record) => {
    const at = new Date(record.timestamp).toISOString();
    const providerModel = [record.providerID, record.modelID].filter(Boolean).join("/");
    return [
      at,
      record.kind.padEnd(20),
      (record.sessionID ?? "-").padEnd(16),
      (record.messageID ?? "-").padEnd(16),
      providerModel || "-"
    ].join("  ");
  });

  return [
    ["timestamp".padEnd(24), "kind".padEnd(20), "session".padEnd(16), "message".padEnd(16), "provider/model"].join("  "),
    ...rows
  ].join("\n");
}

export async function readRecentCaptures(options: InsightsOptions & { limit?: number } = {}): Promise<CaptureRecord[]> {
  const dbPath = resolveCapturePath(options);
  const sqliteRecords = await readSqliteCaptures(dbPath, options.limit ?? 20);
  if (sqliteRecords) return sqliteRecords;

  const jsonlPath = dbPath.endsWith(".sqlite") ? `${dbPath}.jsonl` : dbPath;
  if (!existsSync(jsonlPath)) return [];

  const records = parseJsonlRecords(await readFile(jsonlPath, "utf8"));
  return records.slice(-Math.max(1, options.limit ?? 20)).reverse();
}

export async function readViewerCaptures(options: InsightsOptions & { limit?: number } = {}): Promise<CaptureRecord[]> {
  const dbPath = resolveCapturePath(options);
  const sqliteRecords = await readSqliteViewerCaptures(dbPath, options.limit ?? 5000);
  if (sqliteRecords) return sqliteRecords;

  const jsonlPath = dbPath.endsWith(".sqlite") ? `${dbPath}.jsonl` : dbPath;
  if (!existsSync(jsonlPath)) return [];

  const records = parseJsonlRecords(await readFile(jsonlPath, "utf8"));
  return records
    .filter((record) => isViewerCaptureKind(record.kind))
    .slice(-Math.max(1, options.limit ?? 5000))
    .reverse();
}

export async function readCaptureRecord(id: string, options: InsightsOptions = {}): Promise<CaptureRecord | undefined> {
  const dbPath = resolveCapturePath(options);
  if (!existsSync(dbPath)) return undefined;

  try {
    const db = await openDatabase(dbPath, true);
    if (db) {
      try {
        const rows = db.all("select id, kind, timestamp, session_id, message_id, provider_id, model_id, payload_json from captures where id = ?", id);
        const row = rows[0] as SqliteRow | undefined;
        if (!row) return undefined;
        return rowToCapture(row);
      } finally {
        db.close();
      }
    }
  } catch {}

  try {
    const escapedId = id.replace(/'/g, "'\\''");
    const { stdout } = await execFileAsync("sqlite3", [
      "-json", dbPath,
      `select id, kind, timestamp, session_id, message_id, provider_id, model_id, payload_json from captures where id = '${escapedId}'`
    ], { maxBuffer: 128 * 1024 * 1024 });
    if (!stdout.trim()) return undefined;
    const rows = JSON.parse(stdout) as SqliteRow[];
    const row = rows[0];
    if (!row) return undefined;
    return rowToCapture(row);
  } catch {
    return undefined;
  }
}

export function buildRequestHistory(records: CaptureRecord[]): RequestHistory {
  const sessions = new Map<string, HistorySession>();
  const messages = new Map<string, HistoryMessage>();
  const responses = new Map<string, HistoryResponse>();
  const responsesByParent = new Map<string, HistoryResponse[]>();
  const requests: HistoryRequest[] = [];
  const pendingSystemTransforms: HistoryRequest[] = [];

  const getSession = (sessionID: string): HistorySession => {
    const existing = sessions.get(sessionID);
    if (existing) return existing;
    const created = { id: sessionID, messages: [], requests: [] };
    sessions.set(sessionID, created);
    return created;
  };

  const getMessage = (sessionID: string, messageID: string, role = "unknown"): HistoryMessage => {
    const key = `${sessionID}:${messageID}`;
    const existing = messages.get(key);
    if (existing) {
      if (existing.role === "unknown" && role !== "unknown") existing.role = role;
      return existing;
    }
    const created: HistoryMessage = { id: messageID, sessionID, role, text: "", requests: [] };
    messages.set(key, created);
    getSession(sessionID).messages.push(created);
    return created;
  };

  const getResponse = (sessionID: string, messageID: string, role = "assistant"): HistoryResponse => {
    const key = `${sessionID}:${messageID}`;
    const existing = responses.get(key);
    if (existing) {
      if (existing.role === "unknown" && role !== "unknown") existing.role = role;
      return existing;
    }
    const created: HistoryResponse = { id: messageID, sessionID, role, text: "", reasoning: "", events: [] };
    responses.set(key, created);
    return created;
  };

  const addRequest = (request: HistoryRequest) => {
    requests.push(request);
    if (request.sessionID) {
      getSession(request.sessionID).requests.push(request);
      if (request.messageID) getMessage(request.sessionID, request.messageID, "user").requests.push(request);
    }
  };

  const addResponseByParent = (response: HistoryResponse) => {
    if (!response.parentID) return;
    const key = `${response.sessionID}:${response.parentID}`;
    const parentResponses = responsesByParent.get(key) ?? [];
    if (!parentResponses.includes(response)) parentResponses.push(response);
    responsesByParent.set(key, parentResponses);
  };

  const updateSessionPath = (session: HistorySession, path: unknown) => {
    if (!isRecord(path)) return;
    session.cwd = optionalString(path.cwd) ?? session.cwd;
    session.root = optionalString(path.root) ?? session.root;
    session.project = projectName(session.root) ?? projectName(session.cwd) ?? session.project;
  };

  for (const record of records.slice().sort((a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id))) {
    if (record.sessionID) getSession(record.sessionID);

    if (record.kind === "chat.message") {
      const message = historyMessageFromChatMessage(record);
      if (message) {
        const existing = getMessage(message.sessionID, message.id, message.role);
        existing.createdAt = message.createdAt ?? existing.createdAt;
        existing.text = message.text || existing.text;
      }
    }

    if (record.kind === "chat.params" || record.kind === "experimental.chat.messages.transform" || record.kind === "experimental.chat.system.transform") {
      const request = historyRequestFromCapture(record);
      if (!request.messageID && request.sessionID) {
        request.messageID = latestUserMessageBefore(messages, request.sessionID, request.timestamp)?.id;
      }
      if (record.kind === "experimental.chat.system.transform") {
        pendingSystemTransforms.push(request);
      } else {
        attachPendingSystemTransform(pendingSystemTransforms, request);
        addRequest(request);
      }
    }

    if (record.kind === "chat.headers") {
      attachHeadersToRequest(requests, record);
    }

    if (record.kind !== "event") continue;
    const event = record.payload.event;
    if (!isRecord(event)) continue;

    const type = optionalString(event.type);
    const properties = isRecord(event.properties) ? event.properties : {};

    if (type === "session.updated" || type === "session.created") {
      const info = isRecord(properties.info) ? properties.info : {};
      const sessionID = optionalString(info.id) ?? optionalString(properties.sessionID);
      if (!sessionID) continue;
      const session = getSession(sessionID);
      session.parentID = optionalString(info.parentID) ?? session.parentID;
      session.title = optionalString(info.title) ?? session.title;
      session.updatedAt = numberFromPath(info.time, "updated") ?? session.updatedAt;
      updateSessionPath(session, info.path);
      continue;
    }

    if (type === "message.updated") {
      const info = isRecord(properties.info) ? properties.info : {};
      const sessionID = optionalString(info.sessionID) ?? optionalString(properties.sessionID);
      const messageID = optionalString(info.id);
      if (!sessionID || !messageID) continue;
      const role = optionalString(info.role) ?? "unknown";
      updateSessionPath(getSession(sessionID), info.path);
      if (role === "assistant") {
        const response = getResponse(sessionID, messageID, role);
        response.createdAt = numberFromPath(info.time, "created") ?? response.createdAt;
        response.completedAt = numberFromPath(info.time, "completed") ?? response.completedAt;
        response.parentID = optionalString(info.parentID) ?? response.parentID;
        response.tokens = info.tokens ?? response.tokens;
        response.cost = typeof info.cost === "number" ? info.cost : response.cost;
        response.finish = optionalString(info.finish) ?? response.finish;
        response.events.push(record.payload);
        addResponseByParent(response);
        continue;
      }
      const message = getMessage(sessionID, messageID, role);
      message.createdAt = numberFromPath(info.time, "created") ?? message.createdAt;
      message.completedAt = numberFromPath(info.time, "completed") ?? message.completedAt;
      continue;
    }

    if (type === "message.part.updated" || type === "message.part.delta") {
      const part = isRecord(properties.part) ? properties.part : {};
      const sessionID = optionalString(part.sessionID) ?? optionalString(properties.sessionID);
      const messageID = optionalString(part.messageID) ?? optionalString(properties.messageID);
      if (!sessionID || !messageID) continue;
      const partType = optionalString(part.type);
      const field = optionalString(properties.field);
      const delta = optionalString(properties.delta);
      const text = optionalString(part.text);
      const reasonText = optionalString(part.text) ?? optionalString(part.markdown);
      const targetResponse = responses.get(`${sessionID}:${messageID}`);
      if (targetResponse) {
        targetResponse.events.push(record.payload);
        if (partType === "text" && text !== undefined) targetResponse.text = text;
        if (partType === "reasoning" && reasonText !== undefined) targetResponse.reasoning = reasonText;
        if (type === "message.part.delta" && field === "text" && delta !== undefined) targetResponse.text += delta;
        continue;
      }
      if (partType !== "text" && partType !== "reasoning") continue;
      if (text === undefined) continue;
      const message = getMessage(sessionID, messageID);
      message.text = text;
    }
  }

  for (const request of pendingSystemTransforms) addRequest(request);

  for (const session of sessions.values()) {
    for (const message of session.messages) {
      const messageResponses = (responsesByParent.get(`${message.sessionID}:${message.id}`) ?? []).sort(
        (a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0)
      );
      message.response = messageResponses.at(-1);

      let responseIndex = 0;
      for (const request of message.requests.slice().sort((a, b) => a.timestamp - b.timestamp)) {
        if (!requestShouldOwnAssistantResponse(request)) continue;
        request.response = messageResponses[responseIndex] ?? message.response;
        if (responseIndex < messageResponses.length) responseIndex += 1;
      }
    }
    session.messages.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
    session.requests.sort((a, b) => a.timestamp - b.timestamp);
  }

  return {
    sessions: [...sessions.values()].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0)),
    requests: requests.sort((a, b) => b.timestamp - a.timestamp)
  };
}

function ensureEventTypeColumn(db: SqliteDb) {
  const existing = db.all("select name from pragma_table_info('captures') where name = 'event_type'");
  if (existing.length === 0) {
    db.run(`alter table captures add column event_type text`);
  }
  db.run(`update captures set event_type = json_extract(payload_json, '$.event.type') where kind = 'event' and event_type is null`);
}

async function readSqliteCaptures(path: string, limit: number): Promise<CaptureRecord[] | undefined> {
  if (!existsSync(path)) return undefined;

  try {
    const db = await openDatabase(path, true);
    if (!db) return readSqliteCapturesWithCli(path, limit);
    try {
      ensureEventTypeColumn(db);
      const rows = db.all(recentCaptureSql(Math.max(1, limit)));
      return dedupeRows(rows as SqliteRow[]).map(rowToCapture);
    } finally {
      db.close();
    }
  } catch {
    return readSqliteCapturesWithCli(path, limit);
  }
}

async function runSqlite3Json(path: string, sql: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("sqlite3", ["-json", path, sql], {
      maxBuffer: 128 * 1024 * 1024
    });
    return stdout;
  } catch {
    return undefined;
  }
}

async function readSqliteCapturesWithCli(path: string, limit: number): Promise<CaptureRecord[] | undefined> {
  if (!existsSync(path)) return undefined;

  // Ensure event_type column exists (attempt, ignore failure)
  await runSqlite3Json(path, "alter table captures add column event_type text");
  await runSqlite3Json(path, "update captures set event_type = json_extract(payload_json, '$.event.type') where kind = 'event' and event_type is null");

  const stdout = await runSqlite3Json(path, recentCaptureSql(Math.max(1, Math.trunc(limit))));
  if (!stdout?.trim()) return [];
  return dedupeRows(JSON.parse(stdout) as SqliteRow[]).map(rowToCapture);
}

async function readSqliteViewerCaptures(path: string, limit: number): Promise<CaptureRecord[] | undefined> {
  if (!existsSync(path)) return undefined;

  try {
    const db = await openDatabase(path, true);
    if (!db) return readSqliteViewerCapturesWithCli(path, limit);
    try {
      ensureEventTypeColumn(db);
      const rows = db.all(viewerCaptureSql(Math.max(1, limit)));
      return dedupeRows(rows as SqliteRow[]).map(rowToCapture);
    } finally {
      db.close();
    }
  } catch {
    return readSqliteViewerCapturesWithCli(path, limit);
  }
}

async function readSqliteViewerCapturesWithCli(path: string, limit: number): Promise<CaptureRecord[] | undefined> {
  if (!existsSync(path)) return undefined;

  // Ensure event_type column exists (attempt, ignore failure)
  await runSqlite3Json(path, "alter table captures add column event_type text");
  await runSqlite3Json(path, "update captures set event_type = json_extract(payload_json, '$.event.type') where kind = 'event' and event_type is null");

  const stdout = await runSqlite3Json(path, viewerCaptureSql(Math.max(1, Math.trunc(limit))));
  if (!stdout?.trim()) return [];
  return dedupeRows(JSON.parse(stdout) as SqliteRow[]).map(rowToCapture);
}

function recentCaptureSql(limit: number) {
  return `select id, kind, timestamp, session_id, message_id, provider_id, model_id, payload_json
          from captures
          where id in (
            select id from captures
            where kind in (
              'chat.params',
              'chat.message',
              'chat.headers',
              'experimental.chat.messages.transform',
              'experimental.chat.system.transform'
            )
            order by timestamp desc
            limit ${limit}
          )
          or id in (
            select id from captures
            where kind = 'event'
              and event_type in (
                'message.updated',
                'message.part.updated',
                'message.part.delta',
                'session.updated',
                'session.created'
              )
            order by timestamp desc
            limit ${limit}
          )
          order by timestamp desc`;
}

function viewerCaptureSql(limit: number) {
  return `select id, kind, timestamp, session_id, message_id, provider_id, model_id, payload_json
          from captures
          where id in (
            select id from captures
            where kind in (
              'chat.params',
              'chat.message',
              'experimental.chat.system.transform'
            )
            order by timestamp desc
            limit ${limit}
          )
          or id in (
            select id from captures
            where kind = 'event'
              and event_type in (
                'message.updated',
                'message.part.updated',
                'message.part.delta',
                'session.updated',
                'session.created'
              )
            order by timestamp desc
            limit ${limit}
          )
          order by timestamp desc`;
}

function isViewerCaptureKind(kind: CaptureRecord["kind"]) {
  return kind === "chat.params" || kind === "chat.message" || kind === "experimental.chat.system.transform" || kind === "event";
}

function dedupeRows(rows: SqliteRow[]) {
  const seen = new Set<string>();
  return rows.filter((row) => {
    if (seen.has(row.id)) return false;
    seen.add(row.id);
    return true;
  });
}

function rowToCapture(row: SqliteRow): CaptureRecord {
  return {
    id: row.id,
    kind: row.kind,
    timestamp: row.timestamp,
    sessionID: row.session_id ?? undefined,
    messageID: row.message_id ?? undefined,
    providerID: row.provider_id ?? undefined,
    modelID: row.model_id ?? undefined,
    payload: JSON.parse(row.payload_json) as Record<string, unknown>
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function historyRequestFromCapture(record: CaptureRecord): HistoryRequest {
  const input = isRecord(record.payload.input) ? record.payload.input : {};
  const agent = agentFromCapture(record, input);
  return {
    id: record.id,
    sessionID: record.sessionID,
    messageID: messageIDForCapture(record, input),
    timestamp: record.timestamp,
    agent,
    purpose: purposeFromAgent(agent),
    providerID: record.providerID,
    modelID: record.modelID,
    summary: summarizePayload(record.payload),
    payload: record.payload
  };
}

function requestShouldOwnAssistantResponse(request: HistoryRequest) {
  return request.agent !== "title";
}

function purposeFromAgent(agent: string | undefined) {
  if (agent === "title") return "Generate or update the session title. This is not the assistant reply shown in the conversation.";
  if (agent === "build") return "Generate the assistant response for the user message.";
  if (agent === "messages.transform") return "Capture the final conversation messages OpenCode prepared before model execution.";
  if (agent === "system.transform") return "Capture the system prompt strings OpenCode prepared before model execution.";
  if (agent) return `Run the ${agent} agent for this message.`;
  return "Run an OpenCode model request for this message.";
}

function agentFromCapture(record: CaptureRecord, input: Record<string, unknown>) {
  if (record.kind === "experimental.chat.messages.transform") return "messages.transform";
  if (record.kind === "experimental.chat.system.transform") return "system.transform";
  return optionalString(input.agent);
}

function messageIDForCapture(record: CaptureRecord, input: Record<string, unknown>) {
  return record.messageID ?? messageIDFromPayload(input.message);
}

function attachPendingSystemTransform(pendingSystemTransforms: HistoryRequest[], request: HistoryRequest) {
  let index = -1;
  for (let candidateIndex = pendingSystemTransforms.length - 1; candidateIndex >= 0; candidateIndex -= 1) {
    const candidate = pendingSystemTransforms[candidateIndex];
    if (
      candidate &&
      candidate.sessionID === request.sessionID &&
      candidate.providerID === request.providerID &&
      candidate.modelID === request.modelID &&
      candidate.timestamp <= request.timestamp &&
      request.timestamp - candidate.timestamp <= 5_000
    ) {
      index = candidateIndex;
      break;
    }
  }
  if (index < 0) return;
  const [system] = pendingSystemTransforms.splice(index, 1);
  if (!system) return;
  request.system = { id: system.id, timestamp: system.timestamp, payload: system.payload };
}

function latestUserMessageBefore(messages: Map<string, HistoryMessage>, sessionID: string, timestamp: number) {
  let latest: HistoryMessage | undefined;
  for (const message of messages.values()) {
    if (message.sessionID !== sessionID || message.role !== "user") continue;
    if ((message.createdAt ?? Number.NEGATIVE_INFINITY) > timestamp) continue;
    if (!latest || (message.createdAt ?? 0) > (latest.createdAt ?? 0)) latest = message;
  }
  return latest;
}

function summarizePayload(payload: Record<string, unknown>) {
  const input = isRecord(payload.input) ? payload.input : {};
  const message = isRecord(input.message) ? input.message : {};
  const text = textFromMessagePayload(message) ?? findFirstString(input, ["prompt", "input"]);
  if (!text) return "LLM request";
  return text.replace(/\s+/g, " ").trim().slice(0, 160);
}

function historyMessageFromChatMessage(record: CaptureRecord): HistoryMessage | undefined {
  const output = isRecord(record.payload.output) ? record.payload.output : {};
  const message = isRecord(output.message) ? output.message : {};
  const sessionID = record.sessionID ?? optionalString(message.sessionID);
  const messageID = optionalString(message.id);
  if (!sessionID || !messageID) return undefined;
  return {
    id: messageID,
    sessionID,
    role: optionalString(message.role) ?? "user",
    createdAt: numberFromPath(message.time, "created") ?? record.timestamp,
    completedAt: numberFromPath(message.time, "completed"),
    text: textFromChatMessageOutput(output),
    requests: []
  };
}

function attachHeadersToRequest(requests: HistoryRequest[], record: CaptureRecord) {
  const input = isRecord(record.payload.input) ? record.payload.input : {};
  const agent = optionalString(input.agent);
  const messageID = record.messageID ?? messageIDFromPayload(input.message);
  const match = requests
    .slice()
    .reverse()
    .find((request) => {
      return (
        request.sessionID === record.sessionID &&
        request.messageID === messageID &&
        request.agent === agent &&
        request.providerID === record.providerID &&
        request.modelID === record.modelID &&
        request.timestamp <= record.timestamp &&
        !request.headers
      );
    });
  if (!match) return;
  match.headers = { id: record.id, timestamp: record.timestamp, payload: record.payload };
}

function textFromChatMessageOutput(output: Record<string, unknown>) {
  const parts = Array.isArray(output.parts) ? output.parts : [];
  return parts
    .map((part) => (isRecord(part) ? optionalString(part.text) ?? optionalString(part.content) : undefined))
    .filter((text): text is string => !!text)
    .join("\n");
}

function textFromMessagePayload(message: Record<string, unknown>) {
  const direct = findFirstString(message, ["text", "content"]);
  if (direct) return direct;
  const parts = Array.isArray(message.parts) ? message.parts : [];
  const joined = parts
    .map((part) => (isRecord(part) ? optionalString(part.text) ?? optionalString(part.content) : undefined))
    .filter((text): text is string => !!text)
    .join("\n");
  return joined || undefined;
}

function messageIDFromPayload(message: unknown) {
  return isRecord(message) ? optionalString(message.id) ?? optionalString(message.messageID) ?? optionalString(message.messageId) : undefined;
}

function findFirstString(value: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const item = value[key];
    if (typeof item === "string" && item.length > 0) return item;
  }
  return undefined;
}

function projectName(path: string | undefined) {
  if (!path) return undefined;
  const normalized = path.replace(/\/+$/, "");
  if (!normalized) return undefined;
  return normalized.split("/").filter(Boolean).at(-1) ?? normalized;
}

function numberFromPath(value: unknown, key: string) {
  if (!isRecord(value)) return undefined;
  const item = value[key];
  return typeof item === "number" && Number.isFinite(item) ? item : undefined;
}
