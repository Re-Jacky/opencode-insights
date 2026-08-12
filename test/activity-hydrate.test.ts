import { describe, expect, test } from "vitest";
import { createActivityState } from "../src/activity.js";
import { hydrateActivity, type ActivityClient } from "../src/activity-hydrate.js";

function makeClient(overrides: Partial<ActivityClient["session"]> = {}): ActivityClient {
  return {
    session: {
      list: async () => ({ data: [] }),
      messages: async () => ({ data: [] }),
      ...overrides
    }
  };
}

describe("hydrateActivity", () => {
  test("seeds childrenByParent and titles from session.list", async () => {
    const state = createActivityState();
    const client = makeClient({
      list: async () => ({
        data: [
          { id: "ses_root", title: "Main" },
          { id: "ses_a", parentID: "ses_root", title: "T3" },
          { id: "ses_b", parentID: "ses_a", title: "child" }
        ]
      })
    });
    await hydrateActivity(client, state, "ses_root");
    expect(state.childrenByParent["ses_root"]).toEqual(["ses_a"]);
    expect(state.childrenByParent["ses_a"]).toEqual(["ses_b"]);
    expect(state.titles["ses_a"]).toBe("T3");
  });

  test("backfills tool, compaction, and step counts per session", async () => {
    const state = createActivityState();
    const client = makeClient({
      list: async () => ({ data: [{ id: "ses_root", title: "Main" }, { id: "ses_a", parentID: "ses_root", title: "T3" }] }),
      messages: async ({ sessionID }) => ({
        data:
          sessionID === "ses_a"
            ? [
                { parts: [
                    { id: "prt_t1", type: "tool", tool: "bash", state: { status: "completed", input: {} } },
                    { id: "prt_c1", type: "compaction", auto: true },
                    { id: "prt_s1", type: "step-finish", reason: "stop" }
                  ] }
              ]
            : []
      })
    });
    await hydrateActivity(client, state, "ses_root");
    expect(state.bySessionID["ses_a"]?.toolCalls).toBe(1);
    expect(state.bySessionID["ses_a"]?.toolBreakdown).toEqual({ bash: 1 });
    expect(state.bySessionID["ses_a"]?.autoCompacts).toBe(1);
    expect(state.bySessionID["ses_a"]?.steps).toBe(1);
    expect(state.hydrated.has("ses_a")).toBe(true);
  });

  test("does not double count parts seen live before backfill", async () => {
    const state = createActivityState();
    // part seen live (identical id)
    state.bySessionID["ses_a"] = { toolCalls: 1, toolBreakdown: { bash: 1 }, errors: 0, skills: {}, autoCompacts: 0, steps: 0 };
    state.seenKeys["ses_a"] = new Set(["tool:prt_t1"]);
    const client = makeClient({
      list: async () => ({ data: [{ id: "ses_root", title: "Main" }, { id: "ses_a", parentID: "ses_root", title: "T3" }] }),
      messages: async () => ({
        data: [{ parts: [{ id: "prt_t1", type: "tool", tool: "bash", state: { status: "completed", input: {} } }] }]
      })
    });
    await hydrateActivity(client, state, "ses_root");
    expect(state.bySessionID["ses_a"]?.toolCalls).toBe(1);
  });

  test("skips already hydrated sessions", async () => {
    const state = createActivityState();
    state.hydrated.add("ses_root");
    let messagesCalled = 0;
    const client = makeClient({
      list: async () => ({ data: [{ id: "ses_root", title: "Main" }] }),
      messages: async () => {
        messagesCalled += 1;
        return { data: [] };
      }
    });
    await hydrateActivity(client, state, "ses_root");
    expect(messagesCalled).toBe(0);
  });

  test("marks loading during the fetch and clears it after", async () => {
    const state = createActivityState();
    const client = makeClient({
      list: async () => ({ data: [{ id: "ses_root", title: "Main" }] }),
      messages: async () => {
        expect(state.loading.has("ses_root")).toBe(true);
        return { data: [] };
      }
    });
    await hydrateActivity(client, state, "ses_root");
    expect(state.loading.size).toBe(0);
    expect(state.hydrated.has("ses_root")).toBe(true);
  });

  test("does not mark hydrated when messages fails; retries next call", async () => {
    const state = createActivityState();
    const client = makeClient({
      list: async () => ({ data: [{ id: "ses_root", title: "Main" }] }),
      messages: async () => {
        throw new Error("boom");
      }
    });
    await hydrateActivity(client, state, "ses_root");
    expect(state.hydrated.has("ses_root")).toBe(false);
    expect(state.loading.size).toBe(0);
  });

  test("ignores non-session root ids", async () => {
    const state = createActivityState();
    let listCalled = 0;
    const client = makeClient({
      list: async () => {
        listCalled += 1;
        return { data: [] };
      }
    });
    await hydrateActivity(client, state, "not-a-session");
    expect(listCalled).toBe(0);
  });
});
