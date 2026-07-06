import { mkdir, appendFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export type CaptureKind =
  | "chat.message"
  | "chat.params"
  | "chat.headers"
  | "event"
  | "tool.execute.before"
  | "tool.execute.after";

export type CaptureRecord = {
  id: string;
  kind: CaptureKind;
  timestamp: number;
  sessionID?: string | undefined;
  messageID?: string | undefined;
  providerID?: string | undefined;
  modelID?: string | undefined;
  payload: Record<string, unknown>;
};

export type CaptureStore = {
  append(record: CaptureRecord): Promise<void>;
  close?(): Promise<void>;
};

export type InsightsOptions = {
  dataDir?: unknown;
  dbPath?: unknown;
};

let sequence = 0;

function nextID(timestamp: number) {
  sequence += 1;
  return `${timestamp.toString(36)}-${sequence.toString(36)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function modelIDFrom(input: unknown): string | undefined {
  if (!isRecord(input)) return undefined;
  return optionalString(input.modelID) ?? optionalString(input.id) ?? optionalString(input.name);
}

function providerIDFrom(input: unknown): string | undefined {
  if (!isRecord(input)) return undefined;
  const info = isRecord(input.info) ? input.info : undefined;
  return optionalString(info?.id) ?? optionalString(info?.name) ?? optionalString(input.id);
}

function sessionIDFrom(input: unknown): string | undefined {
  if (!isRecord(input)) return undefined;
  return optionalString(input.sessionID) ?? optionalString(input.sessionId);
}

function messageIDFrom(input: unknown): string | undefined {
  if (!isRecord(input)) return undefined;
  return optionalString(input.messageID) ?? optionalString(input.messageId);
}

function compactUndefined<T extends Record<string, unknown>>(value: T): T {
  for (const key of Object.keys(value)) {
    if (value[key] === undefined) delete value[key];
  }
  return value;
}

function captureRecord(input: {
  id: string;
  kind: CaptureKind;
  timestamp: number;
  sessionID?: string | undefined;
  messageID?: string | undefined;
  providerID?: string | undefined;
  modelID?: string | undefined;
  payload: Record<string, unknown>;
}): CaptureRecord {
  return compactUndefined({ ...input }) as CaptureRecord;
}

export function defaultDataDir() {
  return join(homedir(), ".local", "share", "opencode-insights");
}

export function resolveCapturePath(options: InsightsOptions = {}) {
  if (typeof options.dbPath === "string" && options.dbPath.length > 0) {
    return options.dbPath;
  }

  const dataDir =
    typeof options.dataDir === "string" && options.dataDir.length > 0
      ? options.dataDir
      : defaultDataDir();
  return join(dataDir, "requests.sqlite");
}

export function normalizeChatMessageCapture(input: unknown, output: unknown, timestamp = Date.now()): CaptureRecord {
  const inputRecord = isRecord(input) ? input : {};
  const model = isRecord(inputRecord.model) ? inputRecord.model : undefined;
  return captureRecord({
    id: nextID(timestamp),
    kind: "chat.message",
    timestamp,
    sessionID: sessionIDFrom(inputRecord),
    messageID: messageIDFrom(inputRecord),
    providerID: model ? optionalString(model.providerID) : undefined,
    modelID: model ? optionalString(model.modelID) : undefined,
    payload: { input, output }
  });
}

export function normalizeChatParamsCapture(input: unknown, output: unknown, timestamp = Date.now()): CaptureRecord {
  const inputRecord = isRecord(input) ? input : {};
  return captureRecord({
    id: nextID(timestamp),
    kind: "chat.params",
    timestamp,
    sessionID: sessionIDFrom(inputRecord),
    messageID: messageIDFrom(inputRecord.message),
    providerID: providerIDFrom(inputRecord.provider),
    modelID: modelIDFrom(inputRecord.model),
    payload: { input, output }
  });
}

export function normalizeChatHeadersCapture(input: unknown, output: unknown, timestamp = Date.now()): CaptureRecord {
  const inputRecord = isRecord(input) ? input : {};
  return captureRecord({
    id: nextID(timestamp),
    kind: "chat.headers",
    timestamp,
    sessionID: sessionIDFrom(inputRecord),
    messageID: messageIDFrom(inputRecord.message),
    providerID: providerIDFrom(inputRecord.provider),
    modelID: modelIDFrom(inputRecord.model),
    payload: { input, output }
  });
}

export function normalizeEventCapture(event: unknown, timestamp = Date.now()): CaptureRecord {
  const record = isRecord(event) ? event : {};
  const properties = isRecord(record.properties) ? record.properties : {};
  const info = isRecord(properties.info) ? properties.info : {};
  return captureRecord({
    id: nextID(timestamp),
    kind: "event",
    timestamp,
    sessionID: sessionIDFrom(properties) ?? sessionIDFrom(info) ?? sessionIDFrom(record),
    messageID: messageIDFrom(properties) ?? messageIDFrom(info),
    payload: { event }
  });
}

export function normalizeToolCapture(
  kind: "tool.execute.before" | "tool.execute.after",
  input: unknown,
  output: unknown,
  timestamp = Date.now()
): CaptureRecord {
  const inputRecord = isRecord(input) ? input : {};
  return captureRecord({
    id: nextID(timestamp),
    kind,
    timestamp,
    sessionID: sessionIDFrom(inputRecord),
    payload: { input, output }
  });
}

export class JsonlCaptureStore implements CaptureStore {
  constructor(private readonly path: string) {}

  async append(record: CaptureRecord) {
    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, `${JSON.stringify(record)}\n`, "utf8");
  }
}

type BunSqliteDatabase = {
  run(sql: string, ...params: unknown[]): unknown;
  close?(): void;
};

export class SqliteCaptureStore implements CaptureStore {
  private db: BunSqliteDatabase | undefined;
  private unavailable = false;

  constructor(private readonly path: string) {}

  async append(record: CaptureRecord) {
    const db = await this.database();
    if (!db) {
      const fallbackPath = this.path.endsWith(".sqlite") ? `${this.path}.jsonl` : this.path;
      await new JsonlCaptureStore(fallbackPath).append(record);
      return;
    }

    db.run(
      `insert into captures (
        id, kind, timestamp, session_id, message_id, provider_id, model_id, payload_json
      ) values (?, ?, ?, ?, ?, ?, ?, ?)`,
      record.id,
      record.kind,
      record.timestamp,
      record.sessionID ?? null,
      record.messageID ?? null,
      record.providerID ?? null,
      record.modelID ?? null,
      JSON.stringify(record.payload)
    );
  }

  async close() {
    this.db?.close?.();
    this.db = undefined;
  }

  private async database() {
    if (this.db) return this.db;
    if (this.unavailable) return undefined;

    try {
      await mkdir(dirname(this.path), { recursive: true });
      const mod = (await import("bun:sqlite").catch(() => undefined)) as
        | { Database: new (path: string) => BunSqliteDatabase }
        | undefined;
      if (!mod) {
        this.unavailable = true;
        return undefined;
      }
      const db = new mod.Database(this.path);
      db.run(`create table if not exists captures (
        id text primary key,
        kind text not null,
        timestamp integer not null,
        session_id text,
        message_id text,
        provider_id text,
        model_id text,
        payload_json text not null
      )`);
      db.run(`create index if not exists captures_timestamp_idx on captures(timestamp)`);
      db.run(`create index if not exists captures_session_idx on captures(session_id)`);
      this.db = db;
      return db;
    } catch {
      this.unavailable = true;
      return undefined;
    }
  }
}

export function createCaptureStore(options: InsightsOptions = {}): CaptureStore {
  return new SqliteCaptureStore(resolveCapturePath(options));
}
