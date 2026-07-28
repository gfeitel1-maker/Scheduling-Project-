---
title: "Schedule flag/findings reshape — design"
document_type: spec
status: active
created: 2026-07-28
governing_docs: [docs/governance/standards/DESIGN_STANDARD.md]
related_adrs: [docs/adr/2026-07-28-schedule-flag-findings-reshape.md]
archive_when: this work is merged and Verifier PASS recorded
---

# Schedule flag/findings reshape — design

Companion to `docs/adr/2026-07-28-schedule-flag-findings-reshape.md`. That
ADR records the decision and its tradeoffs; this doc is the implementation
map for Maker. No schema change. No destructive migration.

## 1. `findings` shape (new, returned from `buildSchedule`)

```js
// buildSchedule() return value gains a third array, additive to existing
// { slots, stats, conflicts }:
{
  slots: [...],
  stats: {...},
  conflicts: [...],
  findings: [
    {
      kind: 'UNDERSERVED',       // or 'DISTRIBUTION'
      groupId: 'grp_123',
      activityId: 'act_456',
      severity: 'caution',       // see severity table, §3
      reason: 'Goal: 3×/wk — scheduled 1× (group: Otters, activity: Archery)',
      // kind-specific detail, carried through unchanged from current stamp logic:
      got: 1, needed: 3,          // UNDERSERVED only
      beforeCount: 0, requiredBefore: 2, byDay: 'Wed', // DISTRIBUTION only
    },
    // ...
  ],
}
```

`findings` is built in `scheduleCohort()` (`buildSchedule.js`) at the same
point the current code stamps `slot.flags.UNDERSERVED`/`DISTRIBUTION`
(`:364-393`) — replace the "stamp onto every matching slot" loop with a
single `findings.push(...)` per `(groupId, activityId, kind)`. Do not stamp
into `resultSlots[].flags` for these two kinds anymore. `findings` is
returned from `scheduleCohort` alongside `{ slots, stats }`, concatenated
across cohorts in `buildSchedule()` the same way `allSlots`/`allStats`
already are (`:416-426`).

`findings` is **never persisted**. It is not written to `template_slots`,
not passed to `writeFields`, not part of any op-log write. It exists only in
memory for the render that just ran `buildSchedule()`, and is recomputed
fresh on every rebuild.

## 2. What stays on the slot

