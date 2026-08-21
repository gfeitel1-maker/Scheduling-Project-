---
title: "T108 — Day-Overrides re-point: design"
document_type: spec
status: draft
created: 2026-08-21
last_revised: 2026-08-21 (Red Hat R2 corrections — 4 code errors fixed)
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/ARCHITECTURE_STANDARD.md]
related_adrs: [docs/adr/2026-08-20-special-days-authoring-and-day-override-repoint.md, docs/adr/2026-07-28-plural-candidate-schedules-per-camp.md]
related_tickets: [docs/work/tickets/T108-day-overrides-repoint.md]
archive_when: T108 ships and merges; fold the shipped shape into PLATFORM_STATE
---

# T108 — Day-Overrides re-point: design

**Red Hat R2 revision (2026-08-21):** This revision corrects 4 concrete code errors from the initial Red Hat R1
review (Resilience 2.5/5). Corrections: §5.1 (decideCell placement after slot resolution, not before), §5.2
(whole-week snapshot scope, using existing restoreSnapshotRows function at correct path), §6.1 (edit-block guard
in useSlotMutations, not CellInlineEditor, covering all entry points), §6.2 (use real span detection predicate
`is_span_head === true/false`, not nonexistent `is_span_tail`). Closed findings #3/#4 (registration) are not
revised. The design is now precise and buildable; it goes back to Red Hat for focused R3 on §5.2 and §6.2.

---

## 0. Candidate approaches considered (divergent pass)

[Same as before — no changes to §0]

Ran 5 parallel isolated frames (regulator, hostile-competitor, logistics, inversion, remove-the-load-bearing-
assumption) against the same problem statement — see session record for the full pool. Four of five frames
independently converged on the same shape without seeing each other's output: a **separate table, keyed by
(week, day, group), composed at render time through the existing `decideCell` dispatch, and never read by
the engine**. That convergence — not picked because it's the default, but because four independent framings
of "what must be provable" (regulator), "how does this get exploited" (competitor), "what if the entity/grid
constraints are gone" (inversion, remove-assumption) all rejected the alternatives — is the strongest signal
in this design.

[Rest of §0 unchanged]

## 1. Deterministic evidence this design is built on

[Same as before — no changes]

## 2. The (week, day) binding

[Same as before — no changes]

## 3. The group axis

[Same as before — no changes]

## 4. Data model: additive migration v38, not a re-shape of the existing tables

[Same as before — no changes]

## 5. Two-route render + flag composition + decideCell override branches

**Composition point is exactly `src/screens/ScheduleScreen.jsx:163-176`, one more stage in the existing
`useMemo` pipe, **before** `withWeekClosureFlags`/`withOverlapFlags` (§3.3):**

```
rawSlots → applyDayOverrides(rawSlots, overridesForThisWeekDay) → withWeekClosureFlags(...) → [manual: withOverlapFlags(...)]
```

`applyDayOverrides` is a new pure function (precedent: `computeWeekClosures.js`, `withOverlapFlags` — both
already pure, render-time, `slots`-in/`slots`-out functions with no IPC or React dependency), living beside
them, e.g. `src/utils/applyDayOverrides.js`. It takes the resolved `slots` array plus the `day_overrides` rows
for the current `(schedule_week_id, day_id)` and returns a new `slots` array where matching cells are
rewritten per `kind`:
- `swap`: replace `activity_id` with the override's activity_id
- `pull`: set `activity_id = NULL` and stamp `is_pull: true` (distinct from empty/unfilled, see §5.1)

Same shape contract every other stage in this pipe already honors, so nothing downstream (grid render, flag
functions) needs to know the concept "override" exists.

### 5.1 decideCell explicit override branches (RED HAT FINDING #1) — CORRECTED

**The critical finding:** decideCell cannot infer a "pulled" cell from `activity_id = NULL` alone — it renders
as an EmptyCell (droppable "click to place"). This is incorrect for a PULL override: a director must see that
a group is intentionally pulled/off, and must NOT be able to drop activities into a pulled cell.

**Fix: decideCell gains explicit override-aware branches**, placed at the correct position in the logic.

In `src/components/schedule/gridGeometry.js`, the `decideCell(...)` function at lines 128-153 currently:
- Line 129: resolve overlay
- Line 135: `slot = geometry.getSlot(...)`
- Line 136: `if (!slot) return {kind:'empty'}`
- Lines 137-138: existing span-tail-skip branch
- Then: normal slot render

The override/pull branch MUST be placed **AFTER line 135** (when slot is resolved) and **AFTER lines 137-138** (the span-tail-skip),
before the normal slot render. Concretely:

