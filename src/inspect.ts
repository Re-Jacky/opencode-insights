import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolveCapturePath, type CaptureRecord, type InsightsOptions } from "./capture.js";

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

type BunDatabase = {
  query(sql: string): { all(...params: unknown[]): SqliteRow[] };
  close(): void;
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

async function readSqliteCaptures(path: string, limit: number): Promise<CaptureRecord[] | undefined> {
  if (!existsSync(path)) return undefined;

  try {
    const mod = (await import("bun:sqlite").catch(() => undefined)) as
      | { Database: new (path: string, options?: { readonly?: boolean }) => BunDatabase }
      | undefined;
    if (!mod) return undefined;

    const db = new mod.Database(path, { readonly: true });
    try {
      const rows = db
        .query(
          `select id, kind, timestamp, session_id, message_id, provider_id, model_id, payload_json
           from captures
           order by timestamp desc
           limit ?`
        )
        .all(Math.max(1, limit));
      return rows.map(rowToCapture);
    } finally {
      db.close();
    }
  } catch {
    return undefined;
  }
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