`UNFILLABLE` — unchanged, stays in `slot.flags` exactly as today
(`buildSchedule.js:330-334`), because it is a genuine per-cell fact with no
group-level aggregation possible (a cell either got filled or it didn't).

`WEATHER_RISK` — removed from `buildSchedule.js` entirely (delete
`:337-340`). It is **not** replaced by another engine-computed flag. Instead,
the renderer computes outdoor exposure directly from data it already has:
wherever a slot cell currently reads `activityId` to look up name/color for
display (`SlotCell.jsx` and friends), it can also look up
`activity.is_outdoor` from the already-fetched `activities` array and render
a lower-emphasis indicator (Designer's call on exact treatment — e.g. a
small icon or the outdoor state folded into the cell's existing tooltip,
not a same-weight dot next to `UNFILLABLE`). This keeps the information
available without occupying a dot slot in the same visual vocabulary as
per-cell placement failures. Concretely: `slotCellConstants.js` drops
`WEATHER_RISK` from `FLAG_COLORS`/`REAL_FLAG_NAMES`; a separate, explicitly
lower-severity treatment (no color-coded dot, or a muted icon using
`var(--anchor)` which is already the "neutral/informational" token) is
Designer's to specify in the Maker brief.

## 3. Severity channel

One lookup table, consumed by both slot flags and findings so severity is
never inferred from color alone:

```js
export const FLAG_SEVERITY = {
  UNFILLABLE: 'danger',     // var(--danger)  — safety/coverage-relevant
  UNDERSERVED: 'caution',   // var(--accent)  — goal not met, not urgent
  DISTRIBUTION: 'info',     // var(--secondary) — scheduling preference missed
}
```

This lives in `slotCellConstants.js` next to `FLAG_COLORS`, but is a
distinct export — `FLAG_COLORS` maps kind → hue (rendering), `FLAG_SEVERITY`
maps kind → urgency tier (sort order, badge grouping, whether it can be
visually de-emphasized). The two happen to correlate 1:1 today by
coincidence of only 3 kinds existing; keeping them separate exports (not
collapsing severity into the color map) is what prevents a future 4th kind
from silently inheriting the wrong visual weight just because someone picked
a "similar enough" color. `ScheduleScreen.jsx`'s header badge and any
sort/group-by-severity UI reads `FLAG_SEVERITY`, never infers urgency from
which `var(--x)` token a color string happens to equal.

## 4. Load-time adapter

Location: `src/utils/normalizeSlots.js`, the single documented read
boundary between raw `template_slots` rows and every consumer (already
handles JSON-parsing `flags` and boolean coercion for the same reason — see
file header comment, lines 1-25).

Change `normalizeSlots()`'s flags handling from a straight `JSON.parse` to
parse-then-strip:

```js
const STALE_FLAG_KEYS = new Set([
  'UNDERSERVED', 'UNDERSERVED_reason', 'UNDERSERVED_dismissed',
  'DISTRIBUTION', 'DISTRIBUTION_reason', 'DISTRIBUTION_dismissed',
  'WEATHER_RISK', 'WEATHER_RISK_reason', 'WEATHER_RISK_dismissed',
])

function stripStaleFlags(flags) {
  const next = {}
  for (const [k, v] of Object.entries(flags)) {
    if (!STALE_FLAG_KEYS.has(k)) next[k] = v
  }
  return next
}
```

Applied after `JSON.parse` (or after the object pass-through branch) at
both existing return points in `normalizeSlots()` (lines 39 and 41). Old
persisted rows whose `flags` JSON contains `UNDERSERVED`/`DISTRIBUTION`/
`WEATHER_RISK` (and their `_reason`/`_dismissed` siblings) simply have those
keys dropped before the row reaches any consumer. `UNFILLABLE` and its
`_reason`/`_dismissed` keys pass through untouched — shape unchanged.

**Tradeoff, stated explicitly (per ADR §"Considered options"):** old
snapshots do not show `UNDERSERVED`/`DISTRIBUTION` findings until the
schedule is next rebuilt via `buildSchedule()`, at which point `findings` is
computed fresh and correct. This is chosen over re-deriving findings from
stale per-slot stamps, because the adapter only ever sees one row's `flags`
JSON — it does not have the group's full slot history or the current
`min_per_week`/`prefer_before_day` targets needed to reconstruct a finding
that would match what a fresh build produces. Showing a best-effort
reconstruction that might not match reality is worse than showing nothing
until rebuild. `template_slots.flags` on disk is never rewritten by this
adapter — it's a pure read-time transform, run every time the row is read,
so it's inherently idempotent and reversible (revert the code, old rows
still parse fine, they just show the old stamped flags again).

No IPC change, no `electron/db/localDb.js` change, no new migration version.

## 5. Dismissal identity for group-level findings

Key: `` `${groupId}|${activityId}|${kind}` `` (e.g.
`"grp_123|act_456|UNDERSERVED"`).

**Does not persist.** Lives in `ScheduleScreen.jsx` component state (a
`Set` or object, same shape as how per-slot dismissal already tracks state
before it's written — except this one is never written to `writeFields`/the
op log at all). Cleared on every `buildSchedule()` rebuild, same as every
other flag in this system already is — `UNFILLABLE` has never survived a
rebuild either, since it's recomputed from scratch each time. This is
consistent behavior, not a regression relative to today.

Justification for not persisting (also in ADR): findings are keyed by
`(group, activity, kind)`, not by a `template_slots` row id, so there is no
existing column to hang a `_dismissed` key off of the way per-slot
dismissal does today. Persisting would require a new table
(`dismissed_findings` or similar) scoped to a template — a real schema
change to support a UI convenience, which the task's "prefer ZERO schema
change" constraint weighs against, especially since the finding itself is
already not persisted (persisting only the dismissal of a non-persisted,
recomputed-every-time fact would itself be a mismatched design).

