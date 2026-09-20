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

  test("renders v2 system, messages, and options context without transform assumptions", () => {
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
          context: { system: ["You are opencode."], messages: [{ role: "user", content: "hi" }], options: { temperature: 0 } },
          system: { id: "sys_1", timestamp: 999, payload: { event: { system: ["You are opencode."] } } }
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
          context: { system: ["You are opencode."], messages: [{ role: "user", content: "hi" }], options: { temperature: 0 } },
          system: { id: "sys_2", timestamp: 1_999, payload: { event: { system: ["You are opencode."] } } }
        }
      ]
    };

    expect(buildViewerHiddenContexts(message)).toEqual(expect.arrayContaining([
      expect.objectContaining({ title: "System Context", text: "You are opencode.", count: 2 }),
      expect.objectContaining({ title: "Messages Context", text: "user\n\nhi", count: 2 }),
      expect.objectContaining({ title: "Context Options", text: expect.stringContaining('"temperature": 0'), count: 2 })
    ]));
  });

  test("viewer history reads v2 hidden context", async () => {
    const dir = await mkdtemp(join(tmpdir(), "opencode-insights-viewer-"));
    const dbPath = join(dir, "insights.sqlite");
    try {
      const promptPayload = JSON.stringify({ event: { sessionID: "ses_1", messageID: "msg_user", text: "hi" } });
      const contextPayload = JSON.stringify({ event: { system: ["system prompt"], messages: [{ role: "user", content: "hi" }], options: { temperature: 0 } } });
      const requestPayload = JSON.stringify({ event: { headers: { authorization: "secret" }, body: { stream: true } } });

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
         insert into captures values ('prompt', 'prompt', 1000, 'ses_1', 'msg_user', null, null, null, '${promptPayload.replace(/'/g, "''")}');
         insert into captures values ('context', 'context', 1010, 'ses_1', 'msg_user', null, null, null, '${contextPayload.replace(/'/g, "''")}');
         insert into captures values ('request', 'model.request', 1011, 'ses_1', 'msg_user', 'openai', 'gpt-test', null, '${requestPayload.replace(/'/g, "''")}');`
      ]);

      const history = await readHistory({ dbPath, limit: 100 });
      const message = history.sessions[0]?.messages.find((item) => item.id === "msg_user") as HistoryMessage & {
        hiddenContexts?: ReturnType<typeof buildViewerHiddenContexts>;
      };

       expect(message?.hiddenContexts?.map((item) => item.title)).toContain("System Context");
      expect(message?.hiddenContexts?.[0]?.text).toBe("system prompt");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("viewer history keeps older project metadata for recent sessions", async () => {
    const dir = await mkdtemp(join(tmpdir(), "opencode-insights-viewer-"));
    const dbPath = join(dir, "insights.sqlite");
    try {
      const sessionPayload = JSON.stringify({
        event: {
          type: "session.updated",
          properties: {
            sessionID: "ses_dot",
            info: {
              id: "ses_dot",
              title: "Dot project",
              path: { cwd: "/Users/zyao/.agentic-connectors", root: "/Users/zyao/.agentic-connectors" },
              time: { updated: 900 }
            }
          }
        }
      });
      const messagePayload = JSON.stringify({
        input: { sessionID: "ses_dot" },
        output: {
          message: { id: "msg_user", role: "user", sessionID: "ses_dot", time: { created: 1_000 } },
          parts: [{ type: "text", messageID: "msg_user", sessionID: "ses_dot", text: "hi" }]
        }
      });
      const deltaPayload = (id: number) =>
        JSON.stringify({
          event: {
            type: "message.part.delta",
            properties: { sessionID: "ses_dot", messageID: "msg_assistant", delta: String(id) }
          }
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
        insert into captures values ('session_path', 'event', 900, 'ses_dot', null, null, null, 'session.updated', '${sessionPayload.replace(/'/g, "''")}');
        insert into captures values ('msg', 'chat.message', 1000, 'ses_dot', null, null, null, null, '${messagePayload.replace(/'/g, "''")}');
        insert into captures values ('delta_1', 'event', 1100, 'ses_dot', 'msg_assistant', null, null, 'message.part.delta', '${deltaPayload(1).replace(/'/g, "''")}');
        insert into captures values ('delta_2', 'event', 1200, 'ses_dot', 'msg_assistant', null, null, 'message.part.delta', '${deltaPayload(2).replace(/'/g, "''")}');`
      ]);

      const history = await readHistory({ dbPath, limit: 1 });

      expect(history.sessions[0]).toMatchObject({
        cwd: "/Users/zyao/.agentic-connectors",
        root: "/Users/zyao/.agentic-connectors",
        project: ".agentic-connectors"
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
