# Session Activity Analysis — Design

**Date:** 2026-08-12
**Status:** Draft (awaiting user review)

## Problem

The subagent sidebar shows cumulative token usage (e.g. `ctx 4,075,387
tokens`) that can far exceed the model's context window. The number is a
lifetime total summed over every API call a subagent made — including
cache-read tokens re-sent on each tool round-trip and tokens from steps
later auto-compacted away — while the live context gauge measures only
what is currently resident in the window. The two are easily confused.

The sidebar gives no insight into *why* the cumulative total is what it
is: how many tool calls the subagent made, how many skills it loaded, how
many times it auto-compacted, or how the whole subagent tree breaks down.

## Goals

- Surface per-subagent activity on existing sidebar rows (tool calls,
  auto-compaction count, skills used), in addition to the existing
  `ctx N tokens` text.
- Add a collapsible "Session Analysis" sidebar section for the current
  session that aggregates the session's own activity plus all descendant
  subagents (recursive tree).
- Clicking the section opens a detail dialog with a full, scrollable,
  tree-formatted breakdown.
- Survive "jump out of a session and come back": activity must be
  backfilled from opencode's durable message history, not only from live
  events.

## Non-Goals

- No web-search metric — it is only derivable by approximating tool-name
  patterns, which the user chose to exclude.
- No persistence to the capture store for this feature; opencode's own
  history is the source of truth.
- No per-message or per-tool-call timeline (only aggregate counts).

## Data sources (verified against the SDK and real captured data)

All metrics come from opencode's durable session data, reachable through
`api.client` in the TUI plugin. Tool calls made inside a subagent carry
the subagent's own `sessionID` (verified against live captured data).

| Metric | Live source | Historical source |
|---|---|---|
| Tool calls (count + by-name breakdown) | `message.part.updated` with `part.type === "tool"` | `ToolPart` in `session.messages()` parts |
| Tool errors | same, `state.status === "error"` | same |
| Skills used (name + invocations) | `part.tool === "skill"`, name at `state.input.name` | same |
| Auto-compactions | `message.part.updated` with `part.type === "compaction"` (auto flag on the part) | `CompactionPart` with `auto: true` |
| Model-call count ("steps") | `message.part.updated` with `part.type === "step-finish"` | `StepFinishPart` |

Verified against live captured data (726K captured events):

- `session.next.*` events are **never emitted** in this opencode version —
  only classic v1 events (`message.part.updated`, `message.updated`,
  `session.*` …). The live path must use `message.part.updated` for
  everything.
- `step-finish` parts flow through `message.part.updated` (1,344 captured)
  and carry stable `prt_` ids, same as `tool` parts — so live and backfill
  share one part-id namespace and one dedup point.
- Compaction parts (type `compaction`, `auto` flag) land in the
  **subagent's own session** history: the subagent runs its own prompt
  loop, and on overflow `SessionCompaction.create({ sessionID: <subagent> })`
  writes the `CompactionPart` to the subagent session's message stream.
  Backfill from the subagent's history therefore counts its compactions
  correctly. (0 compaction parts were captured in the observation window
  — the 4M-token subagent never compacted; its total is cache-read
  accumulation across ~40 calls — so live firing of compaction parts is
  unverified but flows through the same `session.updatePart` path as
  every other part.)
- `session.list()` returns `Session[]` including `parentID`, so the
  subagent tree (main → children → grandchildren) is rebuildable after
  restart.
- `api.ui.dialog` and `<scrollbox>` (from `@opentui/solid`) are confirmed
  available to TUI plugins; `ScrollBoxRenderable` supports a visible
  vertical scrollbar via `verticalScrollbarOptions`.

## Design

### 1. New module `src/activity.ts`

A pure module following `subagents.ts` / `metrics.ts` conventions. One
session-scoped activity record and the functions to build and merge them.