## 6. Stable activity color

Replace `activityColor(idx)` (`slotCellConstants.js:17`, keyed by array
position) with a variant keyed by activity id, reusing the existing DJB2
hash from `buildSchedule.js:17-24` verbatim (copy the function — it's 6
lines, no export currently exists from `buildSchedule.js` and adding one
would couple the pure engine module to a UI constants file; duplication is
the right call here per `karpathy-guidelines`, not an abstraction):

```js
function djb2(str) {
  let hash = 5381
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) + str.charCodeAt(i)
    hash = hash & hash
  }
  return Math.abs(hash)
}

export function activityColor(activityId) {
  return ACTIVITY_COLORS[djb2(String(activityId)) % ACTIVITY_COLORS.length]
}
```

Every call site that currently passes an array index (`ScheduleScreen.jsx`
`colorIdx: i` at line ~1132, and downstream consumers of `colorIdx`) instead
passes/derives from the activity's stable `id`. Maker should grep all
`colorIdx` usages and `activityColor(` call sites and switch them to pass
`activityId` instead of a loop index; `colorIdx` as a prop name can stay if
convenient, but its value must come from `djb2(activityId) % 6`, never from
array position.

**Explicit collision statement (do not soften in UI copy or Designer's
spec):** with 6 palette colors and typical camps running 15-30 activities,
by pigeonhole at least 3-5 activities *will* share a color. This is
mathematically unavoidable at this N and this palette size, and the palette
is a binding token contract per the task's constraints — it is not being
expanded. The fix this design delivers is **stability** (a given activity
keeps the same color across reorders/additions/reloads), not
**uniqueness**. The UI must continue to rely on activity name/label as the
identifying signal in any place two same-colored activities could appear
together (legends, adjacent cells) — color is supplementary, per the
existing "color = meaning, never decoration" token-contract personality
constraint, and "meaning" here is "this activity, consistently" not "this
activity, uniquely."

## Test impact (for Maker to address, not re-decide)

- `src/engine/buildSchedule.test.js`: assertions currently checking
  `slots[].flags.UNDERSERVED`/`DISTRIBUTION` move to check the new
  `findings` array (kind/groupId/activityId/severity/reason). Assertions
  checking `slots[].flags.WEATHER_RISK` are deleted (engine no longer emits
  it). `UNFILLABLE` assertions are unchanged.
- A new test for `normalizeSlots.js` (or extend its existing coverage if
  any) asserting that a row with legacy `flags` JSON
  (`{"UNDERSERVED":true,"UNDERSERVED_reason":"...","UNFILLABLE":true}`)
  loads with `flags` containing only `{UNFILLABLE: true}` — proving the
  strip-on-load adapter and proving `UNFILLABLE` survives untouched.
- `ScheduleScreen.jsx`'s flag-count/header-badge logic
  (`:1406-1410`) needs a matching test update once its source changes from
  "count flagged slots" to `unfillableSlotCount + findings.length`.

## Deviations (round 2, filed by Maker)

**Findings rail: three per-kind badges instead of one aggregate badge.**
The spec called for a single aggregate header badge opening a single
severity-sorted rail listing all finding kinds together. Round 1 shipped
three separate badges (Unfillable / Underserved / Distribution), each
opening a rail filtered to only that kind — forcing a director to click
three times and never see all problems in one view, which directly
contradicts the spec's stated goal of reading several problem reasons at
once (Tester HIGH, round 2).

Round 2 fix: kept the three per-kind badges (they're a legible count-at-a-glance
director already relies on) but all three now open the *same* rail, and that
rail always lists every finding kind together, severity-sorted
(`findingsRows` in `ScheduleScreen.jsx`, unfiltered). Clicking any badge or
the same badge again toggles one shared `findingsRailOpen` boolean. This
keeps the "several problems at a glance" badges from the round-1 UI while
restoring the spec's "one rail, all kinds, severity order" behavior.
