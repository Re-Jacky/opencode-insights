import { describe, expect, test } from "vitest";
import { buildRequestHistory, formatCaptureSummary, parseJsonlRecords } from "../src/inspect.js";

describe("capture inspection", () => {
  test("parses jsonl capture records", () => {
    const records = parseJsonlRecords('{"kind":"prompt","timestamp":10,"payload":{"event":{}}}\n\n{"kind":"event","timestamp":20,"payload":{"event":{}}}\n');
    expect(records).toHaveLength(2);
    expect(records[0]?.kind).toBe("prompt");
    expect(records[1]?.payload).toEqual({ event: {} });
  });

  test("formats a readable recent request summary", () => {
    expect(formatCaptureSummary([{
      id: "a", kind: "model.request", timestamp: 1_700_000_000_000,
      sessionID: "ses_1", providerID: "openai", modelID: "gpt-5", payload: { event: {} }
    }])).toContain("model.request");
  });

  test("reconstructs v2 prompt context requests and tool activity in order", () => {
    const records = [
      { id: "session", kind: "event" as const, timestamp: 1_000, sessionID: "ses_1", payload: { event: {
        type: "session.updated", properties: { info: { id: "ses_1", title: "Demo", time: { updated: 1_000 } } }
      } } },
      { id: "prompt", kind: "prompt" as const, timestamp: 1_100, sessionID: "ses_1", messageID: "msg_user", payload: { event: {
        sessionID: "ses_1", messageID: "msg_user", text: "hello model", agent: "build"
      } } },
      { id: "context_1", kind: "context" as const, timestamp: 1_200, sessionID: "ses_1", messageID: "msg_user", payload: { event: {
        sessionID: "ses_1", messageID: "msg_user", system: ["system prompt"], messages: [{ role: "user", content: "hello model" }], options: { temperature: 0 }
      } } },
      { id: "context_2", kind: "context" as const, timestamp: 1_210, sessionID: "ses_1", messageID: "msg_user", payload: { event: {
        sessionID: "ses_1", messageID: "msg_user", tools: [{ name: "bash" }], messages: [{ role: "tool", content: "tool output" }]
      } } },
      { id: "request_1", kind: "model.request" as const, timestamp: 1_220, sessionID: "ses_1", messageID: "msg_user", providerID: "openai", modelID: "gpt-5", payload: { event: { headers: { authorization: "secret" } } } },
      { id: "assistant", kind: "event" as const, timestamp: 1_230, sessionID: "ses_1", payload: { event: {
        type: "message.updated", properties: { info: { id: "msg_assistant", sessionID: "ses_1", role: "assistant", parentID: "msg_user", time: { created: 1_230 } } }
      } } },
      { id: "tool", kind: "tool.execute.before" as const, timestamp: 1_240, sessionID: "ses_1", messageID: "msg_assistant", payload: { event: { tool: "bash", callID: "call_1" } } },
      { id: "assistant_text", kind: "event" as const, timestamp: 1_250, sessionID: "ses_1", messageID: "msg_assistant", payload: { event: {
        type: "message.part.updated", properties: { part: { type: "text", sessionID: "ses_1", messageID: "msg_assistant", text: "assistant says hi" } }
      } } },
      { id: "request_2", kind: "model.request" as const, timestamp: 1_260, sessionID: "ses_1", messageID: "msg_user", providerID: "openai", modelID: "gpt-5", payload: { event: { headers: { "x-request": "second" } } } }
    ];

    const history = buildRequestHistory(records);
    const message = history.sessions[0]?.messages[0];
    expect(message).toMatchObject({ id: "msg_user", role: "user", text: "hello model" });
    expect(message?.requests.map((request) => request.id)).toEqual(["context_1", "context_2", "request_1", "request_2"]);
    expect(message?.requests[0]).toMatchObject({ system: { payload: { event: records[2]?.payload.event } } });
    expect(message?.response).toMatchObject({ id: "msg_assistant", text: "assistant says hi" });
    expect(message?.response?.events).toEqual(expect.arrayContaining([
      { event: records[6]?.payload.event }
    ]));
    expect(history.requests.map((request) => request.id)).toEqual(["request_2", "request_1", "context_2", "context_1"]);
  });

  test("keeps early tool captures when the assistant response is created later", () => {
    const history = buildRequestHistory([
      { id: "prompt", kind: "prompt", timestamp: 1_000, sessionID: "ses_1", messageID: "msg_user", payload: { event: { text: "run it" } } },
      { id: "tool", kind: "tool.execute.before", timestamp: 1_010, sessionID: "ses_1", messageID: "msg_assistant", payload: { event: { tool: "bash", callID: "call_1" } } },
      { id: "assistant", kind: "event", timestamp: 1_020, sessionID: "ses_1", payload: { event: { type: "message.updated", properties: { info: { id: "msg_assistant", sessionID: "ses_1", role: "assistant", parentID: "msg_user", time: { created: 1_020, completed: 1_100 }, tokens: { input: 4 }, cost: 0.1, finish: "tool-calls" } } } } },
      { id: "text", kind: "event", timestamp: 1_030, sessionID: "ses_1", payload: { event: { type: "message.part.updated", properties: { part: { type: "text", sessionID: "ses_1", messageID: "msg_assistant", text: "done" } } } } }
    ]);

    expect(history.sessions[0]?.messages[0]?.response).toMatchObject({
      id: "msg_assistant", createdAt: 1_020, completedAt: 1_100, tokens: { input: 4 }, cost: 0.1, finish: "tool-calls",
      events: expect.arrayContaining([{ event: { tool: "bash", callID: "call_1" } }])
    });
  });

  test("retains v2 context categories and distinct model request metadata", () => {
    const history = buildRequestHistory([
      { id: "prompt", kind: "prompt", timestamp: 1_000, sessionID: "ses_1", messageID: "msg_user", payload: { event: { text: "hello" } } },
      { id: "context", kind: "context", timestamp: 1_010, sessionID: "ses_1", messageID: "msg_user", payload: { event: { system: ["system"], messages: [{ role: "user", content: "hello" }], options: { temperature: 0 } } } },
      { id: "request", kind: "model.request", timestamp: 1_020, sessionID: "ses_1", messageID: "msg_user", providerID: "openai", modelID: "gpt-5", payload: { event: { headers: { authorization: "secret" }, body: { stream: true } } } }
    ]);
    const request = history.sessions[0]?.messages[0]?.requests;

    expect(request?.[0]?.context).toMatchObject({ system: ["system"], messages: [{ role: "user", content: "hello" }], options: { temperature: 0 } });
    expect(request?.[1]?.modelRequest).toMatchObject({ headers: { authorization: "secret" }, body: { stream: true } });
    expect(request?.[1]?.payload.event).toMatchObject({ headers: { authorization: "secret" } });
  });

  test("reconstructs multiple assistant responses with timing and ownership order", () => {
    const history = buildRequestHistory([
      { id: "prompt", kind: "prompt", timestamp: 1_000, sessionID: "ses_1", messageID: "msg_user", payload: { event: { text: "multi" } } },
      { id: "request_1", kind: "model.request", timestamp: 1_010, sessionID: "ses_1", messageID: "msg_user", payload: { event: {} } },
      { id: "assistant_1", kind: "event", timestamp: 1_020, sessionID: "ses_1", payload: { event: { type: "message.updated", properties: { info: { id: "assistant_1", sessionID: "ses_1", role: "assistant", parentID: "msg_user", time: { created: 1_020, completed: 1_030 }, tokens: { output: 2 }, cost: 0.2, finish: "stop" } } } } },
      { id: "request_2", kind: "model.request", timestamp: 1_040, sessionID: "ses_1", messageID: "msg_user", payload: { event: {} } },
      { id: "assistant_2", kind: "event", timestamp: 1_050, sessionID: "ses_1", payload: { event: { type: "message.updated", properties: { info: { id: "assistant_2", sessionID: "ses_1", role: "assistant", parentID: "msg_user", time: { created: 1_050, completed: 1_060 }, finish: "stop" } } } } }
    ]);
    const requests = history.sessions[0]?.messages[0]?.requests;
    expect(requests?.map((item) => item.response?.id)).toEqual(["assistant_1", "assistant_2"]);
    expect(history.requests.map((item) => item.id)).toEqual(["request_2", "request_1"]);
  });
});