```ts
export type SessionActivity = {
  toolCalls: number;                            // total tool calls
  toolBreakdown: Record<string, number>;        // "bash" → 12 ...
  errors: number;                               // tools with state.status === "error"
  skills: Record<string, number>;               // "brainstorming" → 1 ...
  autoCompacts: number;                         // compaction parts with auto === true
  steps: number;                                // step-finish parts
};

export type ActivityState = {
  bySessionID: Record<string, SessionActivity>;
  childrenByParent: Record<string, string[]>; // subagent tree, seeded by backfill, updated live
  hydrated: Set<string>;                    // sessions whose history has been backfilled
  seenPartIDs: Record<string, Set<string>>; // per-session dedup of part ids seen (live or backfilled)
  loading: Set<string>;                     // session ids whose backfill is currently in flight
};

export function createActivityState(): ActivityState;
export function emptyActivity(): SessionActivity;
export function recordChild(state: ActivityState, sessionID: string, parentID: string): void;
export function recordToolPart(state: ActivityState, sessionID: string, part: { id?: string; tool: string; state?: { status?: string; input?: { name?: string } } }): boolean;
export function recordCompaction(state: ActivityState, sessionID: string, id: string, auto: boolean): boolean;
export function recordStep(state: ActivityState, sessionID: string, id: string): boolean;
export function mergeActivity(...activities: SessionActivity[]): SessionActivity;
export function treeActivity(state: ActivityState, rootSessionID: string): SessionActivity;
export function hasActivity(a: SessionActivity | undefined): boolean;
```

The `record*` functions return `true` when the part id was **new** (the
count incremented) and `false` when deduplicated. The return value is
used by tests; the live event handler notifies listeners unconditionally
on every `message.part.updated`, so no notify decision is made from it.

Pure helpers for formatting live in the module too:

```ts
export function formatActivitySuffix(a: SessionActivity): string; // "18 calls · 2 auto-compacts · 1 error · 3 skills" (zero values omitted)
export function formatActivityBrief(a: SessionActivity): string;   // same ordering, used by the section line
export function formatSkillCount(skills: Record<string, number>): string; // "3 skills"
```

`recordToolPart` counts into `toolBreakdown` and `skills` (when
`tool === "skill"` and `input.name` is a non-empty string), and
`errors` when `state.status === "error"`.

**Dedup is per-metric, not per-part.** A tool part arrives through
`message.part.updated` multiple times as it transitions
`pending → running → completed/error` with the same `prt_` id. The count
(`toolCalls`) must increment only once per part id, but the error flag and
skill name must be *updated on every sighting* — otherwise a failed tool
is recorded as pending and the error count stays 0. Implemented as:

- `recordToolPart` increments `toolCalls`/`toolBreakdown` only when the id
  is not yet in `seenPartIDs[session]` (then adds it), but always updates
  `errors` and `skills` from the latest sighting's state.
- `recordCompaction` / `recordStep` likewise dedup on their part id and
  only ever count once.

`recordChild(state, sessionID, parentID)` appends `sessionID` to
`childrenByParent[parentID]` if not already present. It is called from the
live `session.created` / `session.updated` handler when `info.parentID`
is set — the same events `applySubagentEvent` already consumes — so the
tree index stays fresh as subagents spawn mid-run. Backfill's
`session.list()` only seeds the index with historical sessions.

`treeActivity` walks `childrenByParent` recursively from
`rootSessionID`, merging `bySessionID[sid]` for each visited session.
Guard against cycles with a visited `Set`.

### 2. Hydration (Approach A — backfill from history)

Mirrors the existing `hydrateSessionMetrics` (tui.tsx:378) pattern. The
sidebar content remounts on session switch, so a `hydrate` prop passed the
same way fires per session with the correct `sessionID`.

**Live path** — extend the existing `message.part.updated` subscription
in tui.tsx (the session id falls back to `evt.properties.sessionID`
when the part omits it, same as the existing handler at tui.tsx:459):

- `part.type === "tool"` → `recordToolPart(state, part.sessionID ?? evt.properties.sessionID, part)`.
- `part.type === "compaction"` → `recordCompaction(state, part.sessionID ?? evt.properties.sessionID, part.id, part.auto === true)`.
- `part.type === "step-finish"` → `recordStep(state, part.sessionID ?? evt.properties.sessionID, part.id)`.

No `session.next.*` subscriptions: those events do not fire in this
opencode version (verified against the captured event stream).

**Backfill path** — `hydrateActivity(api, state, rootSessionID)`:

