import { describe, expect, test } from "vitest";
import { createActivityState } from "../src/activity.js";
import { createCopilotProviderTracker } from "../src/copilot-usage.js";
import { hydrateInsights, needsHydration, type ActivityData, type HydrationState } from "../src/activity-hydrate.js";
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
