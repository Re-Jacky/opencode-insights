import { describe, expect, test } from "vitest";
import { buildRequestHistory, formatCaptureSummary, parseJsonlRecords, readCaptureRecord } from "../src/inspect.js";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

describe("capture inspection", () => {
  test("parses jsonl capture records", () => {
    const records = parseJsonlRecords('{"kind":"chat.params","timestamp":10,"payload":{"x":1}}\n\n{"kind":"event","timestamp":20,"payload":{"y":2}}\n');

    expect(records).toHaveLength(2);
    expect(records[0]?.kind).toBe("chat.params");
    expect(records[1]?.payload).toEqual({ y: 2 });
  });

  test("formats a readable recent request summary", () => {
    expect(
      formatCaptureSummary([
        {
          id: "a",
          kind: "chat.params",
          timestamp: 1_700_000_000_000,
          sessionID: "ses_1",
          providerID: "openai",
          modelID: "gpt-5",
          payload: { input: { message: { content: "hello" } } }
        }
      ])
    ).toContain("chat.params");
    expect(
      formatCaptureSummary([
        {
          id: "a",
          kind: "chat.params",
          timestamp: 1_700_000_000_000,
          sessionID: "ses_1",
          providerID: "openai",
          modelID: "gpt-5",
          payload: { input: { message: { content: "hello" } } }
        }
      ])
    ).toContain("ses_1");
  });

  test("builds readable sessions, messages, and requests from captures", () => {
    const history = buildRequestHistory([
      {
        id: "evt_session",
        kind: "event",
        timestamp: 1_000,
        sessionID: "ses_1",
        payload: {
          event: {
            type: "session.updated",
            properties: {
              sessionID: "ses_1",
              info: { id: "ses_1", title: "Demo session", time: { updated: 1_000 } }
            }
          }
        }
      },
      {
        id: "evt_message",
        kind: "event",
        timestamp: 1_100,
        sessionID: "ses_1",
        messageID: "msg_1",
        payload: {
          event: {
            type: "message.updated",
            properties: {
              sessionID: "ses_1",
              info: { id: "msg_1", sessionID: "ses_1", role: "user", time: { created: 1_100 } }
            }
          }
        }
      },
      {
        id: "evt_part",
        kind: "event",
        timestamp: 1_200,
        sessionID: "ses_1",
        messageID: "msg_1",
        payload: {
          event: {
            type: "message.part.updated",
            properties: {
              sessionID: "ses_1",
              part: { type: "text", sessionID: "ses_1", messageID: "msg_1", text: "hello model" }
            }
          }
        }
      },
      {
        id: "req_1",
        kind: "chat.params",
        timestamp: 1_300,
        sessionID: "ses_1",
        providerID: "openai",
        modelID: "gpt-5",
        payload: { input: { message: { content: "hello model" } }, output: { temperature: 0 } }
      }
    ]);

    expect(history.sessions).toHaveLength(1);
    expect(history.sessions[0]).toMatchObject({
      id: "ses_1",
      title: "Demo session",
      messages: [{ id: "msg_1", role: "user", text: "hello model" }],
      requests: [{ id: "req_1", providerID: "openai", modelID: "gpt-5", summary: "hello model" }]
    });
    expect(history.requests[0]?.id).toBe("req_1");
  });

  test("groups request params, headers, and assistant response under the user message", () => {
    const history = buildRequestHistory([
      {
        id: "user_message",
        kind: "chat.message",
        timestamp: 1_000,
        sessionID: "ses_1",
        providerID: "openai",
        modelID: "gpt-5",
        payload: {
          input: { sessionID: "ses_1", agent: "build", model: { providerID: "openai", modelID: "gpt-5" } },
          output: {
            message: { id: "msg_user", role: "user", sessionID: "ses_1", time: { created: 1_000 } },
            parts: [{ type: "text", messageID: "msg_user", sessionID: "ses_1", text: "hello model" }]
          }
        }
      },
      {
        id: "assistant_message",
        kind: "event",
        timestamp: 1_010,
        sessionID: "ses_1",
        payload: {
          event: {
            type: "message.updated",
            properties: {
              sessionID: "ses_1",
              info: {
                id: "msg_assistant",
                role: "assistant",
                parentID: "msg_user",
                sessionID: "ses_1",
                time: { created: 1_010, completed: 1_500 },
                tokens: { input: 10, output: 5, reasoning: 1 },
                cost: 0.001,
                finish: "stop"
              }
            }
          }
        }
      },
      {
        id: "req_1",
        kind: "chat.params",
        timestamp: 1_020,
        sessionID: "ses_1",
        messageID: "msg_user",
        providerID: "openai",
        modelID: "gpt-5",
        payload: {
          input: { sessionID: "ses_1", agent: "build", message: { id: "msg_user", role: "user", content: "hello model" } },
          output: { maxOutputTokens: 4096, options: {} }
        }
      },
      {
        id: "hdr_1",
        kind: "chat.headers",
        timestamp: 1_021,
        sessionID: "ses_1",
        messageID: "msg_user",
        providerID: "openai",
        modelID: "gpt-5",
        payload: {
          input: { sessionID: "ses_1", agent: "build", message: { id: "msg_user", role: "user" } },
          output: { headers: { authorization: "Bearer keep-me" } }
        }
      },
      {
        id: "assistant_text",
        kind: "event",
        timestamp: 1_400,
        sessionID: "ses_1",
        messageID: "msg_assistant",
        payload: {
          event: {
            type: "message.part.updated",
            properties: {
              sessionID: "ses_1",
              part: { type: "text", sessionID: "ses_1", messageID: "msg_assistant", text: "assistant says hi" }
            }
          }
        }
      }
    ]);

    const message = history.sessions[0]?.messages[0];
    const request = message?.requests[0];

    expect(message).toMatchObject({
      id: "msg_user",
      role: "user",
      text: "hello model",
      response: {
        id: "msg_assistant",
        text: "assistant says hi",
        tokens: { input: 10, output: 5, reasoning: 1 },
        cost: 0.001,
        finish: "stop"
      }
    });
    expect(request).toMatchObject({
      id: "req_1",
      agent: "build",
      headers: { id: "hdr_1", payload: { output: { headers: { authorization: "Bearer keep-me" } } } },
      response: { id: "msg_assistant", text: "assistant says hi" }
    });
    expect(history.requests).toHaveLength(1);
  });

  test("groups transform hooks under the latest user turn", () => {
    const history = buildRequestHistory([
      {
        id: "first_user",
        kind: "chat.message",
        timestamp: 1_000,
        sessionID: "ses_1",
        payload: {
          input: { sessionID: "ses_1" },
          output: {
            message: { id: "msg_user_1", role: "user", sessionID: "ses_1", time: { created: 1_000 } },
            parts: [{ type: "text", messageID: "msg_user_1", sessionID: "ses_1", text: "Hi" }]
          }
        }
      },
      {
        id: "second_user",
        kind: "chat.message",
        timestamp: 2_000,
        sessionID: "ses_1",
        payload: {
          input: { sessionID: "ses_1" },
          output: {
            message: { id: "msg_user_2", role: "user", sessionID: "ses_1", time: { created: 2_000 } },
            parts: [{ type: "text", messageID: "msg_user_2", sessionID: "ses_1", text: "what's your name?" }]
          }
        }
      },
      {
        id: "second_transform",
        kind: "experimental.chat.messages.transform",
        timestamp: 2_100,
        sessionID: "ses_1",
        messageID: "msg_user_2",
        payload: {
          input: { sessionID: "ses_1" },
          output: {
            messages: [
              { info: { id: "msg_user_1", role: "user", sessionID: "ses_1" }, parts: [] },
              { info: { id: "msg_assistant_1", role: "assistant", sessionID: "ses_1" }, parts: [] },
              { info: { id: "msg_user_2", role: "user", sessionID: "ses_1" }, parts: [] }
            ]
          }
        }
      },
      {
        id: "second_system",
        kind: "experimental.chat.system.transform",
        timestamp: 2_110,
        sessionID: "ses_1",
        payload: {
          input: { sessionID: "ses_1", model: { id: "gpt-test", providerID: "openai" } },
          output: { system: ["system"] }
        }
      }
    ]);

    const first = history.sessions[0]?.messages.find((message) => message.id === "msg_user_1");
    const second = history.sessions[0]?.messages.find((message) => message.id === "msg_user_2");

    expect(first?.requests.map((request) => request.id)).toEqual([]);
    expect(second?.requests.map((request) => request.id)).toEqual(["second_transform", "second_system"]);
  });

  test("attaches system transform context to the following model request", () => {
    const history = buildRequestHistory([
      {
        id: "user",
        kind: "chat.message",
        timestamp: 1_000,
        sessionID: "ses_1",
        payload: {
          input: { sessionID: "ses_1" },
          output: {
            message: { id: "msg_user_1", role: "user", sessionID: "ses_1", time: { created: 1_000 } },
            parts: [{ type: "text", messageID: "msg_user_1", sessionID: "ses_1", text: "hi" }]
          }
        }
      },
      {
        id: "system_for_build",
        kind: "experimental.chat.system.transform",
        timestamp: 1_100,
        sessionID: "ses_1",
        providerID: "openai",
        modelID: "gpt-test",
        payload: {
          input: { sessionID: "ses_1", model: { id: "gpt-test", providerID: "openai" } },
          output: { system: ["system prompt"] }
        }
      },
      {
        id: "params_build",
        kind: "chat.params",
        timestamp: 1_101,
        sessionID: "ses_1",
        messageID: "msg_user_1",
        providerID: "openai",
        modelID: "gpt-test",
        payload: {
          input: {
            sessionID: "ses_1",
            agent: "build",
            message: { id: "msg_user_1" },
            provider: { id: "openai" },
            model: { id: "gpt-test" }
          },
          output: { temperature: 0 }
        }
      }
    ]);

    const message = history.sessions[0]?.messages.find((item) => item.id === "msg_user_1");
    expect(history.requests.map((request) => request.id)).toEqual(["params_build"]);
    expect(message?.requests.map((request) => request.id)).toEqual(["params_build"]);
    expect(message?.requests[0]?.system?.id).toBe("system_for_build");
  });

  test("keeps separate assistant responses for multi-step build requests", () => {
    const history = buildRequestHistory([
      {
        id: "user",
        kind: "chat.message",
        timestamp: 1_000,
        sessionID: "ses_1",
        payload: {
          input: { sessionID: "ses_1" },
          output: {
            message: { id: "msg_user", role: "user", sessionID: "ses_1", time: { created: 1_000 } },
            parts: [{ type: "text", messageID: "msg_user", sessionID: "ses_1", text: "dispatch a subagent" }]
          }
        }
      },
      {
        id: "assistant_first",
        kind: "event",
        timestamp: 1_010,
        sessionID: "ses_1",
        payload: {
          event: {
            type: "message.updated",
            properties: {
              sessionID: "ses_1",
              info: { id: "msg_assistant_1", role: "assistant", parentID: "msg_user", sessionID: "ses_1", time: { created: 1_010 } }
            }
          }
        }
      },
      {
        id: "req_first",
        kind: "chat.params",
        timestamp: 1_020,
        sessionID: "ses_1",
        messageID: "msg_user",
        providerID: "openai",
        modelID: "gpt-test",
        payload: {
          input: { sessionID: "ses_1", agent: "build", message: { id: "msg_user" } },
          output: { maxOutputTokens: 4096 }
        }
      },
      {
        id: "assistant_first_text",
        kind: "event",
        timestamp: 1_030,
        sessionID: "ses_1",
        messageID: "msg_assistant_1",
        payload: {
          event: {
            type: "message.part.updated",
            properties: {
              sessionID: "ses_1",
              part: { type: "text", sessionID: "ses_1", messageID: "msg_assistant_1", text: "first model step" }
            }
          }
        }
      },
      {
        id: "assistant_second",
        kind: "event",
        timestamp: 1_040,
        sessionID: "ses_1",
        payload: {
          event: {
            type: "message.updated",
            properties: {
              sessionID: "ses_1",
              info: { id: "msg_assistant_2", role: "assistant", parentID: "msg_user", sessionID: "ses_1", time: { created: 1_040 } }
            }
          }
        }
      },
      {
        id: "req_second",
        kind: "chat.params",
        timestamp: 1_050,
        sessionID: "ses_1",
        messageID: "msg_user",
        providerID: "openai",
        modelID: "gpt-test",
        payload: {
          input: { sessionID: "ses_1", agent: "build", message: { id: "msg_user" } },
          output: { maxOutputTokens: 4096 }
        }
      },
      {
        id: "assistant_second_text",
        kind: "event",
        timestamp: 1_060,
        sessionID: "ses_1",
        messageID: "msg_assistant_2",
        payload: {
          event: {
            type: "message.part.updated",
            properties: {
              sessionID: "ses_1",
              part: { type: "text", sessionID: "ses_1", messageID: "msg_assistant_2", text: "second model step" }
            }
          }
        }
      }
    ]);

    const requests = history.sessions[0]?.messages.find((item) => item.id === "msg_user")?.requests;

    expect(requests?.map((request) => ({ id: request.id, response: request.response?.id }))).toEqual([
      { id: "req_first", response: "msg_assistant_1" },
      { id: "req_second", response: "msg_assistant_2" }
    ]);
  });

  test("derives session parent and project metadata for viewer grouping", () => {
    const history = buildRequestHistory([
      {
        id: "parent_session",
        kind: "event",
        timestamp: 1_000,
        sessionID: "ses_parent",
        payload: {
          event: {
            type: "session.updated",
            properties: {
              sessionID: "ses_parent",
              info: { id: "ses_parent", title: "Parent", time: { updated: 1_000 } }
            }
          }
        }
      },
      {
        id: "child_session",
        kind: "event",
        timestamp: 1_100,
        sessionID: "ses_child",
        payload: {
          event: {
            type: "session.created",
            properties: {
              sessionID: "ses_child",
              info: { id: "ses_child", parentID: "ses_parent", title: "Child", time: { updated: 1_100 } }
            }
          }
        }
      },
      {
        id: "assistant_path",
        kind: "event",
        timestamp: 1_200,
        sessionID: "ses_child",
        payload: {
          event: {
            type: "message.updated",
            properties: {
              sessionID: "ses_child",
              info: {
                id: "msg_assistant",
                role: "assistant",
                sessionID: "ses_child",
                parentID: "msg_user",
                path: { cwd: "/Users/zyao/Desktop/opencode-insights", root: "/" },
                time: { created: 1_200 }
              }
            }
          }
        }
      }
    ]);

    const child = history.sessions.find((session) => session.id === "ses_child");
    expect(child).toMatchObject({
      parentID: "ses_parent",
      cwd: "/Users/zyao/Desktop/opencode-insights",
      root: "/",
      project: "opencode-insights"
    });
  });

  test("reads one SQLite capture through CLI fallback when native SQLite is unavailable", async () => {
    const dir = await mkdtemp(join(tmpdir(), "opencode-insights-inspect-"));
    const dbPath = join(dir, "insights.sqlite");
    try {
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
          payload_json text not null
        );
        insert into captures values (
          'capture_1',
          'chat.params',
          1234,
          'ses_1',
          'msg_1',
          'openai',
          'gpt-test',
          '{"input":{"agent":"build"},"output":{"temperature":0}}'
        );`
      ]);

      await expect(readCaptureRecord("capture_1", { dbPath })).resolves.toMatchObject({
        id: "capture_1",
        kind: "chat.params",
        sessionID: "ses_1",
        payload: { input: { agent: "build" }, output: { temperature: 0 } }
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