0. Guard `isSessionID(rootSessionID)` first (same guard as
   `hydrateSessionMetrics`, tui.tsx:379); bail out for non-session ids.

1. `session.list({ limit: 1000 })` once → seed `childrenByParent` (only for
   sessions not already known); collect all session ids. (The default
   `session.list()` limit is 100, ordered by `updated desc`; a large
   project could otherwise miss the oldest subagents of the current tree.)
2. Walk the tree from `rootSessionID`; for each session not in
   `state.hydrated` and not already in `state.loading`, mark it loading and
   call `session.messages({ sessionID })` **concurrently with a cap of 4
   in flight at a time** (small helper, no new dependency), then scan
   `message.parts` (recording against the session being backfilled, not
   the part's own `sessionID` — they are the same id here, but the
   loop's variable is authoritative):
   - `ToolPart` → `recordToolPart`
   - `CompactionPart` → `recordCompaction`
   - `StepFinishPart` → `recordStep`
3. Mark the session hydrated on success, clear loading. Cache per session
   ID so re-entering a session is instant.

**Merge semantics:** live parts and backfilled parts both feed the same
per-session record through the single per-metric dedup in
`seenPartIDs`; backfill merges only parts not yet seen. Since all three
part types carry the same `prt_` id in both live events and backfilled
history, one dedup point covers both paths.

**Failure handling:** on backfill failure, delete the session from
`hydrated` (and clear loading) so the next navigation retries — the same
policy as `hydrateSessionMetrics` (tui.tsx:405). Failures silently
degrade to live-only data; no retry storm is possible because retries
only happen on user navigation.

**Call sequencing** is a spike item in the plan: confirm
`session.list()` includes subagent sessions, and `session.messages()`
returns subagent parts after the parent finishes. If subagents are absent
from `session.list()`, discover children instead from the parent's `task`
ToolParts (`part.state.metadata.sessionId` or the task output), which the
live subagent tracker already relies on.

### 3. Subagent rows — append activity suffix

Extend `SubagentInfo` in `src/subagents.ts` with an optional activity:

```ts
activity?: SessionActivity | undefined;
```

In `getSubagentSidebarModel`, append `formatActivitySuffix(child.activity)`
to the subtitle — after `formatUsage(child)` output, so the order is
`duration · ctx N tokens · activity`. Zero values are omitted entirely.
Example:

```
T3: tightly-coupled fixtures
02:13 · ctx 4,075,387 tokens · 18 calls · 2 auto-compacts
```

The subagent state (`src/subagents.ts`) gains a reference to the shared
`ActivityState`; when `applySubagentEvent` creates/updates a child it
attaches the *live* record from `bySessionID[child.id]` (same object
reference, created on demand), so per-metric updates and backfill merge
into the same object the row reads from. If the activity for a subagent
was never observed, the field is `undefined` and no suffix is shown.

### 4. "Session Analysis" sidebar section

New `SessionAnalysisSidebar` component in `src/tui.tsx`, modeled on
`GoUsageSidebar`:

- Collapsible title row: `▼ Session Analysis`.
- Expanded body: one brief line from `treeActivity(state, sessionID)`:
  `18 calls · 2 auto-compacts · 1 error · 3 skills`.
- **Loading state:** while any session in the tree is in `state.loading`
  (first backfill in flight), append `· loading…` after the brief line
  (or show `loading…` alone when the tree has no activity yet). The
  dialog shows the same indicator while loading.
- Refreshes on activity listener notifications plus a 1s interval timer.
- Hidden entirely when the tree has no activity and nothing is loading.
- Clicking the title toggles collapse; clicking the brief line opens the
  detail dialog.

A dedicated listener registry (`activityListeners`) mirrors
`metricListeners` / `subagentListeners`.

### 5. Detail dialog (scrollable, tree-formatted)

Opened via `api.ui.dialog.replace(() => <SessionAnalysisDialog … />)`.
A custom `Dialog` body (not `DialogSelect`, which forces a hidden
scrollbar) containing:

- Title row with the session label and an `esc` close hint.
- A `<scrollbox>` with `verticalScrollbarOptions={{ visible: true }}`,
  `maxHeight` sized to the terminal, and native wheel/keyboard/accelerated
  scrolling.
- Tree-formatted rows with per-depth indentation built from
  `childrenByParent` + `bySessionID`:

  ```
  Session Analysis                              [esc]

  ▾ Tools (18)
        bash  12
        read   8
        write  3
  ▾ Skills (2)
        test-driven-development  1
        writing-plans            1
  ▾ Auto-compactions
        2
  ▾ Tool errors
        1
  ▾ Model calls (steps)
        41
  ▾ Subagents
        · T3: tightly-coupled fixtures    18 calls · 1 auto-compact
          · child-of-T3                    4 calls
  ```

- Per-line truncation (`Locale.truncateMiddle`-style) for very long tool
  names; everything else scrolls.
- Rows are computed fresh from current state at open time. The dialog is
  a **snapshot**: it does not live-update while open; closing and
  reopening re-renders from the current state.
- **Memory:** `bySessionID` / `childrenByParent` / `seenPartIDs` grow for
  the lifetime of the TUI process (they are never pruned). Accepted
  tradeoff — the TUI plugin already keeps unbounded per-session metric
  state, and this adds a bounded record per observed session; no pruning
  pass is planned.

### 6. Wiring in `src/tui.tsx`

- Create `const activity = createActivityState()` and the
  `activityListeners` registry alongside the existing states.
- Extend the `message.part.updated` handler to feed tool/compaction/
  step-finish parts into `activity` (and call `recordChild` in the
  `session.created` / `session.updated` handler when `info.parentID` is
  set), then notify listeners.
- Add a `hydrateActivity(api, activity, sessionID)` sibling of
  `hydrateSessionMetrics`, invoked from a `hydrate` prop on the
  `SessionAnalysisSidebar` (the sidebar content remounts on session
  switch, so this fires per session with the correct id). Notify
  listeners when done.
- Render `<SessionAnalysisSidebar>` with `state={activity}`, the current
  session id, and `subscribe={activityListeners.subscribe}`.

## Error handling

- All backfill network calls are wrapped in try/catch and failures
  silently degrade to live-only data (same policy as
  `hydrateSessionMetrics`).
- On `session.list()` or `session.messages()` failure: delete the session
  from `hydrated`, clear `loading`, and continue with whatever live parts
  were seen. The next navigation retries (matching
  `hydratedSessions.delete` in tui.tsx:405); no retry storm is possible
  because retries only occur on user navigation.
- Never block the TUI; hydration is async and fire-and-forget.

## Risks / open questions

- Whether `session.list()` returns subagent sessions — spike; fallback is
  child discovery from `task` ToolParts.
- Whether compaction parts fire live through `message.part.updated`
  (0 observed in the capture window) — irrelevant for correctness because
  backfill counts them from the subagent's own history; the live path is
  a best-effort bonus.
- Row subtitle length growth on narrow terminals — mitigated by omitting
  zero values and the sidebar's existing truncation.

## Testing

- `test/activity.test.ts` — pure unit tests: `recordChild` (index append,
  no duplicates), `recordToolPart` (counting, per-metric dedup across
  pending→error transitions, skill extraction, error detection),
  `recordCompaction`, `recordStep`, `mergeActivity`,
  `treeActivity` (recursive aggregation, cycle guard, missing sessions,
  freshness from live-added children), `formatActivitySuffix` /
  `formatActivityBrief` (zero omission, ordering).
- Extend `test/subagents.test.ts` — row subtitle includes activity suffix
  only when activity is present.
- Extend `test/entrypoints.test.ts` (text-assertion style) — the new
  sidebar renders `Session Analysis`, uses `api.route.navigate("session", …)`
  unchanged, and the dialog uses `api.ui.dialog.replace`.
- Backfill sequencing gets a mocked-client test: `session.list()` →
  `childrenByParent` → per-child `session.messages()` (concurrent, capped)
  → merged counts with part-id dedup; failure deletes from `hydrated` so
  the next navigation retries.
- TDD: write failing tests for `activity.ts` helpers first, then
  implement; the tui wiring is verified by the entrypoint text assertions
  and `npm run verify` (typecheck + test + build).
