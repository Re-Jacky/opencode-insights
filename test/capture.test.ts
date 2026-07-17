import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "vitest";
import {
  JsonlCaptureStore,
  createCaptureStore,
  defaultDataDir,
  normalizeChatParamsCapture,
  normalizeEventCapture,
  normalizeExperimentalChatMessagesTransformCapture,
  normalizeExperimentalChatSystemTransformCapture,
  normalizeToolCapture,
  openDatabase
} from "../src/capture.js";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("full-fidelity local capture", () => {
  test("uses a cross-platform home directory for default storage", () => {
    expect(defaultDataDir()).toMatch(/\.opencode-insights$/);
  });

  test("normalizes chat params without redacting headers or body", () => {
    const record = normalizeChatParamsCapture(
      {
        sessionID: "ses_1",
        agent: "build",
        model: { id: "gpt-test" },
        provider: {
          source: "env",
          info: { id: "openai", name: "OpenAI" },
          options: { apiKey: "secret-key" }
        },
        message: { id: "msg_1", role: "user", content: "private prompt" }
      },
      {
        temperature: 0.2,
        topP: 1,
        topK: 50,
        maxOutputTokens: 4096,
        options: { headers: { authorization: "Bearer secret" } }
      },
      10
    );

    expect(record.kind).toBe("chat.params");
    expect(record.payload).toMatchObject({
      input: {
        provider: {
          options: { apiKey: "secret-key" }
        },
        message: { content: "private prompt" }
      },
      output: {
        options: { headers: { authorization: "Bearer secret" } }
      }
    });
  });

  test("indexes event part message ids for response-side lookup", () => {
    const record = normalizeEventCapture(
      {
        type: "message.part.updated",
        properties: {
          sessionID: "ses_1",
          part: {
            id: "part_1",
            type: "text",
            messageID: "msg_assistant",
            sessionID: "ses_1",
            text: "assistant response"
          }
        }
      },
      20
    );

    expect(record).toMatchObject({
      kind: "event",
      sessionID: "ses_1",
      messageID: "msg_assistant"
    });
  });

  test("captures request-context transform hooks without redaction", () => {
    const messages = normalizeExperimentalChatMessagesTransformCapture(
      {},
      {
        messages: [
          {
            info: { id: "msg_1", role: "user", sessionID: "ses_1" },
            parts: [{ type: "text", text: "private prompt", secret: "keep-me" }]
          }
        ]
      },
      40
    );

    const system = normalizeExperimentalChatSystemTransformCapture(
      { sessionID: "ses_1", model: { providerID: "openai", id: "gpt-test" } },
      { system: ["system secret", "developer instruction"] },
      50
    );

    expect(messages).toMatchObject({
      kind: "experimental.chat.messages.transform",
      payload: {
        output: {
          messages: [
            {
              parts: [{ secret: "keep-me" }]
            }
          ]
        }
      }
    });
    expect(system).toMatchObject({
      kind: "experimental.chat.system.transform",
      sessionID: "ses_1",
      providerID: "openai",
      modelID: "gpt-test",
      payload: { output: { system: ["system secret", "developer instruction"] } }
    });
  });

  test("persists normalized records to a local append-only DB file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "opencode-insights-"));
    cleanup.push(dir);
    const path = join(dir, "capture.jsonl");
    const store = new JsonlCaptureStore(path);
    const now = Date.now();

    await store.append(normalizeEventCapture({ type: "message.updated", secret: "keep-me" }, now));
    await store.append(
      normalizeToolCapture(
        "tool.execute.before",
        { tool: "bash", sessionID: "ses_1", callID: "call_1" },
        { args: { command: "echo secret" } },
        now + 1
      )
    );

    const lines = (await readFile(path, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(lines).toHaveLength(2);
    expect(lines[0].payload.event.secret).toBe("keep-me");
    expect(lines[1].payload.output.args.command).toBe("echo secret");
  });

  test("auto-cleans SQLite captures older than the configured retention window", async () => {
    const dir = await mkdtemp(join(tmpdir(), "opencode-insights-"));
    cleanup.push(dir);
    const dbPath = join(dir, "insights.sqlite");
    const now = Date.now();
    const store = createCaptureStore({ dbPath, retentionDays: 1 });

    await store.initialize?.();
    await store.append(normalizeEventCapture({ type: "message.updated", id: "old" }, now - 2 * 24 * 60 * 60 * 1000));
    await store.append(normalizeEventCapture({ type: "message.updated", id: "fresh" }, now));
    await store.close?.();

    const db = await openDatabase(dbPath);
    expect(db).toBeDefined();
    try {
      const rows = db?.all("select id, timestamp, payload_json from captures order by timestamp") ?? [];
      expect(rows).toHaveLength(1);
      expect(JSON.parse(String(rows[0]?.payload_json)).event.id).toBe("fresh");
    } finally {
      db?.close();
    }
  });
});
