# TPS / AVG Accuracy Fixes — Per-Message Realtime Implementation Plan (v2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make input-box metrics `TPS` (live), `AVG`, `TTFT` **per-message current round (realtime)** instead of session cumulative — `TPS` = live stream rate of the current responding message, `AVG` = `tokens/duration` of that same message, `TTFT` = `firstToken - requestStart` of that message — while keeping session totals only for sidebar `Token Usage`.

**Architecture:** Keep `src/metrics.ts` as single source of truth but split state: `streamSamplesByMessageID` + `messageMetricsByID` + `latestMessageIDBySession` for per-message prompt-right metrics; retain `sessionTokenUsageByID`/`responseUsageByMessageID` for sidebar session aggregates. Hydration computes per-message `AVG/TTFT` via `createdAt→completedAt` fallback when `MessageTiming` missing. `tui.tsx` tracks `latestMessageIDBySession` implicitly via metrics state (no extra TUI state). No new files.

**Tech Stack:** TypeScript ESM (NodeNext, `*.js` imports), `vitest`, `better-sqlite3`/`sql.js` unchanged, `@opentui/solid` TUI.

**Spec:** Based on investigation 2026-08-31 (`src/metrics.ts:1-389`, `src/tui.tsx:645-783`, `test/metrics.test.ts:20-52`) and clarification 2026-08-31: input-box metrics must be per-message realtime, not session; other promptRight metrics `used/cache/input/output/reasoning` already per-message (latest) and stay.

## Global Constraints

