import { describe, expect, test } from "vitest";
import { buildViewerHiddenContexts, buildViewerVisibleSteps, readHistory, renderViewerHtml } from "../src/viewer.js";
import type { HistoryMessage } from "../src/inspect.js";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

describe("viewer conversation helpers", () => {
  test("renders a persisted dark and light theme switcher", () => {
    const html = renderViewerHtml("/tmp/insights.sqlite");

    expect(html).toContain('id="theme-toggle"');
    expect(html).toContain('data-theme-option="dark"');
    expect(html).toContain('data-theme-option="light"');
    expect(html).toContain("opencode-insights-theme");
    expect(html).not.toContain('data-theme-option="system"');
    expect(html).toMatch(/<div class="brand">\s*<h1>OpenCode Insights<\/h1>\s*<div id="theme-toggle"/);
  });

  test("does not show identical reasoning and response text twice", () => {
    const message: HistoryMessage = {
      id: "msg_user",
      sessionID: "ses_1",
      role: "user",
      text: "dispatch a subagent",
      requests: [
        {
          id: "req_1",
          sessionID: "ses_1",
          messageID: "msg_user",
          timestamp: 1_000,
          agent: "build",
          purpose: "Generate the assistant response for the user message.",
          summary: "dispatch a subagent",
          payload: {},
          response: {
            id: "msg_assistant",
            sessionID: "ses_1",
            role: "assistant",
            text: "The user wants me to dispatch a subagent.",
            reasoning: "The user wants me to dispatch a subagent.",
            events: []
          }
        }
      ]
    };

    expect(buildViewerVisibleSteps(message)).toEqual([
      {
        label: "build thinking",
        text: "The user wants me to dispatch a subagent."
      }
    ]);
  });

  test("dedupes repeated hidden system prompts and renders plain text", () => {
    const system = { system: ["You are opencode.", "Keep responses short."] };
    const message: HistoryMessage = {
      id: "msg_user",
      sessionID: "ses_1",
      role: "user",
      text: "hi",
      requests: [
        {
          id: "req_1",
          sessionID: "ses_1",
          messageID: "msg_user",
          timestamp: 1_000,
          agent: "build",
          purpose: "Generate the assistant response for the user message.",
          summary: "hi",
          payload: {},
          system: { id: "sys_1", timestamp: 999, payload: { output: system } }
        },
        {
          id: "req_2",
          sessionID: "ses_1",
          messageID: "msg_user",
          timestamp: 2_000,
          agent: "build",
          purpose: "Generate the assistant response for the user message.",
          summary: "hi",
          payload: {},
          system: { id: "sys_2", timestamp: 1_999, payload: { output: system } }
        }
      ]
    };

    expect(buildViewerHiddenContexts(message)).toEqual([
      {
        title: "System Transform Output",
        step: "build",
        preview: "You are opencode. Keep responses short.",
        text: "You are opencode.\n\nKeep responses short.",
        count: 2
      }
    ]);
  });

  test("viewer history skips bulky messages transform payloads by default", async () => {
    const dir = await mkdtemp(join(tmpdir(), "opencode-insights-viewer-"));
    const dbPath = join(dir, "insights.sqlite");
    try {
      const systemPayload = JSON.stringify({ input: { sessionID: "ses_1", model: { id: "gpt-test", providerID: "openai" } }, output: { system: ["system prompt"] } });
      const paramsPayload = JSON.stringify({
        input: { sessionID: "ses_1", agent: "build", message: { id: "msg_user" }, provider: { id: "openai" }, model: { id: "gpt-test" } },
        output: { maxOutputTokens: 4096 }
      });
      const messagePayload = JSON.stringify({
        input: { sessionID: "ses_1" },
        output: {
          message: { id: "msg_user", role: "user", sessionID: "ses_1", time: { created: 1_000 } },
          parts: [{ type: "text", messageID: "msg_user", sessionID: "ses_1", text: "hi" }]
        }
      });
      const bulkyTransformPayload = JSON.stringify({
        input: { sessionID: "ses_1" },
        output: { messages: [{ info: { id: "msg_user", role: "user" }, parts: [{ text: "x".repeat(100_000) }] }] }
      });

      await execFileAsync("sqlite3", [
        dbPath,
        `create table captures (
          id text primary key,
          kind text not null,
          timestamp integer not null,
          session_id text,
          message_id text,
          provider_id text,
          model_id text,
          event_type text,
          payload_json text not null
        );
        insert into captures values ('msg', 'chat.message', 1000, 'ses_1', null, null, null, null, '${messagePayload.replace(/'/g, "''")}');
        insert into captures values ('sys', 'experimental.chat.system.transform', 1010, 'ses_1', null, 'openai', 'gpt-test', null, '${systemPayload.replace(/'/g, "''")}');
        insert into captures values ('params', 'chat.params', 1011, 'ses_1', null, 'openai', 'gpt-test', null, '${paramsPayload.replace(/'/g, "''")}');
        insert into captures values ('transform', 'experimental.chat.messages.transform', 1012, 'ses_1', 'msg_user', null, null, null, '${bulkyTransformPayload.replace(/'/g, "''")}');`
      ]);

      const history = await readHistory({ dbPath, limit: 100 });
      const message = history.sessions[0]?.messages.find((item) => item.id === "msg_user") as HistoryMessage & {
        hiddenContexts?: ReturnType<typeof buildViewerHiddenContexts>;
      };

      expect(message?.hiddenContexts?.map((item) => item.title)).toEqual(["System Transform Output"]);
      expect(message?.hiddenContexts?.[0]?.text).toBe("system prompt");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
