import { describe, expect, test } from "vitest";
import { formatCaptureSummary, parseJsonlRecords } from "../src/inspect.js";

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
});