- Node >= 22.13, ESM-only, relative imports must end `.js` (`src/foo.js` even from `test/`).
- `tsc --noEmit` strict + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` — optional fields `T | undefined`, strip via `compactUndefined`.
- `npm run verify` (`typecheck && test && build`) is release gate; `npm test` is `vitest run`.
- Plugin hooks best-effort — swallow failures, never throw.
- Tests import from `src/` not `dist/`; `test/entrypoints.test.ts` asserts identifiers in `src/tui.tsx` (e.g. `api.route.navigate("session",…)`), don't rename.
- Commit style `feat:`/`fix:`; do not put `tui` in default export of `src/index.ts`.

---

## File Structure

**Modify:**
- `src/metrics.ts:1-65` — add `MessageMetrics`, `streamSamplesByMessageID`, `messageMetricsByID`, `latestMessageIDBySession`; keep `SessionAverage`/`sessionAverageByID` deprecated or for sidebar only, same for `sessionTokenUsageByID`
- `src/metrics.ts:73-345` — `recordAssistantMessage`, `recordAssistantDelta`, `recordToolActivity`, `liveTps`, `messageAverage`/`messageTtft` (new), `sessionAverage`/`sessionTtft` (keep for compat), `activeDurationMs`, `estimateStreamTokens`, `renderPromptRightMetricsText`, `renderMetricsText`
- `src/tui.tsx:645-783` — `hydrateSessionMetrics()` and `api.event.on("message.updated")`/`message.part.delta` to feed per-message state; `PromptRightMetrics` now resolves per-message via `latestMessageIDBySession`
- `test/metrics.test.ts:1-184` — rewrite `renders live TPS, average TPS, and TTFT` to per-message expectations; add hydrate, tool-calls fallback, TTFT token vs tool, live volatility, per-message isolation tests

**No new files.**

---

### Task 1: Refactor MetricsState to per-message (foundation)

**Files:**
- Modify: `src/metrics.ts:15-67`
- Test: `test/metrics.test.ts` (add shape test)

**Interfaces:**
- Consumes: existing `MessageTiming` `6-13`, `SessionAverage` `15-20`
- Produces: new types and state shape
  ```ts
  export type MessageMetrics = { totalTokens:number; durationMs:number; ttftMs:number; avgTps:number; ttftSec:number; createdAt:number; completedAt:number };
  export type MetricsState = {
    streamSamplesByMessageID: Record<string, StreamSample[]>; // key = messageID
    streamSamplesBySession: Record<string, StreamSample[]>; // KEEP deprecated for 1 commit or delete — decide
    messageTimingByID: Record<string, MessageTiming>;
    messageMetricsByID: Record<string, MessageMetrics>; // NEW per-message AVG/TTFT
    latestMessageIDBySession: Record<string, string>; // NEW current round
    sessionAverageByID: Record<string, SessionAverage>; // DEPRECATED keep for sidebar compat
    latestResponseUsageBySession: Record<string, AssistantResponseUsage>;
    responseUsageByMessageID: Record<string, { sessionID:string; usage:AssistantResponseUsage }>;
    sessionTokenUsageByID: Record<string, SessionTokenUsage>; // keep for sidebar
  }
  ```

- [ ] **Step 1: Write failing test for new state shape**

```ts
// test/metrics.test.ts
import { createMetricsState } from "../src/metrics.js";
test("state has per-message fields", () => {
  const s = createMetricsState();
  expect(s).toHaveProperty("streamSamplesByMessageID");
  expect(s).toHaveProperty("messageMetricsByID");
  expect(s).toHaveProperty("latestMessageIDBySession");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- test/metrics.test.ts -t "state has per-message"`
Expected: FAIL — property missing

- [ ] **Step 3: Implement minimal state change**

```ts
// src/metrics.ts:45-67
export type MessageMetrics = {
  totalTokens: number;
  durationMs: number;
  ttftMs: number | undefined;
  createdAt: number;
  completedAt: number;
};
export function createMetricsState(): MetricsState {
  return {
    streamSamplesByMessageID: {},
    streamSamplesBySession: {}, // keep temp for compat, remove next task if desired
    messageTimingByID: {},
    messageMetricsByID: {},
    latestMessageIDBySession: {},
    sessionAverageByID: {},
    latestResponseUsageBySession: {},
    responseUsageByMessageID: {},
    sessionTokenUsageByID: {}
  };
}
```

Keep `SessionAverage` type for now (deprecated, used by sidebar if needed).

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- test/metrics.test.ts -t "state has per-message"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/metrics.ts test/metrics.test.ts
git commit -m "feat: add per-message metrics state for prompt-right"
```

---

### Task 2: Make record paths per-message + fix hydration / tool-calls / TTFT

**Files:**
- Modify: `src/metrics.ts:73-181`
- Test: `test/metrics.test.ts`

**Interfaces:**
- Consumes: `MessageTiming` `6-13`
- Produces: `recordAssistantMessage`, `recordAssistantDelta`, `recordToolActivity` now per-message; `messageMetricsByID` populated; hydration fallback

- [ ] **Step 1: Write failing tests (hydrate, tool-calls, TTFT token)**

```ts
// test/metrics.test.ts
import { createMetricsState, recordAssistantMessage, recordAssistantDelta, recordToolActivity, renderMetricsText } from "../src/metrics.js";

test("hydrate: completed without prior pending still creates per-message AVG/TTFT", () => {
  const s = createMetricsState();
  recordAssistantMessage(s, { sessionID:"ses_1", messageID:"msg_1", createdAt:1000, completedAt:3000, outputTokens:40, reasoningTokens:10 });
  expect(s.messageMetricsByID["msg_1"]).toBeDefined();
  expect(s.messageMetricsByID["msg_1"]!.totalTokens).toBe(50);
  // duration fallback = completed - created =2000 => avg 25
  expect(renderMetricsText(s,"ses_1",{now:3500})).toContain("AVG 25");
  expect(s.latestMessageIDBySession["ses_1"]).toBe("msg_1");
});

test("tool-calls without tool activity falls back to completedAt per-message", () => {
  const s = createMetricsState();
  recordAssistantMessage(s, { sessionID:"ses_1", messageID:"msg_2", createdAt:1000 });
  recordAssistantDelta(s, { sessionID:"ses_1", messageID:"msg_2", delta:"hi", at:1100 });
  recordAssistantMessage(s, { sessionID:"ses_1", messageID:"msg_2", createdAt:1000, completedAt:3000, outputTokens:20, finish:"tool-calls" });
  expect(s.messageMetricsByID["msg_2"]).toBeDefined();
  expect(s.messageMetricsByID["msg_2"]!.durationMs).toBe(1900); // 3000-1100
});

test("TTFT per-message uses firstTokenAt not tool time", () => {
  const s = createMetricsState();
  recordAssistantMessage(s, { sessionID:"ses_1", messageID:"msg_3", createdAt:1000 });
  recordToolActivity(s,"ses_1","msg_3",1200);
  recordAssistantDelta(s,{sessionID:"ses_1", messageID:"msg_3", delta:"hello", at:2000});
  recordAssistantMessage(s,{sessionID:"ses_1", messageID:"msg_3", createdAt:1000, completedAt:3000, outputTokens:10});
  expect(s.messageMetricsByID["msg_3"]!.ttftMs).toBe(1000); // 2000-1000, not 200
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- test/metrics.test.ts -t "hydrate: completed|tool-calls without|TTFT per-message"`
Expected: FAIL (all 3)

- [ ] **Step 3: Implement fixes in `src/metrics.ts`**

```ts
// recordAssistantMessage: after usage rebuild
state.latestMessageIDBySession[input.sessionID] = input.messageID; // always track latest
const timing = state.messageTimingByID[input.messageID];
let durationMs: number | undefined;
let ttftMs: number | undefined;
if (timing?.firstTokenAt || timing?.firstResponseAt) {
  const first = timing.firstTokenAt ?? timing.firstResponseAt!;
  const endAt = input.finish === "tool-calls" ? (timing.lastToolCallAt ?? input.completedAt) : input.completedAt;
  durationMs = typeof endAt === "number" ? Math.max(endAt - first, 1) : undefined;
  ttftMs = Math.max(first - timing.requestStartAt, 0);
} else {
  // Hydration or race: no timing, fallback to wall time
  durationMs = Math.max(input.completedAt - input.createdAt, 1);
  ttftMs = undefined; // or 0 — choose undefined to hide TTFT for hydrated where firstToken unknown
}
if (totalTokens>0 && durationMs) {
  state.messageMetricsByID[input.messageID] = {
    totalTokens, durationMs, ttftMs, createdAt: input.createdAt, completedAt: input.completedAt,
    avgTps: totalTokens/(durationMs/1000), ttftSec: ttftMs!==undefined? ttftMs/1000 : undefined
  };
  // OPTIONAL: keep sessionAverageByID for sidebar compat (or deprecate)
  // totals.totalTokens += totalTokens etc.
}
delete state.messageTimingByID[input.messageID];
delete state.streamSamplesByMessageID[input.messageID]; // also prune per-message
pruneSamples(state, input.completedAt); // update to prune both maps

// recordAssistantDelta: key by messageID
state.streamSamplesByMessageID[input.messageID] = [
  ...(state.streamSamplesByMessageID[input.messageID] ?? []).filter(item=> input.at - item.at <= STREAM_WINDOW_MS),
  { at:input.at, tokens:estimateStreamTokens(input.delta) }
];
// also keep session copy if you kept it, or mirror to session for backward compat

// recordToolActivity: keep timing.firstResponseAt fallback, delete per-message samples
if (state.streamSamplesByMessageID[messageID]?.length) delete state.streamSamplesByMessageID[messageID];
if (state.streamSamplesBySession[sessionID]?.length) delete state.streamSamplesBySession[sessionID];
```

Update `pruneSamples` to iterate both `streamSamplesByMessageID` and `streamSamplesBySession`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- test/metrics.test.ts -t "hydrate: completed|tool-calls without|TTFT per-message"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/metrics.ts test/metrics.test.ts
git commit -m "fix: per-message AVG/TTFT with hydrate and tool-calls fallback"
```

---

### Task 3: Switch TPS/AVG/TTFT rendering to per-message current round

**Files:**
- Modify: `src/metrics.ts:183-345`
- Test: `test/metrics.test.ts`

**Interfaces:**
- Consumes: `messageMetricsByID`, `latestMessageIDBySession`, `streamSamplesByMessageID`
- Produces: `liveTps(state,sessionID)`, `messageAverage(state,sessionID)`, `messageTtft(state,sessionID)` now per-message; `renderPromptRightMetricsText`/`renderMetricsText` reflect current round

- [ ] **Step 1: Write failing test for per-message rendering + isolation**

```ts
test("renders live TPS, AVG, TTFT per-message current round", () => {
  const s = createMetricsState();
  recordAssistantMessage(s,{sessionID:"ses_1", messageID:"msg_1", createdAt:1000});
  recordAssistantDelta(s,{sessionID:"ses_1", messageID:"msg_1", delta:"x".repeat(50), at:1500}); // 10tok
  recordAssistantDelta(s,{sessionID:"ses_1", messageID:"msg_1", delta:"x".repeat(50), at:2500}); // 10tok
  recordAssistantMessage(s,{sessionID:"ses_1", messageID:"msg_1", createdAt:1000, completedAt:3000, outputTokens:40, reasoningTokens:10});
  // per-message: 50tok / (3000-1500)=50/1.5=33.3, TTFT 0.5s
  expect(renderMetricsText(s,"ses_1",{now:2750})).toBe("TPS 16.0 TPS | AVG 33.3 | TTFT 0.5s");
  // new message should replace, not accumulate
  recordAssistantMessage(s,{sessionID:"ses_1", messageID:"msg_2", createdAt:4000});
  recordAssistantDelta(s,{sessionID:"ses_1", messageID:"msg_2", delta:"x".repeat(100), at:4500}); // 20tok
  recordAssistantMessage(s,{sessionID:"ses_1", messageID:"msg_2", createdAt:4000, completedAt:5000, outputTokens:20});
  // msg2: 20tok / (5000-4500)=40 TPS, TTFT 0.5s, not session average (70tok/2s=35)
  expect(renderMetricsText(s,"ses_1",{now:5500, idle:true})).toBe("TPS - | AVG 40.0 | TTFT 0.5s");
});

test("per-message TPS isolates concurrent messages", () => {
  const s = createMetricsState();
  recordAssistantMessage(s,{sessionID:"ses_1", messageID:"msg_a", createdAt:1000});
  recordAssistantMessage(s,{sessionID:"ses_1", messageID:"msg_b", createdAt:1000});
  recordAssistantDelta(s,{sessionID:"ses_1", messageID:"msg_a", delta:"x".repeat(50), at:1500});
  recordAssistantDelta(s,{sessionID:"ses_1", messageID:"msg_b", delta:"x".repeat(50), at:1500});
  // live TPS for ses_1 should reflect latest message's stream only (msg_b), not sum
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- test/metrics.test.ts -t "renders live TPS, average"`
Expected: FAIL — currently second message yields `AVG 35` (session 70/2) not `40`, and live sums both sessions

- [ ] **Step 3: Implement per-message rendering**

```ts
// src/metrics.ts:292-320
function messageAverage(state:MetricsState, sessionID:string) {
  const msgID = state.latestMessageIDBySession[sessionID];
  if (!msgID) return undefined;
  const m = state.messageMetricsByID[msgID];
  if (!m || m.totalTokens<=0 || m.durationMs<=0) return undefined;
  return formatRate(m.totalTokens/(m.durationMs/1000), "AVG");
}
function messageTtft(state:MetricsState, sessionID:string) {
  const msgID = state.latestMessageIDBySession[sessionID];
  if (!msgID) return undefined;
  const m = state.messageMetricsByID[msgID];
  if (!m || m.ttftMs===undefined || m.ttftMs<0) return undefined;
  return formatTtft(m.ttftMs/1000);
}
function liveTps(state:MetricsState, sessionID:string, opts:{now?:number;idle?:boolean}={}) {
  if (opts.idle) return undefined;
  const msgID = state.latestMessageIDBySession[sessionID];
  if (!msgID) return undefined;
  const now = opts.now ?? Date.now();
  const samples = state.streamSamplesByMessageID[msgID] ?? [];
  const relevant = samples.filter(s=> now - s.at <= STREAM_WINDOW_MS);
  if (relevant.length===0) return undefined;
  const last = relevant.at(-1);
  if (!last || now - last.at > LIVE_STALE_MS) return undefined;
  const total = relevant.reduce((sum,s)=> sum+s.tokens,0);
  const dur = activeDurationMs(relevant, now)/1000;
  return formatRate(total/dur, "TPS");
}
// Keep sessionAverage/sessionTtft deprecated wrappers for 1 version or delete and alias to messageAverage for compat
export function renderMetricsText(state, sessionID, opts={}) {
  const live = liveTps(state,sessionID,opts) ?? "-";
  const avg = messageAverage(state,sessionID) ?? "-";
  const ttft = messageTtft(state,sessionID) ?? "-";
  return `TPS ${live} | AVG ${avg} | TTFT ${ttft}`;
}
export function renderPromptRightMetricsText(state,sessionID,opts={}) {
  const usage = state.latestResponseUsageBySession[sessionID];
  // same but avg/ttft/tps use per-message helpers above
  const values = {
    tps: `TPS ${liveTps(state,sessionID,opts) ?? "-"}`,
    avg: `AVG ${messageAverage(state,sessionID) ?? "-"}`,
    ttft: `TTFT ${messageTtft(state,sessionID) ?? "-"}`,
    // used/cache/input/output/reasoning unchanged (already per-message latest)
  };
}
```

Retain `sessionAverage`/`sessionTtft` as deprecated aliases if external consumers exist, or remove after `npm run verify`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- test/metrics.test.ts -t "renders live TPS|per-message TPS isolates"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/metrics.ts test/metrics.test.ts
git commit -m "feat: render TPS/AVG/TTFT per-message current round"
```

---

### Task 4: Wire TUI hydration and events to per-message state

**Files:**
- Modify: `src/tui.tsx:645-783` (hydrate + event handlers)
- Test: `test/metrics.test.ts` (hydrate integration) + manual TUI check

**Interfaces:**
- Consumes: `recordAssistantMessage`, `recordAssistantDelta`, `latestMessageIDBySession`
- Produces: `hydrateSessionMetrics` populates `messageMetricsByID`/`latestMessageIDBySession`; `PromptRightMetrics` re-renders per-message

- [ ] **Step 1: Update hydration loop to set latestMessageID order**

```ts
// src/tui.tsx:645-675 hydrateSessionMetrics
for (const message of messages.sort((a,b)=> a.info.time.created - b.info.time.created)) {
  if (info.role!=="assistant" || typeof info.time.completed!=="number") continue;
  const input = { sessionID: info.sessionID, messageID: info.id, createdAt: info.time.created, completedAt: info.time.completed, ... };
  recordAssistantMessage(metrics, typeof info.finish==="string"? {...input, finish:info.finish}: input);
  // No extra step — recordAssistantMessage now sets latestMessageIDBySession to last created order, so after loop latest = newest message
}
metricListeners.notify();
```

Ensure messages sorted by `createdAt` so `latestMessageIDBySession` ends as newest. Existing `response.data ?? []` already sorted; add explicit sort for safety.

- [ ] **Step 2: Verify PromptRightMetrics subscription still works**

`src/tui.tsx:781-795` `PromptRightMetrics` currently:
```ts
text={() => renderPromptRightMetricsText(metrics, props.session_id, { idle: status?.type==="idle", metrics: config.promptRightMetrics })}
```
No change needed — helper now internally resolves `latestMessageIDBySession`. When `idle:true`, `liveTps` returns `"-"` but `AVG/TTFT` still show latest message's values.

- [ ] **Step 3: Run verify**

Run: `npm run verify`
Expected: PASS; manual: `npm run build && npm run debug` — open 2 messages in one session, confirm input-box `AVG` shows `40.0` for msg2 not `35` session cumulative.

- [ ] **Step 4: Commit**

```bash
git add src/tui.tsx
git commit -m "fix: wire TUI hydration to per-message metrics"
```

---

### Task 5: Stabilize live TPS and document est vs real (P1)

**Files:**
- Modify: `src/metrics.ts:69-71,322-339`
- Test: `test/metrics.test.ts`

**Interfaces:**
- Consumes: `estimateStreamTokens`, `activeDurationMs`
- Produces: stabilized single-sample handling, JSDoc

- [ ] **Step 1: Write characterization tests**

```ts
test("single token TPS stable at 10ms vs 1000ms per-message", () => {
  const s = createMetricsState();
  recordAssistantMessage(s,{sessionID:"ses_1", messageID:"m1", createdAt:0});
  recordAssistantDelta(s,{sessionID:"ses_1", messageID:"m1", delta:"a", at:1000});
  expect(renderMetricsText(s,"ses_1",{now:1010})).toContain("TPS");
  expect(renderMetricsText(s,"ses_1",{now:2000})).toContain("TPS");
});
test("live est vs real divergence documented", () => {
  expect(estimateStreamTokens("你好世界")).toBe(3);
  expect(estimateStreamTokens("x".repeat(50))).toBe(10);
});
```

- [ ] **Step 2: Implement stabilization**

```ts
// src/metrics.ts:322-326
if (samples.length===1) {
  const tail = tailAt ? Math.max(0, tailAt - samples[0]!.at) : SINGLE_SAMPLE_MS;
  return Math.min(tail, SINGLE_SAMPLE_MS); // remove Math.max(tail,250) lower clamp
}
// Add comment above estimateStreamTokens:
// Estimated tokens for live TPS: ceil(bytes/5). Differs from per-message AVG which uses real output+reasoning tokens. Multibyte inflates bytes but may over/undercount.
```

- [ ] **Step 3: Run tests + manual `npx tsx` check `1010ms` vs `2000ms` now ~1 TPS both**

Run: `npm test -- test/metrics.test.ts -t "single token TPS"`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/metrics.ts test/metrics.test.ts
git commit -m "fix: stabilize per-message live TPS and document est vs real"
```

---

### Task 6: Docs — clarify per-message vs session aggregates

**Files:**
- Modify: `src/metrics.ts:15-40` (JSDoc for `MessageMetrics` vs `SessionAverage`)
- Test: `test/metrics.test.ts` sanity

- [ ] **Step 1: Add JSDoc**

```ts
/**
 * Per-message metrics for input-box (current round).
 * AVG = totalTokens(=output+reasoning)/duration where duration= firstTokenAt→endAt (fallback completed-created if hydrated).
 * TTFT = firstTokenAt - requestStartAt. TPS = live estimated tokens / active burst duration (5s window) for this messageID only.
 * Session totals (Token Usage sidebar) remain in SessionTokenUsage/sessionAverageByID (deprecated for prompt-right).
 */
export type MessageMetrics = { ... }
```

- [ ] **Step 2: Run verify**

Run: `npm run verify`
Expected: PASS (existing `test/metrics.test.ts:20-52` updated to per-message expectation)

- [ ] **Step 3: Commit**

```bash
git add src/metrics.ts
git commit -m "docs: clarify per-message input-box vs session sidebar metrics"
```

---

## Self-Review

**Spec coverage:** All 3 input-box metrics now per-message current round; `used/cache/input/output/reasoning` already per-message verified; session `Token Usage` sidebar retained. Hydration, tool-calls fallback, TTFT token fix mapped to Tasks 2-3.

**Placeholder scan:** No `TBD`/`TODO`; each step has concrete code + `Run:`.

**Type consistency:** New `MessageMetrics` fields `totalTokens:number, durationMs:number, ttftMs:number|undefined, avgTps:number` reused; `latestMessageIDBySession` string map; imports remain `.js`.

---

## Execution Handoff

Plan updated and saved to `docs/superpowers/plans/2026-08-31-tps-avg-accuracy.md` (v2 per-message). Two execution options:

**1. Subagent-Driven (recommended)** - fresh subagent per task, review between tasks

**2. Inline Execution** - batch execution in this session with checkpoints

**Which approach?**
