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

  test("resolves v2 terminal tool summaries from the assistant tool part", () => {
    const message: HistoryMessage = {
      id: "msg_user", sessionID: "ses_1", role: "user", text: "run it", requests: [{
        id: "req_1", sessionID: "ses_1", messageID: "msg_user", timestamp: 1_000,
        purpose: "Dispatch a provider model request for this message.", summary: "run it", payload: {},
        response: {
          id: "msg_assistant", sessionID: "ses_1", role: "assistant", text: "", reasoning: "", events: [
            { event: { type: "session.tool.success", data: { sessionID: "ses_1", assistantMessageID: "msg_assistant", id: "tool_1", content: [{ type: "text", text: "ok" }] } } },
            { event: { type: "session.message.content.updated", data: { sessionID: "ses_1", messageID: "msg_assistant", content: [{ type: "tool", id: "tool_1", name: "bash", state: { status: "completed", input: {} } }] } } }
          ]
        }
      }]
    };
    expect(buildViewerVisibleSteps(message)).toContainEqual({ label: "agent tool", text: "bash · completed" });
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

  test("renders v2 request detail fields without legacy hook labels", () => {
    const html = renderViewerHtml("/tmp/insights.sqlite");
    expect(html).toContain("payload.event");
    expect(html).toContain("request.context");
    expect(html).toContain("request.modelRequest");
    expect(html).toContain("V2 Context");
    expect(html).not.toContain("Hook Input");
    expect(html).not.toContain("System Transform");
    expect(html).not.toContain("Headers Hook");
  });

  test("labels v2 prompt, context, and model request lifecycle stages", async () => {
    const dir = await mkdtemp(join(tmpdir(), "opencode-insights-viewer-"));
    const dbPath = join(dir, "insights.sqlite");
    try {
      const prompt = JSON.stringify({ event: { sessionID: "ses_v2", messageID: "msg_v2", text: "hello" } });
      const context = JSON.stringify({ event: { sessionID: "ses_v2", messageID: "msg_v2", system: ["system"] } });
      const request = JSON.stringify({ event: { sessionID: "ses_v2", messageID: "msg_v2", model: { providerID: "openai", id: "gpt-5" } } });
      await execFileAsync("sqlite3", [dbPath, `create table captures (id text primary key, kind text not null, timestamp integer not null, session_id text, message_id text, provider_id text, model_id text, event_type text, payload_json text not null);
        insert into captures values ('p', 'prompt', 1000, 'ses_v2', 'msg_v2', null, null, null, '${prompt.replace(/'/g, "''")}');
        insert into captures values ('c', 'context', 1010, 'ses_v2', 'msg_v2', null, null, null, '${context.replace(/'/g, "''")}');
        insert into captures values ('m', 'model.request', 1020, 'ses_v2', 'msg_v2', 'openai', 'gpt-5', null, '${request.replace(/'/g, "''")}');`]);
      const history = await readHistory({ dbPath, limit: 100 });
      expect(history.requests.map((item) => item.purpose)).toEqual([
        "Dispatch a provider model request for this message.",
        "Prepare model context for this message."
      ]);
      expect(history.requests.map((item) => item.providerID)).toEqual(["openai", undefined]);
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
          id: "evt_session",
          created: 900,
          data: {
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
      const deltaPayload = (id: number) =>
        JSON.stringify({
          event: {
            type: "message.part.delta",
            id: `evt_delta_${id}`,
            created: 1_000 + id,
            data: { sessionID: "ses_dot", messageID: "msg_assistant", delta: String(id) }
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
        insert into captures values ('msg', 'event', 1000, 'ses_dot', 'msg_user', null, null, 'message.updated', '${JSON.stringify({ event: { type: "message.updated", id: "evt_message", created: 1000, data: { info: { id: "msg_user", sessionID: "ses_dot", role: "user", time: { created: 1000 } } } } }).replace(/'/g, "''")}');
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
