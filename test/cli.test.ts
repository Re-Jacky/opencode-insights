import { describe, expect, test } from "vitest";
import { formatSessionSummary, parseOptions, summarizeSessions } from "../src/cli.js";
import type { HistorySession } from "../src/inspect.js";

describe("cli helpers", () => {
  test("parses common command options", () => {
    expect(parseOptions(["--db", "/tmp/insights.sqlite", "--limit", "100", "--json", "--port", "9999", "-o", "/tmp/out.json"])).toEqual({
      dbPath: "/tmp/insights.sqlite",
      limit: 100,
      limitProvided: true,
      json: true,
      port: 9999,
      output: "/tmp/out.json"
    });
  });

  test("falls back to safe defaults for invalid numeric options", () => {
    expect(parseOptions(["--limit", "nope", "--port", "0"])).toMatchObject({
      limit: 20,
      limitProvided: true,
      json: false,
      port: 8765
    });
  });

  test("summarizes reconstructed sessions for terminal output", () => {
    const rows = summarizeSessions([
      {
        id: "ses_1",
        title: "Greeting",
        updatedAt: 1_700_000_000_000,
        messages: [
          {
            id: "msg_1",
            sessionID: "ses_1",
            role: "user",
            text: "Hi",
            requests: [],
            response: {
              id: "msg_2",
              sessionID: "ses_1",
              role: "assistant",
              text: "Hello",
              reasoning: "",
              events: []
            }
          }
        ],
        requests: [
          {
            id: "req_1",
            sessionID: "ses_1",
            messageID: "msg_1",
            timestamp: 1_700_000_000_100,
            purpose: "Generate the assistant response for the user message.",
            summary: "Hi",
            payload: {}
          }
        ]
      } satisfies HistorySession
    ]);

    expect(rows).toEqual([
      {
        id: "ses_1",
        title: "Greeting",
        updatedAt: 1_700_000_000_000,
        messages: 1,
        hooks: 1,
        responses: 1
      }
    ]);
    expect(formatSessionSummary(rows)).toContain("Greeting");
    expect(formatSessionSummary(rows)).toContain("ses_1");
  });
});
