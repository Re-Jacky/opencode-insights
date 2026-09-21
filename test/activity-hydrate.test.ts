import { describe, expect, test } from "vitest";
import { createActivityState } from "../src/activity.js";
import { hydrateActivity, type ActivityData } from "../src/activity-hydrate.js";

describe("hydrateActivity", () => {
  test("records child sessions, tool calls, and compactions from message content", async () => {
    const state = createActivityState();
    const data: ActivityData = {
      session: {
        list: () => [
          { id: "ses_root", title: "Root" },
          { id: "ses_child", parentID: "ses_root", title: "Child" }
        ],
        message: {
          sync: async () => {},
          list: (sessionID) =>
            sessionID === "ses_child"
              ? [
                  {
                    type: "assistant",
                    content: [
                      { type: "tool", id: "t1", name: "read", state: { status: "completed", input: {} } },
                      { type: "compaction", id: "c1", reason: "auto", status: "completed" }
                    ]
                  }
                ]
              : []
        }
      }
    };

    await hydrateActivity(data, state, "ses_root");

    expect(state.childrenByParent["ses_root"]).toEqual(["ses_child"]);
    expect(state.bySessionID["ses_child"]?.toolCalls).toBe(1);
    expect(state.bySessionID["ses_child"]?.autoCompacts).toBe(1);
    expect(state.hydrated.has("ses_child")).toBe(true);
  });

  test("leaves the session unhydrated when message sync fails so it can retry", async () => {
    const state = createActivityState();
    const data: ActivityData = {
      session: {
        list: () => [{ id: "ses_root" }],
        message: {
          sync: async () => {
            throw new Error("transient");
          },
          list: () => []
        }
      }
    };

    await hydrateActivity(data, state, "ses_root");

    expect(state.hydrated.has("ses_root")).toBe(false);
    expect(state.loading.has("ses_root")).toBe(false);
  });

  test("returns early for a non-session id", async () => {
    const state = createActivityState();
    let listed = false;
    const data: ActivityData = {
      session: {
        list: () => {
          listed = true;
          return [];
        },
        message: { sync: async () => {}, list: () => [] }
      }
    };

    await hydrateActivity(data, state, "not-a-session");

    expect(listed).toBe(false);
  });
});
