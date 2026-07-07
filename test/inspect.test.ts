import { describe, expect, test } from "vitest";
import { buildRequestHistory, formatCaptureSummary, parseJsonlRecords } from "../src/inspect.js";

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
        messageID: "msg_user_1",
        payload: {
          input: {},
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
});
