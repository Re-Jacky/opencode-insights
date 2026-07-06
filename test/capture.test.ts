import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "vitest";
import {
  JsonlCaptureStore,
  normalizeChatParamsCapture,
  normalizeEventCapture,
  normalizeToolCapture
} from "../src/capture.js";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("full-fidelity local capture", () => {
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

  test("persists normalized records to a local append-only DB file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "opencode-insights-"));
    cleanup.push(dir);
    const path = join(dir, "capture.jsonl");
    const store = new JsonlCaptureStore(path);

    await store.append(normalizeEventCapture({ type: "message.updated", secret: "keep-me" }, 20));
    await store.append(
      normalizeToolCapture(
        "tool.execute.before",
        { tool: "bash", sessionID: "ses_1", callID: "call_1" },
        { args: { command: "echo secret" } },
        30
      )
    );

    const lines = (await readFile(path, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(lines).toHaveLength(2);
    expect(lines[0].payload.event.secret).toBe("keep-me");
    expect(lines[1].payload.output.args.command).toBe("echo secret");
  });
});
