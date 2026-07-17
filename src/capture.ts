import { mkdir, appendFile, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export type CaptureKind =
  | "chat.message"
  | "chat.params"
  | "chat.headers"
  | "experimental.chat.messages.transform"
  | "experimental.chat.system.transform"
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
  initialize?(): Promise<void>;
  append(record: CaptureRecord): Promise<void>;
  close?(): Promise<void>;
};

export type InsightsOptions = {
  dataDir?: unknown;
  dbPath?: unknown;
  retentionDays?: unknown;
};

const DEFAULT_RETENTION_DAYS = 1;
const DAY_MS = 24 * 60 * 60 * 1000;

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

function transformedMessages(output: unknown): Record<string, unknown>[] {
  if (!isRecord(output) || !Array.isArray(output.messages)) return [];
  return output.messages.filter((message) => isRecord(message));
}

function infoFromTransformedMessage(message: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  return isRecord(message?.info) ? message.info : undefined;
}

function latestUserTransformedMessage(output: unknown): Record<string, unknown> | undefined {
  return transformedMessages(output)
    .slice()
    .reverse()
    .find((message) => optionalString(infoFromTransformedMessage(message)?.role) === "user");
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
  return join(homedir(), ".opencode-insights");
}

export function resolveCapturePath(options: InsightsOptions = {}) {
  if (typeof options.dbPath === "string" && options.dbPath.length > 0) {
    return options.dbPath;
  }

  const dataDir =
    typeof options.dataDir === "string" && options.dataDir.length > 0
      ? options.dataDir
      : defaultDataDir();
  return join(dataDir, "insights.sqlite");
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

export function normalizeExperimentalChatMessagesTransformCapture(input: unknown, output: unknown, timestamp = Date.now()): CaptureRecord {
  const inputRecord = isRecord(input) ? input : {};
  const latestUserMessage = latestUserTransformedMessage(output);
  const info = infoFromTransformedMessage(latestUserMessage);
  return captureRecord({
    id: nextID(timestamp),
    kind: "experimental.chat.messages.transform",
    timestamp,
    sessionID: sessionIDFrom(inputRecord),
    messageID: messageIDFrom(info) ?? optionalString(info?.id),
    payload: { input, output }
  });
}

export function normalizeExperimentalChatSystemTransformCapture(input: unknown, output: unknown, timestamp = Date.now()): CaptureRecord {
  const inputRecord = isRecord(input) ? input : {};
  const model = isRecord(inputRecord.model) ? inputRecord.model : undefined;
  return captureRecord({
    id: nextID(timestamp),
    kind: "experimental.chat.system.transform",
    timestamp,
    sessionID: sessionIDFrom(inputRecord),
    providerID: model ? optionalString(model.providerID) : undefined,
    modelID: model ? modelIDFrom(model) : undefined,
    payload: { input, output }
  });
}

export function normalizeEventCapture(event: unknown, timestamp = Date.now()): CaptureRecord {
  const record = isRecord(event) ? event : {};
  const properties = isRecord(record.properties) ? record.properties : {};
  const info = isRecord(properties.info) ? properties.info : {};
  const part = isRecord(properties.part) ? properties.part : {};
  return captureRecord({
    id: nextID(timestamp),
    kind: "event",
    timestamp,
    sessionID: sessionIDFrom(properties) ?? sessionIDFrom(info) ?? sessionIDFrom(part) ?? sessionIDFrom(record),
    messageID: messageIDFrom(properties) ?? messageIDFrom(info) ?? messageIDFrom(part),
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
  constructor(private readonly path: string, private readonly retentionMs = retentionMsFromDays(DEFAULT_RETENTION_DAYS)) {}

  async initialize() {
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, "", { flag: "a" });
    await this.pruneExpired();
  }

  async append(record: CaptureRecord) {
    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, `${JSON.stringify(record)}\n`, "utf8");
    await this.pruneExpired();
  }

  private async pruneExpired(now = Date.now()) {
    const cutoff = retentionCutoff(now, this.retentionMs);
    if (cutoff === undefined || !existsSync(this.path)) return;
    try {
      const lines = (await readFile(this.path, "utf8")).split(/\r?\n/);
      const kept = lines.filter((line) => {
        const trimmed = line.trim();
        if (!trimmed) return false;
        try {
          const record = JSON.parse(trimmed) as { timestamp?: unknown };
          return typeof record.timestamp !== "number" || record.timestamp >= cutoff;
        } catch {
          return true;
        }
      });
      await writeFile(this.path, kept.length ? `${kept.join("\n")}\n` : "", "utf8");
    } catch {}
  }
}

export interface SqliteDb {
  all(sql: string, ...params: unknown[]): Record<string, unknown>[];
  run(sql: string, ...params: unknown[]): void;
  sync(): void;
  close(): void;
}

export async function openDatabase(path: string): Promise<SqliteDb | undefined> {
  try {
    const mod = (await import("bun:sqlite").catch(() => undefined)) as
      | { Database: new (path: string) => { query(sql: string): { all(...params: unknown[]): Record<string, unknown>[] }; run(sql: string, ...params: unknown[]): void; close(): void } }
      | undefined;
    if (mod) {
      const db = new mod.Database(path);
      return {
        all(sql, ...params) { return db.query(sql).all(...params); },
        run(sql, ...params) { db.run(sql, ...params); },
        sync() {},
        close() { db.close(); }
      };
    }
  } catch {}

  try {
    const mod = (await import("better-sqlite3").catch(() => undefined)) as
      | { default?: new (path: string) => { prepare(sql: string): { all(...params: unknown[]): Record<string, unknown>[]; run(...params: unknown[]): void }; close(): void } }
      | undefined;
    const Database = mod?.default;
    if (Database) {
      const db = new Database(path);
      return {
        all(sql, ...params) {
          return db.prepare(sql).all(...params);
        },
        run(sql, ...params) {
          db.prepare(sql).run(...params);
        },
        sync() {},
        close() {
          db.close();
        }
      };
    }
  } catch {}

  return undefined;
}

export class SqliteCaptureStore implements CaptureStore {
  private db: SqliteDb | undefined;
  private fallbackStore: JsonlCaptureStore | undefined;

  constructor(private readonly path: string, private readonly retentionMs = retentionMsFromDays(DEFAULT_RETENTION_DAYS)) {}

  async initialize() {
    await mkdir(dirname(this.path), { recursive: true });
    const db = await openDatabase(this.path);
    if (!db) {
      const fallbackPath = this.path.endsWith(".sqlite") ? `${this.path}.jsonl` : this.path;
      this.fallbackStore = new JsonlCaptureStore(fallbackPath, this.retentionMs);
      await this.fallbackStore.initialize();
      return;
    }
    this.db = db;
    this.db.run(
      `create table if not exists captures (
        id text primary key,
        kind text not null,
        timestamp integer not null,
        session_id text,
        message_id text,
        provider_id text,
        model_id text,
        payload_json text not null
      )`
    );
    this.db.run(`create index if not exists captures_timestamp_idx on captures(timestamp)`);
    this.db.run(`create index if not exists captures_session_idx on captures(session_id)`);
    this.db.run(`create index if not exists captures_kind_timestamp_idx on captures(kind, timestamp)`);
    this.pruneExpired();
    this.db.sync();
  }

  async append(record: CaptureRecord) {
    if (this.fallbackStore) {
      await this.fallbackStore.append(record);
      return;
    }

    if (!this.db) {
      await mkdir(dirname(this.path), { recursive: true });
      const db = await openDatabase(this.path);
      if (!db) {
        const fallbackPath = this.path.endsWith(".sqlite") ? `${this.path}.jsonl` : this.path;
        this.fallbackStore = new JsonlCaptureStore(fallbackPath, this.retentionMs);
        await this.fallbackStore.initialize();
        await this.fallbackStore.append(record);
        return;
      }
      this.db = db;
    }

    this.db.run(
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
    this.pruneExpired();
    this.db.sync();
  }

  async close() {
    this.db?.close();
    this.db = undefined;
    this.fallbackStore = undefined;
  }

  private pruneExpired(now = Date.now()) {
    const cutoff = retentionCutoff(now, this.retentionMs);
    if (cutoff === undefined) return;
    this.db?.run("delete from captures where timestamp < ?", cutoff);
  }
}

export function createCaptureStore(options: InsightsOptions = {}): CaptureStore {
  return new SqliteCaptureStore(resolveCapturePath(options), retentionMsFromDays(resolveRetentionDays(options.retentionDays)));
}

export function resolveRetentionDays(value: unknown) {
  if (value === undefined || value === null || value === "") return DEFAULT_RETENTION_DAYS;
  const numeric = typeof value === "number" ? value : typeof value === "string" ? Number.parseFloat(value) : Number.NaN;
  if (!Number.isFinite(numeric) || numeric < 0) return DEFAULT_RETENTION_DAYS;
  return numeric;
}

function retentionMsFromDays(days: number) {
  return days <= 0 ? undefined : days * DAY_MS;
}

function retentionCutoff(now: number, retentionMs: number | undefined) {
  return retentionMs === undefined ? undefined : now - retentionMs;
}
