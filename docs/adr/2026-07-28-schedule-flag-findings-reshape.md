# Reshape schedule flags: per-cell dots vs. group-level findings

**Status:** proposed

## Context

`buildSchedule.js` (`src/engine/buildSchedule.js:324-395`) currently writes
four flag kinds into the same per-slot `flags` object, which is persisted
verbatim as `template_slots.flags` TEXT (JSON), a column added in migration
version 10 (`electron/db/localDb.js:291-296`, `ALTER TABLE template_slots ADD
COLUMN flags TEXT`):

- `UNFILLABLE` — genuinely per-cell: this specific slot has no eligible
  activity.
- `WEATHER_RISK` — stamped onto every slot whose activity `is_outdoor`
  (`:337-340`). At most camps a large fraction of activities are outdoor, so
  this fires on a large fraction of all slots — a per-cell dot with almost no
  discriminating power.
- `UNDERSERVED` (`:364-373`) and `DISTRIBUTION` (`:376-393`) — both are facts
  about a *(group, activity)* pair evaluated once, then stamped onto every
  slot matching that pair (2-5 slots typically). The same finding renders as
  multiple dots.

Consequences already observed in the live code:
- `ScheduleScreen.jsx:1406-1410` counts flagged *slots*, so the header badge
  is inflated by an unpredictable multiplier — a single understaffing
  problem can show as "5 flags."
- Flag reasons are delivered only via the native `title` attribute
  (`SlotCell.jsx:213, 268`), so multiple stamped copies of the same reason
  string are shown once per cell, with no way to see "this is one problem."
- Dismissal (`ScheduleScreen.jsx:418-429`) is keyed per-slot
  (`{flagName}_dismissed` inside `slot.flags`). A group-level finding
  dismissed on one stamped slot is not dismissed on its siblings unless the
  caller iterates all matching slot ids itself — fragile, and it means
  dismissal state is really trying to describe a (group, activity, kind)
  identity using per-slot storage.

Because `flags` is persisted, any reshape of its meaning is a **read-path
compatibility problem**, not just an engine change: snapshots saved before
this change carry old-shape JSON (`UNDERSERVED`/`DISTRIBUTION` stamped
per-slot, with `_reason`/`_dismissed` sibling keys) and must still load.

## Decision

**Split the per-cell dot vocabulary from group-level findings, and load old
persisted flag shapes through the existing single read boundary rather than
migrating stored rows.**

1. `buildSchedule()` returns a new top-level array, `findings`, alongside
   `slots`/`stats`/`conflicts`. `UNDERSERVED` and `DISTRIBUTION` move here,
   emitted exactly once per `(groupId, activityId, kind)` — not stamped onto
   slots at all. `findings` is **not persisted**: it is derived, cheap to
   recompute, and only ever consumed by the screen that just called
   `buildSchedule()` or reloaded slots. This is the only way to avoid a
   second schema change, since findings are keyed by (group, activity), not
   by slot id, and `template_slots` rows are keyed by slot.

2. `UNFILLABLE` stays a per-slot flag — it is genuinely a fact about one
   cell and nothing else. `WEATHER_RISK` is **demoted off the per-cell dot
   vocabulary** but not deleted: it becomes a plain boolean read directly off
   the placed activity (`activity.is_outdoor`), computed in the UI layer at
   render time from data already loaded (activities are already fetched for
   color/name lookup), not stored as a flag at all — outdoor exposure is a
   property of the activity, not an event worth flagging per placement.
   `buildSchedule.js` stops writing `WEATHER_RISK`/`WEATHER_RISK_reason`
   into `flags`.

3. A `severity` field (`'danger' | 'caution' | 'info'`) is attached to every
   flag/finding kind through one lookup table, independent of the hue used
   to render it, so `UNFILLABLE` (severity `danger`) can never be
   visually camouflaged among lower-severity marks regardless of how many
   kinds accumulate later. `UNFILLABLE → danger`, `UNDERSERVED → caution`,
   `DISTRIBUTION → info`.

