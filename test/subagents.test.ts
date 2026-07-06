import { describe, expect, test } from "vitest";
import {
  applySubagentEvent,
  createSubagentState,
  renderSubagentStatus
} from "../src/subagents.js";

describe("subagent status", () => {
  test("tracks running, completed, and failed subagents", () => {
    const state = createSubagentState();

    applySubagentEvent(state, {
      type: "session.updated",
      properties: {
        info: {
          id: "ses_child_1",
          parentID: "ses_parent",
          title: "Review tests",
          time: { created: 1_000 }
        }
      }
    });
    applySubagentEvent(state, {
      type: "session.updated",
      properties: {
        info: {
          id: "ses_child_1",
          parentID: "ses_parent",
          title: "Review tests",
          time: { created: 1_000, completed: 4_000 },
          tokens: { input: 100, output: 25 }
        }
      }
    });
    applySubagentEvent(state, {
      type: "session.updated",
      properties: {
        info: {
          id: "ses_child_2",
          parentID: "ses_parent",
          title: "Run build",
          time: { created: 2_000 },
          error: "failed"
        }
      }
    });

    expect(renderSubagentStatus(state, { now: 5_000 })).toBe(
      "↳ 0 running · 1 done · 1 error · Σ 2 total · Run build 00:03 · Review tests 00:03 ctx 125 tokens"
    );
  });
});