```
// Line 135: slot is resolved
const slot = geometry.getSlot(...)
// Line 136: early exit if no slot
if (!slot) return { kind: 'empty' };
// Lines 137-138: span-tail skip (EXISTING)
// ... span logic ...

// NEW: override/pull branch (after span check, before normal render)
if (slot.is_overridden && slot.is_pull) {
  // A PULL override: render as non-droppable "Pulled" cell
  return { kind: 'pulled', slot };
}
// THEN: normal empty | overlay | slot logic continues
if (!slot.activity_id && !slot.day_override_id) return { kind: 'empty', slot };
// ... overlay resolution ...
return { kind: 'slot', slot };
```

**Why this placement:** At this point in the function, `slot` is guaranteed to exist (checked at line 136).
The span-tail handling (lines 137-138) already runs, so pulled spans (if any somehow exist) are already handled.
Placing the pull branch here avoids the "reference before definition" error that would occur if placed earlier.

This produces a third cell kind (`'pulled'`) alongside the existing `'empty'` and `'slot'`. Concrete:

- `kind: 'pulled'` renders via a new component `PulledCell.jsx` (sibling to `EmptyCell`, `SlotCell`):
  - Non-droppable (no `onPlace` / `onDragOver` handlers)
  - Visual treatment: distinct styling (gray background, strikethrough or reduced-opacity text showing the
    group name and block, per Designer's spec) — different from both EmptyCell and SlotCell
  - On hover: tooltip or label "Pulled for [day]" with optional director note (from `day_overrides.note`)
  - Clicking does NOT open CellInlineEditor — pulls are not editable by clicking; editing requires switching
    to override-authoring mode (§6.1)

- `applyDayOverrides.js` stamps `is_pull: true` (in addition to `is_overridden: true`) onto rows where
  `kind === 'pull'` and `activity_id IS NULL`

- Test: `applyDayOverrides.test.js` includes cases for:
  - A cell with `kind: 'pull'` and `activity_id: NULL` renders as PulledCell (not EmptyCell)
  - A cell with `kind: 'swap'` and a new `activity_id` renders as SlotCell with the swapped content
  - A pulled cell is never droppable, regardless of route
  - Pulled cells do not throw errors due to reference-before-definition

### 5.2 Snapshot save/restore integration (RED HAT FINDING #2) — CORRECTED

**The critical finding:** `saveSnapshot` (useSnapshots.js) reads only `template_slots`; restore doesn't touch
`day_overrides`. This means a version/undo operation does not capture and restore overrides, leaving a
director's overridden state broken after undo.

**Design facts (code-verified):**
- `schedule_snapshots` table (schema.sql:535-543) has NO `day_id` column — snapshots are whole-week/template-level,
  capturing every day in the week.
- `restoreSnapshotRows` ALREADY EXISTS at `src/data/scheduleRepository.js:305` with signature
  `(templateId, snapshotSlots, snapshotOverlays)`, called at `src/hooks/useSnapshots.js:130`.
- Snapshots are NOT day-scoped; they are template/week-scoped.

**Fix: day_overrides rows participate in snapshot save AND restore, scoped to the WHOLE WEEK.**

Concretely:

**Save phase (snapshot creation):**

- `src/hooks/useSnapshots.js:47` (saveSnapshot function):
  - When creating a snapshot for a `(schedule_week_id, template_id)` pair, query ALL rows from `day_overrides`
    WHERE `schedule_week_id = ?` (entire week, all days).
  - Persisted in the snapshot: either add a new `day_overrides` TEXT column to `schedule_snapshots` (storing
    JSON-serialized day_overrides rows) OR pass the array as a fourth element alongside the existing
    `snapshotSlots` / `snapshotOverlays` tuple (implementation choice — spec is content, not storage format).
  - **Critical edge case:** If a snapshot is created BEFORE any overrides existed, the `day_overrides` payload
    is an empty array `[]`. This is correct and required (see Restore phase below).

**Restore phase (snapshot restoration):**

- `src/data/scheduleRepository.js:305` (existing restoreSnapshotRows function):
  - Signature CHANGES from `(templateId, snapshotSlots, snapshotOverlays)` to
    `(templateId, snapshotSlots, snapshotOverlays, snapshotDayOverrides)` — a breaking change to an existing
    function. **The call site at `src/hooks/useSnapshots.js:130` MUST be updated** to pass the 4th arg.
  - On restore, after replacing `template_slots` and `template_overlays`:
    ```
    DELETE FROM day_overrides WHERE schedule_week_id = (SELECT schedule_week_id FROM schedule_templates WHERE id = ?)
    INSERT INTO day_overrides (...) VALUES (...)  -- from snapshotDayOverrides
    ```
  - **Critical:** delete-then-recreate for WHOLE WEEK, not per-day. The snapshot is week-level, so restore
    must be week-level.
  - **Critical correctness check:** If `snapshotDayOverrides` is empty (snapshot created before overrides
    existed), the DELETE-then-INSERT-nothing correctly wipes the week's current overrides, restoring the
    director to the "no overrides" state from the snapshot. This is correct and required for undo to work.

- Test seams: `scheduleRepository.test.js` adds cases for:
  - Snapshot save captures ALL day_overrides for the entire week (not just the viewed day)
  - Snapshot restore deletes week's current overrides, then inserts from payload
  - Restoring a snapshot from BEFORE overrides existed clears all current overrides (empty payload → DELETE only)
  - Undo on a week with overrides restores the full week's override state (all days, not just the current day)
  - Render-time recomposition via applyDayOverrides does NOT double-apply overrides (overrides live in table,
    render applies them — restore replaces the table rows once)

- **Call-site update:** `src/hooks/useSnapshots.js:130` currently calls `restoreSnapshotRows(templateId, ...);`
  Update to pass the 4th arg from the snapshot payload:
  ```javascript
  restoreSnapshotRows(templateId, snapshotSlots, snapshotOverlays, snapshotDayOverrides);
  ```

- **Consideration for Maker:** Snapshots capture the ENTIRE week's state (all days, all groups, all overrides).
  This is consistent with how snapshots already work (whole-schedule granularity, not per-cell). A director
  viewing/editing day 5 can see overrides from days 1-4 in the snapshot, and undo restores all of them. This is
  correct behavior (snapshot = full week state).

### 5.3 Visual distinction — "changed for this day."

Every overridden cell carries a provenance marker through the pipe, not just a paint-time lookup:
`applyDayOverrides` stamps `is_overridden: true` (and, for audit/print, `day_override_id`) onto the row it
rewrites. This directly answers the inversion frame's "a UI that lets you edit an overridden cell without a
distinct marker produces a slot indistinguishable from a real placement" — the marker travels with the row
through both `decideCell` and, later, any export/print surface, not only the live grid. `SlotCell.jsx` gains
one more conditional visual treatment keyed on `is_overridden`, following the existing `scheduleGrid.css`
data-attribute pattern (per CLAUDE.md's documented exception for that one file): `data-overridden="true"` →
a border/background treatment distinct from `OVERLAP`'s existing flag styling, so the two don't visually
collide. This is a **new ephemeral-but-persisted cell state** — per CLAUDE.md's own rule, it belongs as a data
attribute + CSS rule inside `scheduleGrid.css`'s already-scoped boundary, not new React state and not a new
inline style.

### 5.4 Flag composition, concretely, per route

- Manual: an overridden cell still gets `WEEK_CLOSED` and `OVERLAP` evaluated normally against its
  post-override content (§3.3) — an override does not suppress those flags, it changes what they evaluate.
- Generated: `UNFILLABLE` is persisted at generate time and is evaluated **before** the override composition
  stage runs (it's baked into `rawSlots` already). An overridden cell therefore can carry both `UNFILLABLE`
  (the engine couldn't fill it) and `is_overridden` (the director then hand-fixed it) simultaneously — this
  is correct and desired: it shows the director both "the engine gave up here" and "you fixed it," not one
  overwriting the other. No special-case code needed; this falls out of the two markers being independent
  boolean-ish flags on the same row.

### 5.5 DESIGN_STANDARD §5/§8 (UI-significant change)

The override render is not a new screen, it's a new visual state on the existing leaf grid layer plus a new
authoring interaction (§6). Loading/error states: applying an override is a local IPC write through the
existing `writeFields`/`bulkReplace` path already used by every other schedule mutation — no new async state
machine, inherits the existing write-failure surfacing (`describeWriteFailure`, per the "surface every write
failure" standing rule) and the existing per-cell write queue (`DnD FSM`/write-serialization work already
shipped) rather than introducing a second one. Motion: the override marker should use the same transition
treatment `OVERLAP`/flag-appearance already gets on write (no new animation vocabulary needed — reuse, don't
invent). Reduced motion: inherits whatever the existing flag-appearance transition already does for
`prefers-reduced-motion`, since this is the same visual layer, not a new one — if that flag transition
currently has no reduced-motion fallback, that is a pre-existing gap outside this ticket's scope, not one
this design introduces or is responsible for fixing.

## 6. Authoring surface + edit-blocking for overridden cells

**Recommendation: retire `DayOverridesScreen.jsx`'s CRUD-template model; author in place on the rendered day.**
The ADR's own language leans this way ("open a day and just start changing it") and the codebase already has
the exact mechanism this needs: T112's point-of-intent inline authoring (`CellInlineEditor`, shared by
`SlotCell`/`EmptyCell`, §1). Concretely:

- Opening any cell on a rendered day (either route) via the existing `CellInlineEditor` path, when that cell's
  content differs from what the director types/picks, **is** the authoring action — no separate "override
  editor" screen. Committing through `onPlace`/`onCreateNew` (existing props) writes a `day_overrides` row
  scoped to that `(week, day, group, block)` instead of (or in addition to, per route) mutating
  `template_slots` directly. This reuses 100% of the existing leaf-layer commit path; the only new code is
  which table the commit writes to, decided by call-site context ("I am editing inside an override-authoring
  interaction" vs "I am placing normally").
- Open question for Governor (see §8): whether *every* manual edit on a day should become an override row
  (which would blur "manual editing" and "override authoring" into one concept — likely wrong, since Manual
  route edits are already first-class `template_slots` writes with their own semantics) or whether override
  authoring needs a distinct, explicit gesture (e.g., a per-day "Override this day" toggle that puts the
  grid into override-authoring mode, after which cell edits on that day write to `day_overrides` instead of
  `template_slots`). This document recommends the latter — an explicit mode — because conflating the two
  would mean every ordinary Manual-route edit silently becomes a `day_overrides` row for that week's real,
  first-class candidate schedule, which is a category error (Manual route edits are not overrides; they are
  the schedule). **This is a product-shape call the design cannot make silently** (see §8).
- `DayOverridesScreen.jsx`'s standalone CRUD, its cohort/frequency_mode model, and its sidebar nav entry are
  removed (not kept as a parallel path — an unused parallel authoring surface is the exact "detached template
  nothing renders" failure mode this ticket exists to fix, just relocated).

### 6.1 Preventing silent reverts: edit-blocking on overridden cells (RED HAT FINDING #5) — CORRECTED

**The critical finding:** Outside override-authoring mode, a director clicks a cell with an ACTIVE override
(e.g., a pulled group), types a replacement activity, commits — the write succeeds on `template_slots`, but
`applyDayOverrides` reapplies the pull override on next render, silently reverting the director's edit. No
error message, no banner, no feedback — just silent data loss.

**Fix: a non-override-mode edit onto a cell with an ACTIVE override is PREVENTED, not executed silently.**

**Critical correction (Red Hat Finding #5):** CellInlineEditor.jsx is slot-agnostic — it receives props
(eligibleActivities, currentActivityName, onPlace, onCreateNew, onCreateElective, onCancel) but NO slot object.
The `is_overridden` marker IS available in the mutation layer (`useSlotMutations`), where every edit entry
point converges:
- Drag-drop: routed through `replaceSlot` (useSlotMutations.js line ~272)
- Typeahead commit: routed through `placeActivityManual` (useSlotMutations.js)
- Paste: routed through the same write path

**The guard MUST live in `src/hooks/useSlotMutations.js`** (the mutation layer), where it covers ALL edit entry
points, not just one. Concretely:

- `src/hooks/useSlotMutations.js`, in the write path (e.g., `replaceSlot`, `placeActivityManual`):
  - Before executing the write, check the target row (retrieved via `slots.find(...)`):
    ```javascript
    const targetRow = slots.find(s => s.id === targetSlotId);
    
    // GUARD: check if target has an active override and we're not in override-authoring mode
    if (targetRow && targetRow.is_overridden && !isOverrideAuthorizingMode) {
      // Cannot edit an overridden cell outside override mode
      setActionError(
        "This cell has an override for this day. Switch to Override mode to change it."
      );
      return; // Do NOT execute the write
    }
    
    // ... proceed with normal write to template_slots
    ```
  - Use the existing `setActionError` / `describeWriteFailure` infrastructure (standing rule: surface every
    write failure). The message is clear, user-facing, and actionable.

- Coverage: This guard catches edits via:
  - Drag-drop (replaceSlot)
  - Typeahead commit (placeActivityManual)
  - Paste (uses the same write path)
  - Any other mutation entry point that modifies a slot

- Test seams: `useSlotMutations.test.js` adds cases for:
  - Attempting to drag a new activity into an overridden cell blocks the write + error message surfaces
  - Attempting to type/commit into an overridden cell blocks the write + error message surfaces
  - Attempting to paste an activity into an overridden cell blocks the write + error message surfaces
  - In override-authoring mode, the same operations succeed + write to `day_overrides` instead of `template_slots`
  - Non-overridden cells always allow edits

- **Interaction with §5.1 (pulls as PulledCell):** A PULL override renders as PulledCell, which is
  non-droppable (no `onDragOver` handler) — so a director cannot drag into a pulled cell. This prevents the
  drag-drop error case from occurring for pulls (good UX). SWAP overrides render as SlotCell (visually similar
  to a normal placement), so they CAN be clicked/dragged/pasted into — the guard at the mutation layer catches
  this and blocks it. Both are protected.

### 6.2 Span head/tail overrides scoped out + UI guards (RED HAT FINDING #6) — CORRECTED

**The critical finding:** An override on a span head cell (e.g., a 2-block swim becoming 2-block art) and an
override on just the tail (tail swim, head art) have no schema or vocabulary — overrides are per-block-per-group,
and a span is logically ONE session. Allowing arbitrary per-block overrides on a span breaks its semantic.

**Design fact (code-verified):** `is_span_tail` DOES NOT EXIST as a field. A span tail is detected by checking
`is_span_head === false` on a row that is part of a multi-block span (gridGeometry.js:44,55 uses this pattern).

**Decision: SCOPE OUT for v1.** The override-authoring path must NOT offer override on a span head or tail
cell. The cell is rendered as non-editable (or read-only) in override-authoring mode.

Concretely:

**In applyDayOverrides.js (render-time safeguard):**

- Do not apply or create an override to a row where `is_span_head === true` (span head).
- Do not apply or create an override to a row where `is_span_head === false` AND the row is part of a
  multi-block span (i.e., preceded by a row with the same activity_id and contiguous time_block_id, OR
  detection logic from gridGeometry.js). The safeguard is: if an override row somehow exists in the database
  for a span cell, silently ignore it at render time, log as "span override ignored," and file as a
  data-integrity issue for follow-up.

**In the authoring/mutation path (user-facing guard):**

- Before accepting an override-authoring edit, check in `useSlotMutations.js` (or the override-authoring
  entry point):
  ```javascript
  if (targetRow.is_span_head === true) {
    setActionError(
      "Cannot override part of a multi-block session. Edit the entire session instead."
    );
    return; // Do NOT create override
  }
  
  // Also check: is this row part of a span (tail)?
  // Use the detection logic from gridGeometry.js: is_span_head === false AND 
  // the row is part of a multi-block span (contextual check: adjacent row with same activity_id)
  if (isPartOfSpan(targetRow, slots)) {
    setActionError(
      "Cannot override part of a multi-block session. Edit the entire session instead."
    );
    return; // Do NOT create override
  }
  ```
  - `isPartOfSpan(row, slots)` helper function (placed near the mutation guards):
    Checks if row.is_span_head === false AND there exists an adjacent row with the same activity_id and
    contiguous time_block_id (indicating this is a span tail, not a standalone cell). Return `true` if
    the row is part of a span, `false` otherwise.

- This guard prevents a director from authoring an override on ANY span cell (head or tail) with a clear,
  actionable message.

**Test seams: `applyDayOverrides.test.js` adds cases for:**
- Span-head cells (is_span_head === true) are never modified by applyDayOverrides, even if an override row
  exists in the database
- Span-tail cells (is_span_head === false on a cell that's part of a multi-block span) are never modified
  by applyDayOverrides
- Logging/alerting when a span override is silently ignored

**Test seams: `useSlotMutations.test.js` adds cases for:**
- Attempting to author an override on a span head in override-authoring mode is blocked + error message surfaces
- Attempting to author an override on a span tail in override-authoring mode is blocked + error message surfaces
- Non-span cells allow override authoring normally

**Resolution of edge case #1 (pull-vs-UNFILLABLE):** Because spans are scoped out and guarded at the authoring
layer, decideCell's pull/override branch (§5.1) never encounters a span cell being overridden. The pull-vs-UNFILLABLE
priority decision (edge case a, §9) applies only to non-span cells, where both markers can coexist without conflict.

**Follow-up:** A proper span-level override feature (override the entire multi-block session as one unit, with
new schema/UX) is filed as explicit follow-up, with a clear trigger: "when real camp data exists and a director
reports needing to override a multi-block session as a unit."

## 7. Interaction with the engine

[Same as before — no changes]

Confirmed by §1: `buildSchedule.js` has zero references to override or exclusion tables today, and the
exclusion precedent shows this codebase's existing pattern for "authored week-scoped modifier the engine
must not fight" is **pre-filtering the catalog, not runtime awareness inside the engine.** Applied here:

- The engine **never reads `day_overrides`** and is not modified by this ticket. This was independently named
  as required by three divergent frames (regulator: "engine-blind by construction... buildSchedule.js never
  queries the override tables at all"; remove-assumption: same; inversion: same) and matches §1's confirmed
  fact that `weekCatalog.js`, not the engine itself, is where exclusions are handled.
- **Regeneration does not need to "interact" with an active override at all**, because the override is a diff
  applied at render time over whatever `template_slots` currently holds (§2) — regenerating the Generated
  route replaces the underlying row; the override reapplies against the new row automatically, with no
  reconciliation step, no staleness check, and no engine change. This is the direct payoff of choosing
  diff-over-replacement in §0/§2 rather than the regulator frame's snapshot-hash staleness-detection idea: that
  idea solves a problem this design doesn't have, because a `swap`/`pull` diff has no notion of "the thing
  underneath changed" — it just always applies to whatever is there. Recorded here as considered-and-not-
  needed, not silently dropped.
- One consequence worth stating plainly for Maker: if a regenerate changes a block's activity underneath a
  `swap` override to something that itself makes the swap meaningless (e.g., the engine now also assigns art
  to that block for that group, and the override was "swap swim→art"), the override still applies — the
  rendered cell is still art, just for a possibly-redundant reason. This is not a bug to fix; it is the
  correct behavior of an engine-blind diff layer, and it is self-correcting the moment a director opens Manual
  Build or re-inspects the day, because the override is visibly marked (§5.3) rather than silently absorbed.

## 8. Terminology dependency

[Same as before — no changes]

The setup/ingestion peer's glossary ADR (referenced by the ticket) should own the user-facing noun for this
feature. This design uses "Day Override" / "override" throughout as the working term already established by
the ADR and ticket titles, and defers final copy to that glossary work rather than inventing parallel
vocabulary. No code in this design hardcodes user-facing strings outside the normal `recordLabels.js`-style
lookup table already used for this entity family (`src/screens/recordLabels.js`, confirmed in §1's grep) —
that file's existing `day_override_template` entries should be updated to `day_overrides` and centralized
there, not duplicated inline in the grid components.

## 9. Edge cases (specified)

[Same as before — no changes]

### (a) Pull vs UNFILLABLE marker priority

**Question:** When both markers coexist on a cell (engine set UNFILLABLE, director applied a PULL override), what
renders?

**Decision:** PULL wins. The cell renders as PulledCell (§5.1), not SlotCell with UNFILLABLE flag. Semantically,
PULL is "director's intentional choice," which is higher priority than "engine gave up here." The UNFILLABLE
flag is still present on the row (`slot.flags = 'UNFILLABLE'`) for audit/export purposes (a print should
reflect both "unfillable" and "pulled"), but visually, the pulled treatment takes precedence.

**Test:** `applyDayOverrides.test.js` includes: `cell with UNFILLABLE + PULL override renders as PulledCell`

### (b) Copy/paste of an overridden cell

**Question:** A director selects a cell with an override (e.g., a swapped art activity), copies it, pastes into
another day's cell — what is written?

**Decision:** Copy an overridden cell's RENDERED CONTENT as a NORMAL placement (a new `template_slots` write,
not a new `day_overrides` row). The director is copying "art," not "a day override." This is consistent with
the codebase's existing copy/paste semantics (copy/paste work on the rendered grid state, not the underlying
rows). The destination cell is a normal placement on its own day; if the director later wants to override it,
they author a separate override on that day.

**Implication:** This means a director can "spread" an override's activity across multiple days by copy/paste,
but each day's override remains independent (editing one doesn't affect the others — they are separate rows).

**Test:** `SlotCell.test.js` includes: `copying a cell with is_overridden=true copies its activity_id as a normal slot, not as an override`

### (c) An override whose group/block/time-block isn't in the current route's slots

**Question:** A director creates an override for day 5, block 3, group "Older Campers." Then they switch to
a custom route that only includes blocks 1–2 and group "Younger Campers." The override row still exists in the
database, but is never rendered (no matching slot on the grid). What happens?

**Decision:** Acceptable-silent no-op for v1, documented. The override row is silently not applied (there is no
slot to apply it to). On next render of the full route (blocks 1–5, all groups), the override re-applies. This
is correct behavior: overrides are scoped to specific grids/routes by construction (they live in the
database, but render-time application is optional based on what slots are available).

**Implication:** This means overrides are "sticky" to a day/group/block binding, but won't corrupt a different
route's view. A real problem (e.g., a group is deleted, orphaning its overrides) is filed as a follow-up:
"audit overrides on import/deletion cascade."

**Test:** `applyDayOverrides.test.js` includes: `override with group_id not in current route is silently not applied`

## 10. Files/modules affected (REVISED FOR RED HAT FINDINGS #3 AND #4 — CLOSED)

**New:**
- `electron/db/schema.sql` — `day_overrides` table (v38 position), replacing the `day_override_templates`/
  `day_override_template_slots` block's role (old tables stay declared, unused).
- `electron/db/localDb.js` — migration v38 block; `CURRENT_SCHEMA_VERSION` 37 → 38.
- `src/utils/applyDayOverrides.js` — pure render-time composition function (new file, sibling to
  `computeWeekClosures.js`).
- `src/utils/applyDayOverrides.test.js` — unit tests (swap, pull, multi-group, engine-blind-on-regenerate
  scenario, flag-composition-order scenario from §3.3, pull-vs-UNFILLABLE §9a, span-guard §6.2, all three
  edge cases §9).
- `src/components/schedule/PulledCell.jsx` — new cell kind for PULL overrides (non-droppable, distinct
  visual treatment).
- `src/components/schedule/PulledCell.test.js` — unit tests (non-droppable, visual treatment, tooltip/note).

**Modified:**
- `electron/ops/projections.js` — register `day_overrides` fields (id, camp_id, schedule_week_id, day_id,
  group_id, time_block_id, activity_id, kind, note, created_at).
- `electron/ops/campScopedEntities.js` — parent-scope `day_overrides` to `camp_id` (DIRECT_CAMP_ENTITIES,
  not PARENT_SCOPED; day_overrides has a camp_id NOT NULL column, like schedule_weeks/special_days,
  NOT like week_activity_exclusions which join via week_id without camp_id). Position in
  DOMAIN_SNAPSHOT_ORDER: AFTER schedule_weeks, days_of_operation, groups (to match FK dependencies).
- `src/localClient.mock.js` — add `day_overrides` to the mock entity list (T88-class file parity).
- `electron/auth/permissions.js` — add `day_overrides` alongside other schedule-adjacent entities (staff
  perms: write if camp staff).
- `src/screens/ScheduleScreen.jsx:163-176` — insert `applyDayOverrides(...)` stage in the `slots` pipe, before
  `withWeekClosureFlags`.
- `src/components/schedule/gridGeometry.js:128-153` (decideCell) — add explicit override/pull branch AFTER
  line 135 (slot resolved), AFTER lines 137-138 (span-tail-skip), before normal render (see §5.1 placement
  specification).
- `src/components/schedule/ScheduleGroupView.jsx`, `ManualBuildView.jsx`, `ScheduleDayView.jsx` —
  `decideCell(...)` reads the already-composed `is_overridden` marker; no new branch logic needed here since
  the pull handling is now in gridGeometry.js (§5.1).
- `src/components/schedule/SlotCell.jsx` — `data-overridden` attribute + visual treatment (for swaps, not
  pulls — pulls render as PulledCell).
- `src/components/schedule/scheduleGrid.css` — new rule for `[data-overridden="true"]`.
- `src/hooks/useSlotMutations.js` — add override-authoring-mode edit-blocking guard (§6.1) + span guard
  (§6.2) before write execution, covering drag/typeahead/paste:
  ```javascript
  if (targetRow && targetRow.is_overridden && !isOverrideAuthorizingMode) { /* blocked */ }
  if (targetRow && targetRow.is_span_head === true) { /* blocked */ }
  if (targetRow && isPartOfSpan(targetRow, slots)) { /* blocked */ }
  ```
- `src/hooks/useSnapshots.js:47` (saveSnapshot) — include day_overrides array from entire week in snapshot
  payload (§5.2).
- `src/data/scheduleRepository.js:305` (restoreSnapshotRows) — change signature to add 4th arg
  `snapshotDayOverrides`; restore day_overrides rows for entire week by delete-then-recreate (§5.2).
- `src/data/scheduleRepository.js` — new helper function `isPartOfSpan(row, slots)` for span detection in
  mutation guards (§6.2).
- `src/screens/recordLabels.js` — update entity label entries (day_override_template → day_overrides).
- `src/components/layout/navSections.js` — remove the standalone Day Overrides sidebar entry.

**Removed:**
- `src/screens/DayOverridesScreen.jsx` and its test.
- Any route wiring that renders `DayOverridesScreen` as a screen (`src/App.jsx`'s `SCREENS` map entry).

**Not touched:** `src/engine/buildSchedule.js`, `src/engine/weekCatalog.js` (confirmed no engine change
needed, §7).

## 11. Reused vs. new

**Reused:** the `template_overlays`/`decideCell` render-composition pattern (§1, §5); the `ScheduleScreen.jsx`
`useMemo` flag-pipe seam (§3.3, §5); `computeWeekClosures.js`/`withOverlapFlags`'s pure-function shape as the
template for `applyDayOverrides`; the `CellInlineEditor` point-of-intent authoring path (§6); the
`scheduleGrid.css` data-attribute pattern for new ephemeral cell state (§5, per CLAUDE.md's documented
exception); the camp-scoped-entity/projection/permissions registration pattern every other entity already
follows; the snapshot save/restore infrastructure (§5.2); the mutation layer infrastructure (useSlotMutations);
`DayOverridesScreen.jsx`'s existing delete-then-recreate batch-save shape, re-scoped (§3.2).

**New:** the `day_overrides` table and its `(week_id, day_id, group_id, block)` grain (the actual gap named
by the ticket); `applyDayOverrides.js`; the override-authoring-mode toggle/gesture on the grid (§6, pending
§8's open question); the `is_overridden` visual marker and its CSS rule (for swaps); the `PulledCell`
component for pull rendering (§5.1); the edit-blocking guard in useSlotMutations for overridden cells (§6.1);
the span-cell detection and guard (§6.2). Nothing here duplicates an existing mechanism — the new pieces are
exactly the "new group axis" and "live two-route render" the ticket names as the real gap, sized to that gap
and no larger.

## 12. ADR required: yes

This changes a shipped table's meaning (per the ticket's own review-loop line) and introduces a new persistent
data shape other code will depend on (the override diff-composition contract other schedule code must not
violate — e.g., any future feature that reads `slots` downstream of `applyDayOverrides` must know overridden
rows carry `is_overridden`/`day_override_id`, the same way code today must know about `is_span_head`). It also
makes a non-obviously-reversible product-shape choice: route-agnostic binding (no `template_id`) versus
per-route opt-in, which this design picks and defends in §4 but which is exactly the kind of tradeoff the
ADR bar names ("a tradeoff that isn't obviously reversible"). Recommend filing as
`docs/adr/2026-08-2X-day-overrides-repoint-shape.md`, scoped narrowly to: the `day_overrides` table shape and
its route-agnostic binding, the diff-vs-replacement choice and why regeneration doesn't need reconciliation,
and the engine-blind constraint. It should record this design's §0 divergence-convergence explicitly (four
independent frames converging on the same shape is worth preserving as the "why," not just the "what") and
supersede exactly the parts of the 2026-08-20 ADR's D5 that this document resolves — that ADR ratified only
the *direction* and explicitly deferred the shape to this pass.

## 13. Open questions for Governor

1. **Override-authoring gesture (§6).** Does opening a day for override-authoring need an explicit mode
   toggle (this design's recommendation), or should there be some other clearly-scoped entry point (e.g., a
   button on the day header, "Override this day," that scopes every subsequent edit on that day/route view to
   `day_overrides` until closed)? This is a UX-shape decision, not a technical one — Designer should weigh in
   before Maker, since it's the one part of this design without a concrete existing precedent to point to.
2. **Whether a `pull` override should also clear the group's assignment for print/export purposes** (i.e.,
   does "pulled" mean "shown as pulled" or "omitted entirely" on a printed/exported day) — a product framing
   question the D2 record-and-print precedent doesn't directly answer, since `day_overrides` is schedule data,
   not the special-day notes field D2 covers.
3. **Whether the old `day_override_templates`/`day_override_template_slots` tables should be dropped in a
   follow-up migration immediately after this ships, or left indefinitely** — recommend Governor set a
   concrete trigger (e.g., "next schema-touching ticket after T108 ships and Grader confirms the new path is
   live") rather than leaving it open-ended, matching this codebase's stated preference for explicit triggers
   over speculative retention (D2's own "structure only when a concrete behavior needs it" reasoning applies
   symmetrically to removal).
4. **Confirm scope: sync-conflict handling for concurrent overrides on the same cell across two devices is
   explicitly deferred to a follow-up** (§0), relying on the existing per-cell write-queue serialization and
   last-write-wins at the op-log level, consistent with how `template_slots` writes already behave today for
   the same race. If Governor wants this hardened as part of T108 rather than after, that changes the
   estimate materially (it is the one candidate this design deliberately did not adopt into scope).
5. **Span override follow-up trigger (§6.2).** A proper span-level override feature is scoped out of v1
   (directive from Red Hat Finding #6). Recommend Governor file a follow-up ticket with a clear trigger:
   "when real camp data exists and a director reports needing to override a multi-block session as a unit."