4. **Load-time adapter, not a data migration.** `src/utils/normalizeSlots.js`
   is already the single, documented read boundary between raw
   `template_slots` rows and every consumer (it already fixes up JSON
   parsing and nullable-boolean coercion for this exact reason). The adapter
   for old-shape flags lives there: when parsing `row.flags`, any
   `UNDERSERVED`/`DISTRIBUTION` (and their `_reason`/`_dismissed` companion
   keys) found in the persisted object are **stripped, not re-derived**,
   before the row is handed to the renderer. Old-shape `UNFILLABLE` passes
   through unchanged (its shape doesn't change). `WEATHER_RISK` present in
   old rows is also stripped (rendering ignores it as this kind no longer
   exists client-side). Old snapshots load and render without error;
   `template_slots.flags` on disk is left exactly as it was written — no
   migration, no `ALTER TABLE`, no rewrite pass.

5. Group-level finding dismissal gets its own identity —
   `` `${groupId}|${activityId}|${kind}` `` — **not persisted**. Findings are
   recomputed fresh from `buildSchedule()` output every time the screen loads
   or the schedule changes; there is no stable place to persist "dismissed"
   against a (group, activity) pair without a new table, and the existing
   per-slot dismissal precedent (`{flagName}_dismissed` in `flags`) doesn't
   transfer to something that isn't a slot. Dismissal state for findings
   lives in React state for the session only. Tradeoff: a dismissed finding
   reappears on next reload/rebuild. Accepted because (a) it matches
   `UNFILLABLE`'s existing behavior of being recomputed fresh every build —
   no flag in this system has ever survived a schedule rebuild — and (b)
   the alternative (a `dismissed_findings` table keyed by group+activity+kind
   scoped to a template) is a real schema change for a UI convenience, which
   fails the "zero schema change if the read path can carry it" constraint.

6. Activity color derives from `djb2(activity.id) % ACTIVITY_COLORS.length`,
   reusing the DJB2 hash already present in `buildSchedule.js:17-24`
   (imported into wherever color is computed, or duplicated verbatim as a
   ~6-line pure function — Maker's call, no new dependency either way) rather
   than `ACTIVITY_COLORS[arrayIndex % 6]`. This is stable under reordering
   and additions because it keys off the activity's persisted id, not its
   position in a fetched array. It is explicitly **not** a fix for the
   6-color/15-30-activity collision problem — collisions remain unavoidable
   at that ratio, and the UI must not present hue as a unique identifier
   (activity name/label remains the identifying signal; color is
   supplementary grouping, consistent with the existing token contract that
   "color = meaning, never decoration").

## Considered options

- **Persist `findings` on the template row (new column or JSON field).**
  Rejected: findings are cheap to recompute from `slots` + `activities` +
  `groups` on every load, so persisting them creates a second source of
  truth that can drift from `slots`, and it's the schema change the task
  explicitly asks to avoid if the read path can carry it.
- **Re-derive old-shape `UNDERSERVED`/`DISTRIBUTION` into new-shape findings
  at load time**, instead of stripping. Rejected: re-deriving requires the
  original `min_per_week`/`prefer_before_day` targets and the group's full
  slot history at the time the snapshot was taken, which the adapter does
  not have access to (it only sees the `flags` JSON on one row, not the
  whole-template context `buildSchedule` had). A best-effort re-derivation
  from stale per-slot stamps would produce findings that don't match what a
  fresh `buildSchedule()` run would compute today, which is worse than
  showing nothing. Old snapshots simply stop showing these two finding
  kinds until the schedule is rebuilt — acceptable because findings, by
  design, are already always freshly computed, never trusted as historical
  record.
- **Destructive migration** (rewrite `flags` JSON on load or via an ALTER
  TABLE + backfill). Explicitly rejected per this task's constraint — no
  destructive migration on a persisted column with unknown snapshot age.

## Consequences

- `buildSchedule()`'s return shape gains a `findings` array; existing
  callers that destructure `{ slots, stats }` are unaffected (additive).
  `buildSchedule.test.js` needs new assertions for `findings` and updated
  assertions wherever it currently asserts `UNDERSERVED`/`DISTRIBUTION`
  appear inside `slots[].flags` — those assertions move to check
  `findings` instead, and the WEATHER_RISK-on-slots assertions are dropped
  since the engine no longer emits it.
- `slot.flags` shrinks to just `UNFILLABLE`/`UNFILLABLE_reason` at
  steady-state (post-rebuild). Any code path that special-cases dismissal
  via `{flagName}_dismissed` inside `slot.flags` keeps working for
  `UNFILLABLE`, since that path is unchanged.
- `normalizeSlots.js` gains the strip-on-load logic described in Decision
  §4; this is the only file that changes what a *loaded* row looks like — no
  other read path bypasses it (confirmed: `localClient.list()` returns raw
  rows and `normalizeSlots` is documented as the single boundary).
- The header badge (`ScheduleScreen.jsx:1406-1410`) must be recomputed as
  `unfillableSlotCount + findings.length` instead of counting flagged slots,
  which is the actual bug this reshape fixes — no longer inflated by the
  per-pair stamp multiplier.
- `FLAG_COLORS`/`REAL_FLAG_NAMES` in `slotCellConstants.js` lose
  `WEATHER_RISK` and gain a parallel `FINDING_COLORS`/severity table for the
  two finding kinds; this is a UI-layer change the Designer/Maker brief
  covers, not a further architectural decision.
