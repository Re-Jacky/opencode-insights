import { describe, expect, test } from "vitest";
import { createActivityState } from "../src/activity.js";
import { createCopilotProviderTracker } from "../src/copilot-usage.js";
import {
  hydrateInsights,
  listAllMessages,
  needsHydration,
  type ActivityData,
  type HydrationState
} from "../src/activity-hydrate.js";
import { createGoProviderTracker } from "../src/go-usage.js";
import { createMetricsState } from "../src/metrics.js";
import { createSubagentState } from "../src/subagents.js";

function state(): HydrationState {
  const activity = createActivityState();
  return {
    activity,
    metrics: createMetricsState(),
    subagents: createSubagentState(activity),
    goProviders: createGoProviderTracker(),
    copilotProviders: createCopilotProviderTracker()
  };
}

describe("hydrateInsights", () => {
  test("hydrates activity, metrics, subagents, and providers from real V2 message shapes", async () => {
    const s = state();
    const data: ActivityData = {
      session: {
        list: () => [
          { id: "ses_root", title: "Root" },
          { id: "ses_child", parentID: "ses_root", title: "Child", model: { providerID: "github-copilot" } }
        ],
        message: {
          sync: async () => {},
          list: (sessionID) =>
            sessionID === "ses_child"
              ? [
                  {
                    type: "assistant",
                    id: "msg_1",
                    time: { created: 1_000, completed: 2_000 },
                    model: { providerID: "github-copilot" },
                    tokens: { input: 10, output: 20, reasoning: 5, cache: { read: 1, write: 2 } },
                    content: [{ type: "tool", id: "t1", name: "read", state: { status: "completed", input: {} } }]
                  },
                  { type: "compaction", id: "c1", reason: "auto", status: "completed" },
                  { type: "skill", id: "sk1", name: "brainstorming", skill: "brainstorming", text: "" }
                ]
              : []
        }
      }
    };

    await hydrateInsights(data, s, "ses_root");

    expect(s.activity.childrenByParent["ses_root"]).toEqual(["ses_child"]);
    expect(s.activity.bySessionID["ses_child"]?.toolCalls).toBe(1);
    expect(s.activity.bySessionID["ses_child"]?.autoCompacts).toBe(1);
    expect(s.activity.bySessionID["ses_child"]?.skills).toEqual({ brainstorming: 1 });
    expect(s.metrics.responseUsageByMessageID["msg_1"]?.usage.outputTokens).toBe(20);
    expect(s.subagents.children["ses_child"]?.status).toBe("done");
    expect(s.copilotProviders.usesCopilot("ses_child")).toBe(true);
    expect(s.activity.hydrated.has("ses_child")).toBe(true);
  });

  test("uses the persisted streamed window for the hydrated average", async () => {
    const s = state();
    const data: ActivityData = {
      session: {
        list: () => [{ id: "ses_root" }],
        message: {
          sync: async () => {},
          list: () => [
            {
              type: "assistant",
              id: "msg_1",
              time: { created: 1_000, streamed: 5_000, completed: 5_200 },
              tokens: { input: 10, output: 40, reasoning: 10, cache: { read: 0, write: 0 } },
              content: []
            }
          ]
        }
      }
    };

    await hydrateInsights(data, s, "ses_root");

    // 50 tokens over the persisted 4s streamed window (1000 -> 5000), matching
    // the native message header rather than the shorter completed-created span.
    expect(s.metrics.messageMetricsByID["msg_1"]).toMatchObject({ totalTokens: 50, durationMs: 4_000 });
  });

  test("hydrates the whole session, not the host's newest-20 message window", async () => {
    const s = state();
    const all = Array.from({ length: 25 }, (_, index) => ({
      type: "assistant",
      id: `msg_${index}`,
      time: { created: 1_000 + index, completed: 1_100 + index },
      tokens: { input: 1, output: 10, reasoning: 1, cache: { read: 0, write: 0 } },
      content: []
    }));
    const data: ActivityData = {
      session: {
        list: () => [{ id: "ses_root" }],
        message: {
          // The host's message.sync() only loads the newest 20 messages.
          sync: async () => {},
          list: () => all.slice(-20),
          history: async () => all
        }
      }
    };

    await hydrateInsights(data, s, "ses_root");

    expect(s.metrics.sessionTokenUsageByID["ses_root"]?.responseCount).toBe(25);
    expect(s.metrics.sessionTokenUsageByID["ses_root"]?.outputTokens).toBe(250);
  });

  test("pages the full message history with cursors and dedupes ids", async () => {
    const pages = [
      { data: [{ id: "m1" }, { id: "m2" }], cursor: { next: "cursor_2" } },
      { data: [{ id: "m2" }, { id: "m3" }], cursor: { next: null } }
    ];
    const requests: Array<Record<string, unknown>> = [];
    const messages = await listAllMessages(async (input) => {
      requests.push(input);
      return pages[requests.length - 1]!;
    }, "ses_root", 2);

    expect(requests[0]).toEqual({ sessionID: "ses_root", limit: 2, order: "asc" });
    expect(requests[1]).toEqual({ sessionID: "ses_root", limit: 2, cursor: "cursor_2" });
    expect(messages.map((message) => message.id)).toEqual(["m1", "m2", "m3"]);
  });

  test("requests pages within the host's maximum page size", async () => {
    const requests: Array<Record<string, unknown>> = [];
    await listAllMessages(async (input) => {
      requests.push(input);
      return { data: [], cursor: { next: null } };
    }, "ses_root");

    // The host rejects limit > 200 with InvalidRequestError, which aborted
    // hydration entirely and left the Token Usage section empty.
    expect(requests[0]).toMatchObject({ limit: 200 });
  });

  test("does not create a subagent row for a session without a parent", async () => {
    const s = state();
    const data: ActivityData = {
      session: {
        list: () => [{ id: "ses_root", title: "Root" }],
        message: { sync: async () => {}, list: () => [] }
      }
    };

    await hydrateInsights(data, s, "ses_root");

    expect(Object.keys(s.subagents.children)).toHaveLength(0);
  });

  test("leaves the session unhydrated when message sync fails so it can retry", async () => {
    const s = state();
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

    await hydrateInsights(data, s, "ses_root");

    expect(s.activity.hydrated.has("ses_root")).toBe(false);
    expect(s.activity.loading.has("ses_root")).toBe(false);
  });

  test("returns early for a non-session id", async () => {
    const s = state();
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

    await hydrateInsights(data, s, "not-a-session");

    expect(listed).toBe(false);
  });

  test("needsHydration is true only for sessions that are neither hydrated nor loading", () => {
    const s = state();
    expect(needsHydration(s.activity, "ses_root")).toBe(true);
    s.activity.loading.add("ses_root");
    expect(needsHydration(s.activity, "ses_root")).toBe(false);
    s.activity.loading.delete("ses_root");
    s.activity.hydrated.add("ses_root");
    expect(needsHydration(s.activity, "ses_root")).toBe(false);
  });

  test("retries a previously failed session on the next call", async () => {
    const s = state();
    let failing = true;
    const data: ActivityData = {
      session: {
        list: () => [{ id: "ses_root" }],
        message: {
          sync: async () => {
            if (failing) throw new Error("transient");
          },
          list: () => [
            {
              type: "assistant",
              id: "msg_1",
              time: { created: 1, completed: 2 },
              tokens: { input: 1, output: 2, reasoning: 0, cache: { read: 0, write: 0 } },
              content: []
            }
          ]
        }
      }
    };

    await hydrateInsights(data, s, "ses_root");
    expect(s.activity.hydrated.has("ses_root")).toBe(false);
    expect(needsHydration(s.activity, "ses_root")).toBe(true);

    failing = false;
    await hydrateInsights(data, s, "ses_root");
    expect(s.activity.hydrated.has("ses_root")).toBe(true);
    expect(needsHydration(s.activity, "ses_root")).toBe(false);
    expect(s.metrics.responseUsageByMessageID["msg_1"]).toBeDefined();
  });
});
