# Schedule grid: drag-first placement + inline write — implementation plan

**For agentic workers:** this plan is executed with `superpowers:subagent-driven-development`. Each task below is a self-contained unit of work: write the failing test(s), run them, write the minimal implementation, run green, commit. Do not start a task until the previous one is committed. Tasks are ordered so the tree stays green after every commit — no task depends on a *later* task's code.

**Spec:** `docs/work/specs/2026-08-09-schedule-drag-first-placement-design.md` (read in full before starting; every decision below traces back to it).

**Branch:** `work/uiux-audit-2026-08` (already checked out). **Base commit:** `3c38095`.

## Goal

A director places, replaces, and clears schedule-grid activities using two gestures — drag and type-in-cell — with no picklist modal and no floating displaced-items tray. Drop previews are static (CSS-attribute driven, no React re-render of the grid). Typing an unrecognized name in a cell can create a new activity on the spot, usable by any editing role, that never produces a spurious under-served flag.

Success predicate (from spec, restated as test-observable facts):
1. Dropping (from palette or another cell) onto an occupied, eligible, non-anchor slot replaces the occupant; the occupant is not written anywhere — it simply stops being referenced by any slot, so `ActivityPalette`'s derived `scheduledCount` shows it as unplaced again.
2. Dropping onto an anchor slot is refused (no write).
3. Dragging a grid card onto an empty/occupied slot clears the source slot (grid-to-grid move).
4. Dragging a grid card onto the palette area clears the source slot and performs no other write.
5. Hovering an occupied, valid drop target during a drag sets a `data-` attribute the CSS uses to paint a static ghost of the incoming activity and dim the occupant — no React state change, no motion.
6. Clicking a non-anchor cell opens inline text entry; typing filters eligible activities (typeahead); Enter places the top match (replace semantics if occupied); Escape/blur with no selection is a no-op.
7. A no-match name offers "Create '<name>'"; confirming creates a camp-scoped activity (human-provenance write, default rules, `min_per_week` derived from this placement, `max_per_week = null`, all-groups eligibility), places it into the cell, and it appears in `ActivityPalette` immediately.
8. Placing an *existing* activity via inline write never creates or changes a rule.
9. A no-match name that collapses to an existing name under case/space-insensitive comparison is treated as a match, not a duplicate.
10. Every place/replace/clear/create-new mutation runs `recalcStats` + `recalcFindings` and participates in the existing `useFlagChangeAck` beat.
11. `EditModal` and `DisplacedPalette` are gone from the tree; nothing references `displacedItems`/`setDisplacedItems` outside `expandSlot`/`splitSlot`'s own displaced-tray use (which is untouched — see Non-goals).

## Architecture

The existing DnD machinery is reused almost entirely as-is (spec explicitly forbids engine/DnD-activation/snapshot changes):

- `dragFSM.js` (pure transition table) — **unchanged**. It already tracks `movingHit`/`finalHit` and already fires `showDragPreview`/`updateDropIndicator` side effects with `{ hit, kind }`. The ghost-vs-dim behavior is new *paint*, not a new FSM state.
- `useDragFSM.js` — `paintTarget()` already writes `data-drag-over` / `data-drop-edge` / `data-drag-kind` straight to the DOM per spec's data-attribute rule. It gains exactly one more attribute write: `data-drag-replace` when the hovered target is occupied (see Task 3).
- `dragHandlers.js` (`makeDragHandlers`) — `commit()` today branches on `expandDrag` / `paletteActivity` / else-swap-via-`allowSwap`. The else-branch changes from "call `swapSlots`" to "call `replaceSlot`", and `allowSwap` is retired (spec: "allowSwap is removed/retired"). Grid-to-grid-to-palette (drag out to sidebar and release) is a *new* branch: `hit` resolves to `null`/invalid when the pointer is over the sidebar, which is already how `dragFSM`'s `isValidHit` tears down instead of committing — but a clear-source-only outcome needs an explicit commit path, so `resolveHit` needs to recognize the palette as a special (not just invalid) target. See Task 3.
- `useSlotMutations.js` — `swapSlots` is replaced by `replaceSlot` (Task 1). `placeActivityManual` is unchanged (still the palette→empty-cell and palette→occupied-cell path once `dragHandlers` routes through it or `replaceSlot`). A new `createActivityFromCell` function is added (Task 6).
- `SlotCell.jsx` — currently `onClick` always calls `onEdit(slot)` (opens the modal) unless `onSelect` is wired (multi-select mode) or the cell is locked (release). Click-to-open becomes click-to-inline-write (Task 4/5): `onEdit` is renamed in intent (not necessarily in prop name — see Task 4) to open the inline editor instead of the modal.
- `scheduleGrid.css` — two new rules for the ghost/dim states (Task 3), following the exact pattern already used for `data-drag-over`/`data-drop-edge`.
- `ActivityPalette.jsx` — **no changes**. Counts are already derived live from `slots` × `activities`; a newly created activity appearing in `activities` and a cleared slot are both already covered by its existing `.filter`/`.map`.
- `ScheduleScreen.jsx` — removes `EditModal`/`DisplacedPalette` imports and JSX (Task 2, Task 4), removes `editSlot`/`setEditSlot` plumbing that only existed for the modal (keeps whatever `useOverlayFillStamp`'s `displacedItems` still needs for `expandSlot`/`splitSlot` — those are non-goals, untouched), wires the new inline-write state and `createActivityFromCell` (Task 5/6).

## Tech Stack

React 18 (function components, hooks), `@dnd-kit/core` for drag activation/keyboard sensor only (hit-testing is homegrown per `useDragFSM.js`'s header comment), Vitest + `@testing-library/react` for tests, plain inline-style objects (`S` from `../../styles/shared`) plus `scheduleGrid.css` for the one sanctioned stylesheet. Test command: `npx vitest run --no-file-parallelism <path>` (this repo's vitest fakes timeout failures under file-parallelism — see `reference_shoresh_test_env_gotchas`).

## Global Constraints

Copied verbatim from the spec (non-negotiable; do not relax any of these while implementing):

- No two-cell **swapping**. Occupied-slot drops are always replace-and-return-to-palette.
- No change to the schedule **engine**, the seeded generation, DnD activation distance, snapshot/undo semantics, or the two-routes / no-canonical-schedule rules.
- **No motion tween** for the drop preview. Implemented as a `data-` attribute + a rule in `src/components/schedule/scheduleGrid.css` (the app's one sanctioned stylesheet) — must not churn React state across the up-to-480 cells.
- Personality: quiet, never playful. No celebratory copy, no animation flourish on create-new or replace.
- **Anchors (Fixed Events) are not valid targets or sources** — a drop onto an anchor slot is refused (preserve existing `is_anchor` guards). Span/merged double-length slots keep their current behavior.
- Both routes (`manual` and `generated`) are served by the same components — the palette is shared across group/day/activity views; the drag-first + inline-write behavior applies to both routes' slot mutation semantics as they exist today (manual never blocks; generated may set `UNFILLABLE`).
- **Frequency rule derives from usage, not a fixed default** for a cell-created activity; placing an *existing* activity never creates or changes a rule.
- **Create-new is available to any editing role** (not admin-gated) — confirmed below: `activities.write` is already in the `staff` role's permission set (`electron/auth/permissions.js`), so no server-side gate change is needed.
- **Enter places/replaces** the top match (or confirms create-new). No Tab-to-accept. Escape/blur without a selection cancels, leaving the slot unchanged.

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `src/screens/schedule/useSlotMutations.js` | modify | `swapSlots` → `replaceSlot(incoming, target)`; add `createActivityFromCell(...)` |
| `src/screens/schedule/useSlotMutations.test.js` | modify | replace `swapSlots` describe block with `replaceSlot`; add `createActivityFromCell` tests |
| `src/screens/schedule/dragFSM.js` | unchanged | already emits the hit/kind side effects the ghost needs |
| `src/screens/schedule/useDragFSM.js` | modify | `paintTarget` writes one more attribute, `data-drag-replace`, when the hit is occupied |
| `src/screens/schedule/useDragFSM.test.js` | create | test for the new attribute write/clear (currently no dedicated test file for this hook — see Task 3) |
| `src/screens/schedule/dragHandlers.js` | modify | `commit()`'s slot-move branch calls `replaceSlot`, not `swapSlots`; `allowSwap` param removed; palette-clear branch added |
| `src/screens/schedule/dragHandlers.test.js` | modify | replace swap assertions with replace assertions; add palette-clear test |
| `src/screens/schedule/resolveHit.js` *(new, extracted from `useDragFSM.js`)* | create | see Task 3 — only if a palette-drop-target needs to be resolvable; otherwise stays inline (decided in Task 3) |
| `src/components/schedule/scheduleGrid.css` | modify | add `.cell[data-drag-over][data-drag-replace]` ghost + dim rules; add `.cell-inline-write` rules |
| `src/components/schedule/SlotCell.jsx` | modify | click opens inline-write instead of `onEdit`/modal; renders `CellInlineEditor` when active |
| `src/components/schedule/SlotCell.test.jsx` | modify | update click-behavior assertions; add inline-editor mount tests |
| `src/components/schedule/CellInlineEditor.jsx` | create | typeahead input + suggestion list + create-new row, hosted inside `SlotCell` |
| `src/components/schedule/CellInlineEditor.test.jsx` | create | typeahead match / Enter / Escape / create-new / dup-collapse tests |
| `src/components/schedule/EditModal.jsx` | **delete** | replaced by inline write |
| `src/components/schedule/EditModal.test.jsx` (if present) | **delete** | — (confirmed absent at HEAD — no test file to remove) |
| `src/components/schedule/DisplacedPalette.jsx` | **delete** | replaced by "returns to palette" semantics |
| `src/screens/schedule/useOverlayFillStamp.js` | modify | keep `displacedItems`/`setDisplacedItems` (still used by `expandSlot`/`splitSlot` — non-goal), remove nothing here; **no change needed** unless Task 2 finds a stray reference |
| `src/screens/ScheduleScreen.jsx` | modify | remove `EditModal`/`DisplacedPalette` imports + JSX; remove `editSlot`/`setEditSlot` (modal-only); add inline-write active-cell state; wire `createActivityFromCell`; pass `eligibleActivitiesFor(groupId)` down to views/`SlotCell` |
| `src/components/schedule/ManualBuildView.jsx`, `ScheduleGroupView.jsx`, `ScheduleDayView.jsx` | modify | swap `onEditSlot`/`onEdit` prop wiring from "open modal" to "activate inline write"; thread `eligibleActivitiesFor` through |

## Reused vs. new

**Reused as-is:** `dragFSM.js` (pure FSM, zero changes), `@dnd-kit` sensors/activation distance, `placeActivityManual` (palette→empty-cell path, and now also palette→occupied-cell via `replaceSlot`'s delegation — see Task 1), `ActivityPalette.jsx` (zero changes — counts already derive live), `recalcStats`/`recalcFindings`/`useFlagChangeAck` (called from the same places `swapSlots`/`editSlotSave` called them), the human-provenance mechanism (`localClient.write(...)` defaults `source: 'human'` for every interactive write — confirmed in `electron/sync/syncClient.js:786` and `electron/sync/syncServer.js:562` — so `createActivityFromCell` needs **no special stamping code**, just calling `repo.writeActivityFields` like `ActivitiesScreen.jsx`'s `addActivityQuick` already does), the eligibility computation (`activity.eligible_tier_ids`/`eligible_group_ids` filter already used both in `placeActivityManual` and in `EditModal`'s `eligibleActivities` prop at `ScheduleScreen.jsx:1149-1158` — lifted into a shared `eligibleActivitiesFor` helper, Task 5), `normalizeName` from `src/ingest/preview.js` for dup-name collapse (Task 7), the `activities.write` permission (already granted to `staff`, confirmed in `electron/auth/permissions.js` — no gate change).

**New:** `replaceSlot` mutation (Task 1) — genuinely new semantics (swap's rejected in favor of always-replace-plus-source-clear); `CellInlineEditor.jsx` (Task 5) — no existing typeahead-in-cell component to reuse; `createActivityFromCell` (Task 6) — new function, but its body is a thin adapter over the exact `writeFields`-then-`setActivities` pattern `addActivityQuick` already uses in `ActivitiesScreen.jsx:483-520`, adapted to write through `useSlotMutations`'s injected `repo`/`setActivities` instead of that screen's local ones; the `data-drag-replace` attribute (Task 3) — new attribute, same mechanism as the three that already exist.

## ADR required: no

This is a UI interaction redesign over existing primitives (drag machinery, op-log writes, permission matrix) — it introduces no new persistent data shape (no new table/column — `min_per_week`/`max_per_week`/`eligible_*` on `activities` already exist and are written through the existing `writeActivityFields` path), and it changes no contract other modules call across a module boundary (`replaceSlot` replaces `swapSlots` as an *internal* rename within `useSlotMutations`'s returned object — the only caller, `dragHandlers.js`, is updated in the same task). Per the constitution's ADR bar, this stays as an in-repo spec + plan, matching this project's established practice for changes of this shape (see `docs/archive/completed-specs/`).

---

## Tasks

### Task 1 — `replaceSlot` mutation, replacing `swapSlots`

**Files:**
- Modify: `src/screens/schedule/useSlotMutations.js`
- Modify: `src/screens/schedule/useSlotMutations.test.js`

**Interfaces:**
```js
// Consumes (unchanged injection contract — same as swapSlots's):
//   routeState.{route, existingTemplates, templateId, setSlots}
//   repo.writeSlotFields(slotId, fields) -> Promise<{status}>
//   pushUndo({description, undo, redo})
//   setActionError(message|null)
//   recalcStats(slotList), recalcFindings(slotList)
//   slots, activities, days, timeBlocks  (all injected arrays, as today)
//
// Produces:
async function replaceSlot(incoming, target)
// incoming: { groupId, dayId, blockId, activityId } | null-activityId means "drag from an empty source is impossible; caller never does this"
// target:   { groupId, dayId, blockId }  -- NOT an activityId; replaceSlot reads the target's CURRENT activity_id itself,
//           because "what was there" must be read fresh at commit time, not carried in from the drag payload (avoids a stale-read
//           bug if two rapid drops land before state settles).
// Behavior:
//   1. Look up targetRow = slots.find(target coords). Refuse (return, no write) if !targetRow || targetRow.is_anchor.
//   2. Write targetRow.id -> { activity_id: incoming.activityId, flags: {} }.
//   3. If incoming came from another grid slot (incoming.groupId/dayId/blockId is a real source, not the palette):
//      write sourceRow.id -> { activity_id: null, flags: {} } (this IS the "occupant returns to palette" mechanism --
//      there is no separate write for the displaced occupant; clearing target's OLD activity_id from THIS write and
//      clearing incoming's OLD cell (if grid-to-grid) are the only two writes, both already covered by steps 2 and this step).
//   4. setSlots(...) updates both rows locally, calls recalcStats(next) + recalcFindings(next).
//   5. pushUndo with an undo/redo pair that re-applies both writes symmetrically (mirror swapSlots's existing undo shape,
//      but undo restores target's PREVIOUS activity_id and, if grid-to-grid, source's PREVIOUS activity_id -- not a swap).
```

Note on the displaced occupant: `replaceSlot` never writes anything for "the activity that got displaced" — the target row's old `activity_id` is simply overwritten. `ActivityPalette` re-derives `scheduledCount` from `slots` on every render, so once the target row no longer carries the old activity's id, that activity's count drops and it reappears as available. This is the spec's "no separate displaced store" requirement, satisfied by deletion of a reference, not by a write.

**Steps:**

1. Write the failing test first. In `src/screens/schedule/useSlotMutations.test.js`, replace the `describe('useSlotMutations — swapSlots', ...)` block (lines 127–160) with:

```js
describe('useSlotMutations — replaceSlot', () => {
  it('places the incoming activity into an empty target and pushes an undo', async () => {
    const slots = [
      { id: 'row-target', group_id: 'g1', day_id: 'd1', time_block_id: 'b1', activity_id: null, flags: {} },
    ]
    const { hook, props } = setup({ slots, activities: [{ id: 'act-1', name: 'Swim' }] })
    await act(async () => {
      await hook.result.current.replaceSlot(
        { activityId: 'act-1' }, // palette drop: no source coords
        { groupId: 'g1', dayId: 'd1', blockId: 'b1' }
      )
    })
    expect(props.repo.writeSlotFields).toHaveBeenCalledWith('row-target', { activity_id: 'act-1', flags: {} })
    expect(props.pushUndo).toHaveBeenCalledTimes(1)
  })

  it('replaces an occupied target — the occupant is not written anywhere, just overwritten', async () => {
    const slots = [
      { id: 'row-target', group_id: 'g1', day_id: 'd1', time_block_id: 'b1', activity_id: 'act-occupant', flags: {} },
    ]
    const { hook, props } = setup({ slots, activities: [{ id: 'act-1', name: 'Swim' }, { id: 'act-occupant', name: 'Art' }] })
    await act(async () => {
      await hook.result.current.replaceSlot(
        { activityId: 'act-1' },
        { groupId: 'g1', dayId: 'd1', blockId: 'b1' }
      )
    })
    expect(props.repo.writeSlotFields).toHaveBeenCalledTimes(1)
    expect(props.repo.writeSlotFields).toHaveBeenCalledWith('row-target', { activity_id: 'act-1', flags: {} })
  })

  it('grid-to-grid: clears the source slot in addition to writing the target', async () => {
    const slots = [
      { id: 'row-source', group_id: 'g1', day_id: 'd1', time_block_id: 'b1', activity_id: 'act-1', flags: {} },
      { id: 'row-target', group_id: 'g1', day_id: 'd1', time_block_id: 'b2', activity_id: null, flags: {} },
    ]
    const { hook, props } = setup({ slots, activities: [{ id: 'act-1', name: 'Swim' }] })
    await act(async () => {
      await hook.result.current.replaceSlot(
        { groupId: 'g1', dayId: 'd1', blockId: 'b1', activityId: 'act-1' },
        { groupId: 'g1', dayId: 'd1', blockId: 'b2' }
      )
    })
    expect(props.repo.writeSlotFields).toHaveBeenCalledWith('row-target', { activity_id: 'act-1', flags: {} })
    expect(props.repo.writeSlotFields).toHaveBeenCalledWith('row-source', { activity_id: null, flags: {} })
    expect(props.repo.writeSlotFields).toHaveBeenCalledTimes(2)
  })

  it('refuses to write onto an anchor target', async () => {
    const slots = [
      { id: 'row-target', group_id: 'g1', day_id: 'd1', time_block_id: 'b1', is_anchor: true, activity_id: null, flags: {} },
    ]
    const { hook, props } = setup({ slots, activities: [{ id: 'act-1', name: 'Swim' }] })
    await act(async () => {
      await hook.result.current.replaceSlot(
        { activityId: 'act-1' },
        { groupId: 'g1', dayId: 'd1', blockId: 'b1' }
      )
    })
    expect(props.repo.writeSlotFields).not.toHaveBeenCalled()
    expect(props.pushUndo).not.toHaveBeenCalled()
  })

  it('does nothing when the route has no template', async () => {
    const slots = [
      { id: 'row-target', group_id: 'g1', day_id: 'd1', time_block_id: 'b1', activity_id: null, flags: {} },
    ]
    const { hook, props } = setup({
      slots,
      activities: [{ id: 'act-1', name: 'Swim' }],
      routeState: { existingTemplates: { manual: false, generated: false } },
    })
    await act(async () => {
      await hook.result.current.replaceSlot({ activityId: 'act-1' }, { groupId: 'g1', dayId: 'd1', blockId: 'b1' })
    })
    expect(props.repo.writeSlotFields).not.toHaveBeenCalled()
  })

  it('undo restores both target and (grid-to-grid) source to their previous activity_id', async () => {
    const slots = [
      { id: 'row-source', group_id: 'g1', day_id: 'd1', time_block_id: 'b1', activity_id: 'act-1', flags: {} },
      { id: 'row-target', group_id: 'g1', day_id: 'd1', time_block_id: 'b2', activity_id: 'act-occupant', flags: {} },
    ]
    const { hook, props } = setup({ slots, activities: [{ id: 'act-1', name: 'Swim' }, { id: 'act-occupant', name: 'Art' }] })
    await act(async () => {
      await hook.result.current.replaceSlot(
        { groupId: 'g1', dayId: 'd1', blockId: 'b1', activityId: 'act-1' },
        { groupId: 'g1', dayId: 'd1', blockId: 'b2' }
      )
    })
    const entry = props.pushUndo.mock.calls[0][0]
    props.repo.writeSlotFields.mockClear()
    await act(async () => { await entry.undo() })
    expect(props.repo.writeSlotFields).toHaveBeenCalledWith('row-target', { activity_id: 'act-occupant', flags: {} })
    expect(props.repo.writeSlotFields).toHaveBeenCalledWith('row-source', { activity_id: 'act-1', flags: {} })
  })
})
```

2. Run it: `npx vitest run --no-file-parallelism src/screens/schedule/useSlotMutations.test.js` — expect failures (`replaceSlot is not a function`).

3. Implement `replaceSlot` in `src/screens/schedule/useSlotMutations.js`, replacing the entire `swapSlots` function (lines 109–169) with:

```js
  async function replaceSlot(incoming, target) {
    // incoming: { groupId?, dayId?, blockId?, activityId } — coords present only
    // for a grid-to-grid drag; a palette drop supplies activityId alone.
    // target: { groupId, dayId, blockId } — replaceSlot reads its CURRENT row
    // itself rather than trusting a caller-supplied activityId, so a stale drag
    // payload can never overwrite a newer local edit to the target cell.
    if (!existingTemplates[route]) return
    const targetRow = slots.find(s => s.group_id === target.groupId && s.day_id === target.dayId && s.time_block_id === target.blockId)
    if (!targetRow || targetRow.is_anchor) return

    const hasSource = incoming.groupId != null && incoming.dayId != null && incoming.blockId != null
    const sourceRow = hasSource
      ? slots.find(s => s.group_id === incoming.groupId && s.day_id === incoming.dayId && s.time_block_id === incoming.blockId)
      : null

    setActionError(null)
    const prevTargetActivityId = targetRow.activity_id ?? null
    const prevTargetFlags = targetRow.flags ?? {}
    const prevSourceActivityId = sourceRow?.activity_id ?? null
    const prevSourceFlags = sourceRow?.flags ?? {}

    try {
      const writes = [repo.writeSlotFields(targetRow.id, { activity_id: incoming.activityId, flags: {} })]
      if (sourceRow) writes.push(repo.writeSlotFields(sourceRow.id, { activity_id: null, flags: {} }))
      await Promise.all(writes)
    } catch (err) {
      setActionError(describeWriteFailure(err, 'That activity could not be placed.'))
      return
    }

    setSlots(prev => {
      const next = prev.map(s => {
        if (s.group_id === target.groupId && s.day_id === target.dayId && s.time_block_id === target.blockId)
          return { ...s, activity_id: incoming.activityId, flags: {} }
        if (sourceRow && s.group_id === incoming.groupId && s.day_id === incoming.dayId && s.time_block_id === incoming.blockId)
          return { ...s, activity_id: null, flags: {} }
        return s
      })
      recalcStats(next)
      recalcFindings(next)
      return next
    })

    const incomingActivity = activities.find(a => a.id === incoming.activityId)
    const occupantActivity = activities.find(a => a.id === prevTargetActivityId)
    const description = occupantActivity
      ? `Replaced ${occupantActivity.name} with ${incomingActivity?.name ?? 'an activity'}`
      : `Placed ${incomingActivity?.name ?? 'an activity'}`

    pushUndo({
      description,
      undo: async () => {
        await Promise.all([
          repo.writeSlotFields(targetRow.id, { activity_id: prevTargetActivityId, flags: prevTargetFlags }),
          ...(sourceRow ? [repo.writeSlotFields(sourceRow.id, { activity_id: prevSourceActivityId, flags: prevSourceFlags })] : []),
        ])
        setSlots(prev => prev.map(s => {
          if (s.group_id === target.groupId && s.day_id === target.dayId && s.time_block_id === target.blockId)
            return { ...s, activity_id: prevTargetActivityId, flags: prevTargetFlags }
          if (sourceRow && s.group_id === incoming.groupId && s.day_id === incoming.dayId && s.time_block_id === incoming.blockId)
            return { ...s, activity_id: prevSourceActivityId, flags: prevSourceFlags }
          return s
        }))
      },
      redo: async () => {
        await Promise.all([
          repo.writeSlotFields(targetRow.id, { activity_id: incoming.activityId, flags: {} }),
          ...(sourceRow ? [repo.writeSlotFields(sourceRow.id, { activity_id: null, flags: {} })] : []),
        ])
        setSlots(prev => prev.map(s => {
          if (s.group_id === target.groupId && s.day_id === target.dayId && s.time_block_id === target.blockId)
            return { ...s, activity_id: incoming.activityId, flags: {} }
          if (sourceRow && s.group_id === incoming.groupId && s.day_id === incoming.dayId && s.time_block_id === incoming.blockId)
            return { ...s, activity_id: null, flags: {} }
          return s
        }))
      },
    })
  }
```

4. Update the hook's return statement (line ~510) — replace `swapSlots,` with `replaceSlot,`.

5. Run the test file again — expect green. Run the full schedule test directory to catch any other consumer of `swapSlots` before committing: `npx vitest run --no-file-parallelism src/screens/schedule src/components/schedule` (this will show `dragHandlers.js`/`ScheduleScreen.jsx` still referencing `swapSlots` — that's Task 3's job; note it, do not fix it here).

6. Commit: `git add src/screens/schedule/useSlotMutations.js src/screens/schedule/useSlotMutations.test.js && git commit -m "Replace swapSlots with replaceSlot (drop-on-occupied = replace, not swap)"`.

---

### Task 2 — Remove `DisplacedPalette` component and its dead JSX (keep `displacedItems` state — still used by expand/split)

**Files:**
- Delete: `src/components/schedule/DisplacedPalette.jsx`
- Modify: `src/screens/ScheduleScreen.jsx`

**Interfaces:** none — this is subtraction only. `useOverlayFillStamp.js`'s `displacedItems`/`setDisplacedItems` stay: `expandSlot`/`splitSlot` (in `useSlotMutations.js`) still push/pop that tray for the merged-span "run longer" feature, which is explicitly out of scope (non-goal: "No redesign of ... the flag lifecycle" and the spec's Components section only lists `DisplacedPalette.jsx` itself and "the displaced bits of `useOverlayFillStamp`" for removal — re-reading `useOverlayFillStamp.js` at HEAD, there ARE no bits specific to the *drag-drop* displaced flow inside it; `displacedItems` is written only by `expandSlot`/`splitSlot`, both untouched by this plan). Confirm this by grep before deleting anything else.

**Steps:**

1. Confirm no other consumer references `DisplacedPalette`: `grep -rn "DisplacedPalette" src/` — expect exactly two hits, both in `ScheduleScreen.jsx` (the import and the JSX block at lines 1136–1142).

2. In `src/screens/ScheduleScreen.jsx`, delete the import line `import DisplacedPalette from '../components/schedule/DisplacedPalette'` (line 45) and the JSX block:
```jsx
      {/* Displaced activity palette (floating) */}
      {hasSchedule && (
        <DisplacedPalette
          displacedItems={displacedItems}
          onDismiss={dismissDisplaced}
        />
      )}
```
(lines 1136–1142). Leave `displacedItems`/`dismissDisplaced` destructured from `useOverlayFillStamp` untouched — `dismissDisplaced` becomes unused by the screen's JSX but is still exported by the hook; if `eslint` flags it as an unused variable after this edit, remove it from the destructure at line 191–192 (`dismissDisplaced` only — not `displacedItems`/`setDisplacedItems`, which `expandSlot`/`splitSlot` still need via the mutations hook, not via this destructure — double check whether the screen itself reads `dismissDisplaced` anywhere else with `grep -n "dismissDisplaced" src/screens/ScheduleScreen.jsx` first).

3. Delete the file: `rm src/components/schedule/DisplacedPalette.jsx`.

4. Run the full test suite for a sanity check that nothing else imported it: `npx vitest run --no-file-parallelism`. (This is expected to have OTHER failures at this point from Task 1's `swapSlots`→`replaceSlot` rename rippling into `dragHandlers.js`/`ScheduleScreen.jsx` — confirm the failures are ONLY those two files' `swapSlots is not defined`-shaped errors, not anything DisplacedPalette-related, before committing.)

5. Commit: `git add -A && git commit -m "Remove DisplacedPalette (drop-on-occupied returns the occupant to the palette automatically)"`.

---

### Task 3 — Static-ghost drop preview + wire `replaceSlot` into the drag commit path

**Files:**
- Modify: `src/screens/schedule/useDragFSM.js`
- Create: `src/screens/schedule/useDragFSM.test.js`
- Modify: `src/screens/schedule/dragHandlers.js`
- Modify: `src/screens/schedule/dragHandlers.test.js`
- Modify: `src/components/schedule/scheduleGrid.css`
- Modify: `src/screens/ScheduleScreen.jsx` (dragDeps/handlers wiring only)

**Interfaces:**
```js
// dragHandlers.js — makeDragHandlers's dependency object DROPS `allowSwap` and `swapSlots`,
// ADDS `replaceSlot`:
export function makeDragHandlers({
  timeBlocks, days, slots, actMap, getSlot,
  expandSlot, placeActivityManual, replaceSlot,
})

// commit(active, hit) behavior change (only the final branch, previously the allowSwap/swapSlots
// branch, lines 59-71 today):
//   - expandDrag and paletteActivity-onto-EMPTY-cell branches: UNCHANGED (still placeActivityManual
//     for palette->any-valid-cell, since placeActivityManual already handles "activity_id was null or
//     not" -- re-verify: today paletteActivity's branch (lines 51-57) calls placeActivityManual
//     unconditionally, regardless of whether targetSlot is occupied. Per spec, palette-onto-occupied
//     must ALSO be a replace, so this branch changes: if targetSlot has an activity_id, call
//     replaceSlot({ activityId: data.paletteActivity.id }, { groupId, dayId, blockId }) instead of
//     placeActivityManual. If targetSlot is empty, keep calling placeActivityManual (preserves its
//     UNFILLABLE-flag-on-generated-route logic, which replaceSlot does not reproduce and should not --
//     replaceSlot is the "something was already there" path only).
//   - grid-to-grid (data.slot present): was swapSlots when allowSwap and isSwapTarget(slotB); now
//     ALWAYS calls replaceSlot (no allowSwap gate at all -- it's retired) when the target is a valid,
//     non-anchor cell (empty or occupied) and coords differ from the source. isSwapTarget's occupied-or-
//     UNFILLABLE check is renamed/repurposed as isValidGridTarget and loosened to also accept an EMPTY
//     slot (grid-to-grid onto empty must move, not no-op) -- see step-by-step below.

// useDragFSM.js paintTarget(hit, kind) — one more DOM write, driven by a new injected reader:
export function useDragFSM({ commit, describeDrag, describeHit, isOccupied })
// isOccupied(hit) -> boolean, supplied by ScheduleScreen (reads slots for hit.groupId/dayId/blockId).
// paintTarget sets/clears el.dataset.dragReplace = '' when isOccupied(hit) is true AND kind is
// palette-drop or slot-move (never for expand-drag/overlay-fill, which have no replace semantics).
```

**Steps:**

1. Write the failing FSM-paint test first. Create `src/screens/schedule/useDragFSM.test.js`:

```js
// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useDragFSM } from './useDragFSM'

function makeEl() {
  const el = document.createElement('div')
  document.body.appendChild(el)
  return el
}

describe('useDragFSM — static-ghost replace attribute', () => {
  it('showDragPreview sets data-drag-replace when isOccupied(hit) is true for a slot-move drag', () => {
    const el = makeEl()
    const hit = { el, edge: 'top', groupId: 'g1', dayId: 'd1', blockId: 'b1', valid: true }
    const isOccupied = vi.fn(() => true)
    const { result } = renderHook(() => useDragFSM({
      commit: vi.fn(), describeDrag: () => 'x', describeHit: () => 'y', isOccupied,
    }))
    act(() => {
      result.current.dndProps.onDragStart({
        active: { data: { current: { slot: { groupId: 'g0', dayId: 'd0', blockId: 'b0' } } } },
        activatorEvent: { clientX: 0, clientY: 0 },
        delta: { x: 0, y: 0 },
      })
    })
    // Force the resolved hit by monkeypatching resolveHit's DOM lookup target
    el.setAttribute('data-cell-key', 'g1|d1|b1')
    document.elementFromPoint = () => el
    act(() => {
      result.current.dndProps.onDragMove({ activatorEvent: { clientX: 5, clientY: 5 }, delta: { x: 0, y: 0 } })
    })
    expect(el.hasAttribute('data-drag-replace')).toBe(true)
    expect(isOccupied).toHaveBeenCalled()
  })

  it('does not set data-drag-replace when isOccupied(hit) is false', () => {
    const el = makeEl()
    el.setAttribute('data-cell-key', 'g1|d1|b1')
    document.elementFromPoint = () => el
    const { result } = renderHook(() => useDragFSM({
      commit: vi.fn(), describeDrag: () => 'x', describeHit: () => 'y', isOccupied: () => false,
    }))
    act(() => {
      result.current.dndProps.onDragStart({
        active: { data: { current: { slot: { groupId: 'g0', dayId: 'd0', blockId: 'b0' } } } },
        activatorEvent: { clientX: 5, clientY: 5 },
        delta: { x: 0, y: 0 },
      })
    })
    expect(el.hasAttribute('data-drag-replace')).toBe(false)
  })
})
```

2. Run it: `npx vitest run --no-file-parallelism src/screens/schedule/useDragFSM.test.js` — expect failure (`isOccupied` unused / attribute never set).

3. Implement in `src/screens/schedule/useDragFSM.js`:
   - Change the hook signature (line 62) to `export function useDragFSM({ commit, describeDrag, describeHit, isOccupied })`.
   - In `paintTarget(hit, kind)` (lines 86–95), after the existing three `setAttribute` calls, add:
   ```js
     const replaceKinds = kind === DRAG_KINDS.PALETTE_DROP || kind === DRAG_KINDS.SLOT_MOVE
     if (replaceKinds && isOccupied?.(hit)) {
       el.setAttribute('data-drag-replace', '')
     }
   ```
   - In `clearTarget()` (lines 74–82), add `el.removeAttribute('data-drag-replace')` alongside the other three removals.

4. Run the test again — expect green.

5. Wire `isOccupied` from `ScheduleScreen.jsx`: at lines 561–562 where `groupDrag`/`dayDrag` are constructed, add an `isOccupied` function reading the live `slots`:
```js
  function isOccupied(hit) {
    if (!hit) return false
    const s = getSlot(slots, hit.groupId, hit.dayId, hit.blockId)
    return Boolean(s?.activity_id)
  }
```
and pass `isOccupied` into both `useDragFSM({...})` calls.

6. Now the drag-handlers rewrite. Write the failing tests first in `src/screens/schedule/dragHandlers.test.js`: replace every `swapSlots` reference with `replaceSlot`, and replace the assertions. Specifically:
   - Rename `deps.swapSlots` → `deps.replaceSlot` in `baseDeps()`.
   - Remove `allowSwap` from `baseDeps()` and every test's overrides (it no longer exists as a param).
   - Update `'group view: drop onto a filled cell calls swapSlots (allowSwap true)'` → rename to `'group view: drop onto a filled cell calls replaceSlot'`, assert `deps.replaceSlot` called with `({ groupId: 'g1', dayId: 'd1', blockId: 'b1', activityId: 'act-1' }, { groupId: 'g1', dayId: 'd1', blockId: 'b2' })`.
   - Update `'day view: ...'` identically (no more `allowSwap`-gated distinction between the two views — both always replace now).
   - Replace `'allowSwap: false short-circuits without crashing'` with a new test: `'drop onto an EMPTY cell also calls replaceSlot (grid-to-grid move, not a no-op)'`, using `getSlot: vi.fn(() => ({ activity_id: null, is_anchor: false }))`.
   - Add: `'drop onto an anchor cell does not call replaceSlot'`, `getSlot: vi.fn(() => ({ is_anchor: true }))`.
   - Add: `'palette drop onto an occupied cell calls replaceSlot, not placeActivityManual'`, active `{ data: { current: { paletteActivity: { id: 'act-1' } } } }`, `getSlot` returning an occupied non-anchor row; assert `deps.replaceSlot` called and `deps.placeActivityManual` NOT called.
   - Keep the existing `'palette drop onto an EMPTY cell calls placeActivityManual'`-shaped test (check it exists; if not, add it) asserting `placeActivityManual` IS called and `replaceSlot` is NOT, for an empty target.

7. Run: expect failures.

8. Implement in `src/screens/schedule/dragHandlers.js`:
```js
export function makeDragHandlers({
  timeBlocks, days, slots, actMap, getSlot,
  expandSlot, placeActivityManual, replaceSlot,
}) {
  function commit(active, hit) {
    if (!active || !hit) return

    const data = active.data.current || {}
    const { groupId, dayId, blockId } = hit

    if (data.expandDrag) {
      // unchanged — copy verbatim from lines 30-49
      const { groupId: headGroupId, dayId: headDayId, blockId: headBlockId } = data.expandDrag
      if (groupId !== headGroupId || dayId !== headDayId) return
      const headBlock = timeBlocks.find(b => b.id === headBlockId)
      const tailBlock = timeBlocks.find(b => b.id === blockId)
      if (!headBlock || !tailBlock) return
      if (tailBlock.sort_order !== headBlock.sort_order + 1) return
      const tailSlot = getSlot(slots, groupId, dayId, blockId)
      if (!tailSlot || !tailSlot.activity_id || tailSlot.is_anchor) return
      const tailActivity = actMap.get(tailSlot.activity_id)
      const day = days.find(d => d.id === dayId)
      expandSlot(
        headGroupId, headDayId, headBlockId, blockId,
        tailSlot.activity_id, tailActivity?.name || '', tailBlock.name, day?.label ?? dayId
      )
      return
    }

    if (data.paletteActivity) {
      if (!groupId || !dayId || !blockId) return
      const targetSlot = getSlot(slots, groupId, dayId, blockId)
      if (targetSlot?.is_anchor) return
      if (targetSlot?.activity_id) {
        replaceSlot({ activityId: data.paletteActivity.id }, { groupId, dayId, blockId })
      } else {
        placeActivityManual(data.paletteActivity.id, groupId, dayId, blockId)
      }
      return
    }

    const slotA = data.slot
    if (!slotA) return
    if (slotA.groupId === groupId && slotA.dayId === dayId && slotA.blockId === blockId) return

    const slotB = getSlot(slots, groupId, dayId, blockId)
    if (!slotB || slotB.is_anchor) return

    replaceSlot(
      { groupId: slotA.groupId, dayId: slotA.dayId, blockId: slotA.blockId, activityId: slotA.activity_id },
      { groupId, dayId, blockId }
    )
  }

  return { commit }
}
```
Note `isSwapTarget` is deleted entirely — the new grid-to-grid branch accepts any non-anchor target (empty or occupied), which is the "grid card dragged to a slot always moves it" spec behavior.

9. Run: expect green.

10. Wire the rename into `ScheduleScreen.jsx` (lines 538–540):
```js
  const dragDeps = { timeBlocks, days, slots, actMap, getSlot, expandSlot, placeActivityManual, replaceSlot }
  const groupHandlers = makeDragHandlers(dragDeps)
  const dayHandlers = makeDragHandlers(dragDeps)
```
(destructure `replaceSlot` instead of `swapSlots` from `slotMutations` at line 209.)

11. Add the CSS rule to `src/components/schedule/scheduleGrid.css`, immediately after the existing `.cell[data-drag-over][data-drag-kind='expand-drag']` block (after line 639):
```css
/* Static ghost of the incoming activity + dimmed occupant, per spec's "no
   motion tween" rule — data-attribute driven, same mechanism as the drop
   indicator above, not a separate animated layer. */
.cell[data-drag-over][data-drag-replace] .cell-inner {
  opacity: 0.35;
}

.cell[data-drag-over][data-drag-replace]::after {
  content: attr(data-drag-ghost-label);
  position: absolute;
  inset: 8px 6px;
  border-radius: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0 6px;
  font-family: var(--font-sans);
  font-size: 11px;
  font-weight: 600;
  color: var(--primary);
  text-align: center;
  overflow: hidden;
  outline: 2px dashed var(--primary);
  outline-offset: -2px;
  background: color-mix(in srgb, var(--primary) 14%, var(--surface));
  pointer-events: none;
  z-index: 6;
}
```
This reuses the existing `::after` slot the plain drag-over rule already claims (line 594) — `[data-drag-replace]` makes the selector more specific so it wins when both are present, and `attr(data-drag-ghost-label)` reads a label `paintTarget` also needs to write.

12. Back in `useDragFSM.js`'s `paintTarget`, when setting `data-drag-replace`, also set the ghost label so CSS's `attr()` has something to show:
```js
     if (replaceKinds && isOccupied?.(hit)) {
       el.setAttribute('data-drag-replace', '')
       el.setAttribute('data-drag-ghost-label', describeDrag(activeRef.current))
     }
```
(`describeDrag` is already a closure-captured param of the outer hook — available here.) Add the matching removal in `clearTarget()`: `el.removeAttribute('data-drag-ghost-label')`.

13. Re-run `src/screens/schedule/useDragFSM.test.js`, `src/screens/schedule/dragHandlers.test.js`, and the full schedule suite: `npx vitest run --no-file-parallelism src/screens/schedule src/components/schedule`. Expect green except for `SlotCell`/`ScheduleScreen`-level EditModal-related failures, which are Task 4's job — confirm no `replaceSlot`/`swapSlots`/`allowSwap` errors remain.

14. Commit: `git add -A && git commit -m "Static-ghost drop preview (data-attribute) + route grid/palette drops through replaceSlot"`.

---

### Task 4 — Remove `EditModal` and click-to-open wiring

**Files:**
- Delete: `src/components/schedule/EditModal.jsx`
- Modify: `src/screens/ScheduleScreen.jsx`
- Modify: `src/components/schedule/ManualBuildView.jsx`, `src/components/schedule/ScheduleGroupView.jsx`, `src/components/schedule/ScheduleDayView.jsx`
- Modify their test files where they assert modal-opening behavior (`ManualBuildView.test.jsx`, `ScheduleGroupView.test.jsx`, `ScheduleDayView.test.jsx`) — check each for an `onEditSlot`/`onEdit` assertion first.

**Interfaces:**
```js
// SlotCell.jsx's `onEdit` prop is RENAMED to `onActivate` everywhere it is threaded, to make its
// new meaning explicit (was: "open the modal for this slot"; now: "make this cell's inline editor
// active"). Signature is unchanged: onActivate(slot) -> void. This is a pure rename, not a behavior
// change at this layer — Task 5 gives it a real implementation. This task only removes the modal and
// repoints the plumbing so nothing calls `setEditSlot`/renders `<EditModal>` any more.
```

**Steps:**

1. `grep -rn "EditModal" src/` — confirm the only references are: the import + JSX block in `ScheduleScreen.jsx` (lines 14, 1145–1170ish) and no test file (`EditModal.test.jsx` does not exist at HEAD, confirmed earlier).

2. In `ScheduleScreen.jsx`:
   - Delete `import EditModal from '../components/schedule/EditModal'` (line 14).
   - Delete the entire `{editSlot && (<EditModal ... />)}` block (lines 1145 through its closing `)}`).
   - Delete `const [editSlot, setEditSlot] = useState(null)` (line 162) — but FIRST grep whether `editSlot`/`setEditSlot` are read anywhere besides the modal block and the `useSlotMutations`/`useOverlayFillStamp` injections: `grep -n "editSlot\b" src/screens/ScheduleScreen.jsx`. They are injected into `useSlotMutations` (line 204, used by `editSlotSave`) and reset on route switch (line 280 `setEditSlot(null)`). Since `editSlotSave` itself becomes dead code once nothing calls `setEditSlot` to open it (Task 5 replaces the open-path, not `editSlotSave`'s existence) — for THIS task, leave `editSlotSave` wired exactly as-is (it's swapped for the inline-write's own save path in Task 5, not deleted here). Do NOT delete `editSlot`/`setEditSlot` yet if `onEditSlot={setEditSlot}` is still the prop threaded to the three views below — Task 5 replaces `setEditSlot` with the real inline-activate handler. For this task, simply leave `onEditSlot={setEditSlot}` as dead-but-harmless plumbing (it now sets state nothing reads, since the modal is gone) UNLESS you're doing Task 4 and Task 5 as one combined commit — this plan keeps them separate so Task 4's commit is "modal is gone, app still builds and its existing tests pass" and Task 5's commit is "clicking a cell does something again."

3. Run the full test suite: `npx vitest run --no-file-parallelism`. Expect: everything green EXCEPT any test that explicitly asserted `<EditModal>` renders on click (search test files for `EditModal` usage — none exist per step 1, so no test-file edits should be needed here). If `ManualBuildView.test.jsx`/`ScheduleGroupView.test.jsx`/`ScheduleDayView.test.jsx` assert `onEditSlot` gets called on click — that's fine, they can keep asserting that; the prop name changes in Task 5, not this one.

4. Delete the file: `rm src/components/schedule/EditModal.jsx`.

5. Re-run the suite once more to confirm no import errors: `npx vitest run --no-file-parallelism`.

6. Commit: `git add -A && git commit -m "Remove EditModal (picklist) — click-to-cell now opens nothing until Task 5's inline editor lands"`.

*(This intermediate state — click does nothing — is intentionally shipped as its own commit per "smallest independently-testable deliverable." If the team prefers never to land a commit where clicking a cell is a visible regression, squash Tasks 4+5 before merging; the plan keeps them separable for review clarity.)*

---

### Task 5 — Inline-write cell editor: typeahead over eligible activities, Enter-to-place

**Files:**
- Create: `src/components/schedule/CellInlineEditor.jsx`
- Create: `src/components/schedule/CellInlineEditor.test.jsx`
- Modify: `src/components/schedule/SlotCell.jsx`
- Modify: `src/components/schedule/SlotCell.test.jsx`
- Modify: `src/screens/ScheduleScreen.jsx` (thread `eligibleActivitiesFor`, active-cell state, `onActivate`)
- Modify: `src/components/schedule/ManualBuildView.jsx`, `ScheduleGroupView.jsx`, `ScheduleDayView.jsx` (prop rename `onEdit`→`onActivate`, thread eligibility)

**Interfaces:**
```js
// CellInlineEditor.jsx — hosted INSIDE SlotCell when that cell is the active one.
// It does NOT itself decide "which activity matches" beyond simple substring filtering; matching
// against eligible activities and resolving Enter to a placement is entirely local to this component
// plus the two callbacks below (no separate "resolver" module — SIMPLEST responsible shape, per
// karpathy-guidelines: one component owns typing + local filter state + Enter/Escape key handling).
export default function CellInlineEditor({
  eligibleActivities,      // Array<{ id, name, priority }> — already computed by the caller (Task 6
                            // reuses ScheduleScreen's eligibleActivitiesFor(groupId))
  currentActivityName,     // string | null — shown as placeholder text, not prefilled into the input
  onPlace,                 // (activityId: string) => void  — Enter/click on a MATCHING suggestion
  onCreateNew,              // (name: string) => void        — Enter/click on the "Create '<name>'" row
                            //   when the trimmed, normalized input matches no eligible activity's
                            //   normalized name
  onCancel,                 // () => void                    — Escape, or blur with nothing selected
})

// SlotCell.jsx — new local state:
//   const [editing, setEditing] = useState(false)
// handleClick's branch order becomes: isLocked -> onRelease; onSelect -> onSelect(slot,e);
//   else -> setEditing(true) (was: onActivate(slot) i.e. onEdit(slot)) -- anchors and the
//   'unavailable' cell type are excluded from ever setting editing=true (matches "anchors not
//   writable"). CellInlineEditor renders in place of the normal cell-name div when editing is true;
//   its onCancel/onPlace/onCreateNew all call setEditing(false) after invoking the passed-in
//   ScheduleScreen-level callback.

// ScheduleScreen.jsx — new pure helper (extracted from EditModal's inline eligibleActivities
// filter, ScheduleScreen.jsx:1149-1158, now shared by BOTH the inline editor and, unchanged in
// spirit, placeActivityManual's own inline eligibility check):
function eligibleActivitiesFor(groupId) {
  const g = groups.find(g => g.id === groupId)
  if (!g) return []
  return activities.filter(a => {
    const tierIds = a.eligible_tier_ids || []
    const groupIds = a.eligible_group_ids || []
    if (tierIds.length === 0 && groupIds.length === 0) return true
    if (tierIds.includes(g.tier_id)) return true
    if (groupIds.includes(g.id)) return true
    return false
  })
}
```

**Steps:**

1. Write `CellInlineEditor.test.jsx` first (failing):

```jsx
// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import CellInlineEditor from './CellInlineEditor'

const eligible = [
  { id: 'act-1', name: 'Swimming', priority: 'normal' },
  { id: 'act-2', name: 'Arts & Crafts', priority: 'normal' },
]

describe('CellInlineEditor', () => {
  it('typing filters the suggestion list to matching eligible activities', () => {
    render(<CellInlineEditor eligibleActivities={eligible} currentActivityName={null} onPlace={vi.fn()} onCreateNew={vi.fn()} onCancel={vi.fn()} />)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'swi' } })
    expect(screen.getByText('Swimming')).toBeInTheDocument()
    expect(screen.queryByText('Arts & Crafts')).not.toBeInTheDocument()
  })

  it('Enter places the top match', () => {
    const onPlace = vi.fn()
    render(<CellInlineEditor eligibleActivities={eligible} currentActivityName={null} onPlace={onPlace} onCreateNew={vi.fn()} onCancel={vi.fn()} />)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'swi' } })
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' })
    expect(onPlace).toHaveBeenCalledWith('act-1')
  })

  it('no match offers "Create <name>" and Enter confirms it', () => {
    const onCreateNew = vi.fn()
    render(<CellInlineEditor eligibleActivities={eligible} currentActivityName={null} onPlace={vi.fn()} onCreateNew={onCreateNew} onCancel={vi.fn()} />)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Kayaking' } })
    expect(screen.getByText(/Create.*Kayaking/)).toBeInTheDocument()
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' })
    expect(onCreateNew).toHaveBeenCalledWith('Kayaking')
  })

  it('a name that collapses to an existing name (case/space-insensitive) is treated as a match, not create-new', () => {
    const onPlace = vi.fn()
    const onCreateNew = vi.fn()
    render(<CellInlineEditor eligibleActivities={eligible} currentActivityName={null} onPlace={onPlace} onCreateNew={onCreateNew} onCancel={vi.fn()} />)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '  swimming  ' } })
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' })
    expect(onPlace).toHaveBeenCalledWith('act-1')
    expect(onCreateNew).not.toHaveBeenCalled()
  })

  it('Escape cancels without placing or creating', () => {
    const onCancel = vi.fn()
    const onPlace = vi.fn()
    render(<CellInlineEditor eligibleActivities={eligible} currentActivityName={null} onPlace={onPlace} onCreateNew={vi.fn()} onCancel={onCancel} />)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'swi' } })
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' })
    expect(onCancel).toHaveBeenCalled()
    expect(onPlace).not.toHaveBeenCalled()
  })

  it('blur with nothing typed cancels (empty no-op)', () => {
    const onCancel = vi.fn()
    render(<CellInlineEditor eligibleActivities={eligible} currentActivityName={null} onPlace={vi.fn()} onCreateNew={vi.fn()} onCancel={onCancel} />)
    fireEvent.blur(screen.getByRole('textbox'))
    expect(onCancel).toHaveBeenCalled()
  })
})
```

2. Run: `npx vitest run --no-file-parallelism src/components/schedule/CellInlineEditor.test.jsx` — expect failure (module does not exist).

3. Implement `src/components/schedule/CellInlineEditor.jsx`:

```jsx
import { useState, useMemo, useRef, useEffect } from 'react'
import { normalizeName } from '../../ingest/preview.js'

// Hosted inside SlotCell when that cell is the active inline-write target.
// One component owns typing, local filter state and Enter/Escape — there is
// no separate "matcher" module because the match rule is one line (normalized
// substring) and splitting it out would be an abstraction with one caller.
export default function CellInlineEditor({
  eligibleActivities, currentActivityName, onPlace, onCreateNew, onCancel,
}) {
  const [value, setValue] = useState('')
  const inputRef = useRef(null)
  const committedRef = useRef(false)

  useEffect(() => { inputRef.current?.focus() }, [])

  const query = normalizeName(value)
  const matches = useMemo(() => {
    if (!query) return []
    return eligibleActivities.filter(a => normalizeName(a.name).includes(query))
  }, [eligibleActivities, query])

  const exact = useMemo(
    () => eligibleActivities.find(a => normalizeName(a.name) === query) ?? null,
    [eligibleActivities, query]
  )

  function commitTop() {
    if (!query) return
    committedRef.current = true
    if (exact) { onPlace(exact.id); return }
    if (matches.length > 0) { onPlace(matches[0].id); return }
    onCreateNew(value.trim())
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter') { e.preventDefault(); commitTop(); return }
    if (e.key === 'Escape') { e.preventDefault(); committedRef.current = true; onCancel(); return }
  }

  function handleBlur() {
    if (committedRef.current) return
    onCancel()
  }

  return (
    <div className="cell-inline-editor" onClick={e => e.stopPropagation()}>
      <input
        ref={inputRef}
        role="textbox"
        type="text"
        className="cell-inline-editor-input"
        value={value}
        placeholder={currentActivityName || 'Type an activity…'}
        onChange={e => setValue(e.target.value)}
        onKeyDown={handleKeyDown}
        onBlur={handleBlur}
      />
      {query && !exact && (
        <div className="cell-inline-editor-suggestions">
          {matches.map(a => (
            <div
              key={a.id}
              className="cell-inline-editor-suggestion"
              onMouseDown={() => { committedRef.current = true; onPlace(a.id) }}
            >
              {a.name}
            </div>
          ))}
          {matches.length === 0 && (
            <div
              className="cell-inline-editor-suggestion cell-inline-editor-suggestion--create"
              onMouseDown={() => { committedRef.current = true; onCreateNew(value.trim()) }}
            >
              Create "{value.trim()}"
            </div>
          )}
        </div>
      )}
    </div>
  )
}
```

4. Run the test file again — expect green.

5. Add the CSS the component's classNames need, to `scheduleGrid.css` (append at end of file):
```css
/* Inline cell editor (replaces the removed EditModal picklist). Quiet, no
   entrance animation — personality is calm per the design standard. */
.cell-inline-editor {
  position: absolute;
  inset: 4px;
  z-index: 7;
  display: flex;
  flex-direction: column;
  background: var(--surface-elevated);
  border: 1.5px solid var(--primary);
  border-radius: 6px;
  box-shadow: 0 2px 10px color-mix(in srgb, var(--text) 18%, transparent);
}

.cell-inline-editor-input {
  border: none;
  outline: none;
  background: transparent;
  font-family: var(--font-sans);
  font-size: 12px;
  color: var(--text);
  padding: 6px 8px;
}

.cell-inline-editor-suggestions {
  max-height: 140px;
  overflow-y: auto;
  border-top: 1px solid var(--border);
}

.cell-inline-editor-suggestion {
  padding: 6px 8px;
  font-size: 12px;
  font-family: var(--font-sans);
  cursor: pointer;
}

.cell-inline-editor-suggestion:hover {
  background: var(--surface);
}

.cell-inline-editor-suggestion--create {
  color: var(--primary);
  font-weight: 600;
}
```

6. Update `SlotCell.jsx`'s tests first (`SlotCell.test.jsx`) — find the existing click-opens-modal-shaped assertions (`grep -n "onEdit" src/components/schedule/SlotCell.test.jsx`) and add new ones for the rename + inline-mount behavior:
```jsx
it('clicking an unlocked, unselected activity cell activates inline write instead of calling onEdit', () => {
  const onActivate = vi.fn()
  render(<SlotCell slot={{ groupId: 'g1', dayId: 'd1', blockId: 'b1', type: 'activity', activity_id: 'act-1' }}
    activity={{ id: 'act-1', name: 'Swim' }} isDndEnabled onActivate={onActivate}
    eligibleActivities={[{ id: 'act-1', name: 'Swim' }]} onPlace={vi.fn()} onCreateNew={vi.fn()} />)
  fireEvent.click(screen.getByRole('gridcell'))
  expect(screen.getByRole('textbox')).toBeInTheDocument()
})

it('does not activate inline write on an anchor cell', () => {
  render(<SlotCell slot={{ groupId: 'g1', dayId: 'd1', blockId: 'b1', type: 'anchor' }} anchor={{ name: 'Flag' }} />)
  fireEvent.click(screen.getByRole('gridcell'))
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
})
```
(Adjust these to match whatever render helpers `SlotCell.test.jsx` already uses — read the file's existing setup before adding, since it likely wraps `DndContext`; follow its established pattern rather than introducing a second one.)

7. Implement in `SlotCell.jsx`:
   - Add new props: `eligibleActivities = [], onPlace, onCreateNew` (replacing the `onEdit` prop's old call sites); rename the `onEdit` prop itself to `onActivate` is NOT required at this layer if the parent still passes a prop named `onEdit` — but per the Interfaces section above, do the rename for clarity: change the prop destructure at line 69 from `onEdit,` to `onActivate,` — no, hold on: `onEdit` is currently ALSO used by the anchor branch (`onClick={() => { triggerPress(); onEdit(slot) }}` at line 155) which must keep doing NOTHING now (anchors are not writable) — so the anchor branch's onClick simplifies to just `triggerPress()`, dropping the `onEdit(slot)` call entirely, and the whole `onEdit` prop is removed from the anchor render path.
   - Add `const [editing, setEditing] = useState(false)` near the existing `pressed` state (line 106).
   - Change `handleClick` (lines 198–203):
   ```js
   function handleClick(e) {
     triggerPress()
     if (isLocked) { onRelease?.(slot); return }
     if (onSelect) { onSelect(slot, e); return }
     setEditing(true)
   }
   ```
   - Change the anchor branch's `onClick` (line 155) from `onClick={() => { triggerPress(); onEdit(slot) }}` to `onClick={() => triggerPress()}` (anchors press but never open anything).
   - Change `handleDoubleClick` (lines 205–208) similarly — it called `onEdit(slot)`; since single-click now activates inline write, double-click's extra behavior is redundant; simplest fix per karpathy-guidelines is to delete `handleDoubleClick` and its `onDoubleClick={handleDoubleClick}` prop on the returned element entirely, rather than repointing it at `setEditing(true)` too (one activation path, not two — a double-click still fires the single click's `onClick` first in the DOM, so `editing` is already `true` by the time the second click of the pair lands; nothing is lost).
   - Change `handleContextMenu` (lines 210–213): right-click also called `onEdit(slot)`. Repoint it to `setEditing(true)` too (keeps right-click as an alternate path into the same editor, consistent with "the keyboard-fast path" framing in the spec — right-click was never a keyboard path, but repointing it costs nothing and preserves existing behavior's INTENT, which was "another way to open the editor").
   - After the `cell-name` div (inside the `cell-inner`, after line 309's closing `</div>` for `cell-name`... actually render it as a REPLACEMENT for cell-name's content when editing, not alongside it — simplest: wrap the existing `cell-name` div's contents in a ternary):
   ```jsx
     {editing ? (
       <CellInlineEditor
         eligibleActivities={eligibleActivities}
         currentActivityName={activity?.name ?? null}
         onPlace={(activityId) => { setEditing(false); onPlace?.(slot, activityId) }}
         onCreateNew={(name) => { setEditing(false); onCreateNew?.(slot, name) }}
         onCancel={() => setEditing(false)}
       />
     ) : (
       <div className="cell-name" data-unassigned={!activity ? '' : undefined}>
         {showIdentityDot && activity && (
           <span className="identity-dot" style={{ background: color }} />
         )}
         {activity?.name || (isUnfillable ? 'Unfillable' : 'Unassigned')}
       </div>
     )}
   ```
   - Add the import: `import CellInlineEditor from './CellInlineEditor'`.
   - Guard against activating on the `type === 'anchor'` and `type === 'unavailable'` early-return branches (lines 153–184) — those already `return` before reaching `handleClick`, so no change needed there; confirm by reading — the anchor/unavailable branches each render their own shell with their own onClick, already isolated from `handleClick`. Good — no extra guard required.

8. Run `SlotCell.test.jsx` — expect green (adjust any pre-existing tests that asserted `onEdit` gets called on click/double-click/context-menu; update them to assert `editing` renders instead, or delete tests that specifically exercised double-click-opens-modal since that path no longer exists).

9. Thread the new props from the three view components down to `SlotCell`. In `ScheduleGroupView.jsx` (line 234) and `ScheduleDayView.jsx` (line 201), change `onEdit={cellClickHandler || (s => onEditSlot(s))}` to remove the `onEdit` prop and instead pass `onActivate`-shaped behavior implicitly via `SlotCell`'s own `editing` state (no `onActivate` prop is actually needed anymore, since `SlotCell` now manages `editing` locally) — pass `onPlace` and `onCreateNew` (both bubbling up to `ScheduleScreen.jsx`, added in Task 6) and `eligibleActivities={eligibleActivitiesFor(group.id)}` (group known at the render site — check each view file's existing loop variable name, likely `group.id` in `ScheduleGroupView.jsx` and needs the group looked up per-row in `ScheduleDayView.jsx`, which iterates groups × blocks for one day — same lookup is already done there for other per-cell props; follow the existing pattern). Remove `cellClickHandler` and `onEditSlot` props entirely from both files' prop lists once nothing calls them (grep each file for other uses first — `cellClickHandler` may be used by the generated-route "track changes" review's read-only mode; if so, keep passing `eligibleActivities={[]}` there so `SlotCell` still activates editing harmlessly, OR pass a `readOnly`-shaped prop if `cellClickHandler` exists specifically to override editing off — READ `cellClickHandler`'s call site in full before deciding; if it's used to make cells non-interactive in a review context, `SlotCell.handleClick`'s existing `if (onSelect)` branch already intercepts before reaching `setEditing(true)`, so verify whether the review mode sets `onSelect` — if it does, this is already safe with no extra change).
10. In `ManualBuildView.jsx` (line 177 `onEdit={s => onEditSlot(s)}`, and line 143 `onEdit={() => {}}` for the unavailable/empty case) — same rename pattern: replace with `onPlace`/`onCreateNew`/`eligibleActivities={eligibleActivitiesFor(groupId)}` on line 177's cell (the real, editable one); line 143's `onEdit={() => {}}` cell can simply omit the new props (defaults to `eligibleActivities = []`, harmless).

11. Run the full component test suite: `npx vitest run --no-file-parallelism src/components/schedule src/screens/schedule`. Fix any prop-shape mismatches the three view test files surface.

12. Commit: `git add -A && git commit -m "Inline-write cell editor: typeahead over eligible activities, Enter-to-place, Escape-to-cancel"`.

*(`onPlace`/`onCreateNew`'s actual wiring at the ScheduleScreen level — calling `replaceSlot`/`placeActivityManual`/`createActivityFromCell` — is Task 6. This task only gets the editor mounting, typing, filtering, and calling its callbacks with the right arguments; the callbacks themselves can be `vi.fn()`-shaped stand-ins passed down from `ScheduleScreen.jsx` as a temporary `console.warn('TODO Task 6')`-free no-op that still satisfies the component contract — see Task 6 step 1 for the actual wiring. To keep this task's commit fully functional rather than a stub, wire the SIMPLEST correct version now: `onPlace` calls `placeActivityManual` when the target is empty and `replaceSlot` when occupied — exactly dragHandlers.js's existing branching — and `onCreateNew` calls a placeholder that just does nothing but is replaced in Task 6. Re-read: since Task 6 needs to exist as its own reviewable diff, prefer wiring `onPlace` fully now, in this task, since it needs no new mutation — reuses `placeActivityManual`/`replaceSlot`, both already present — and defer ONLY `onCreateNew` to Task 6.)*

**Revised step 9-10 addendum:** wire `onPlace` for real in this task (Task 5), since it needs nothing new:
```js
// In ScheduleScreen.jsx, next to eligibleActivitiesFor:
function handleCellPlace(slot, activityId) {
  const groupId = slot.groupId ?? slot.group_id
  const dayId = slot.dayId ?? slot.day_id
  const blockId = slot.blockId ?? slot.time_block_id
  const targetSlot = getSlot(slots, groupId, dayId, blockId)
  if (targetSlot?.activity_id) {
    replaceSlot({ activityId }, { groupId, dayId, blockId })
  } else {
    placeActivityManual(activityId, groupId, dayId, blockId)
  }
}
```
Pass `onPlace={handleCellPlace}` down through the three views. Leave `onCreateNew` passed as `onCreateNew={handleCellCreateNew}` where `handleCellCreateNew` is defined trivially in THIS task as a thin forward to a not-yet-existing `createActivityFromCell` — since Task 6 adds that function to `useSlotMutations`, either sequence Task 6 before finishing this wiring, OR (preferred, keeps tasks independently testable) stub `handleCellCreateNew` in this task as:
```js
function handleCellCreateNew(slot, name) {
  console.warn('create-new not yet implemented', name, slot)
}
```
and replace the stub body in Task 6 step 6. Note this stub in the commit message so it's traceable: `git commit -m "Inline-write cell editor: typeahead + Enter-to-place wired; create-new stubbed pending Task 6"`.

---

### Task 6 — `createActivityFromCell`: catalog write + usage-derived rule + palette appearance

**Files:**
- Modify: `src/screens/schedule/useSlotMutations.js`
- Modify: `src/screens/schedule/useSlotMutations.test.js`
- Modify: `src/screens/ScheduleScreen.jsx` (replace the Task 5 stub)

**Interfaces:**
```js
// Consumes (new injections into useSlotMutations, added to its existing param object):
//   campId: string  — needed for the new activities row's camp_id column
//
// Produces:
async function createActivityFromCell(name, target)
// name: string (already trimmed by CellInlineEditor before calling onCreateNew)
// target: { groupId, dayId, blockId }
//
// Behavior:
//   1. Normalized dup-name check against `activities` (case/space-insensitive, via normalizeName) --
//      if it collapses to an existing activity, this function is NOT the path taken (CellInlineEditor
//      itself already resolves an exact-normalized match to onPlace, not onCreateNew -- Task 5's
//      `exact` check). createActivityFromCell therefore assumes its `name` is genuinely new, but
//      re-checks defensively (a second inline-write racing the same name between typing and Enter is
//      possible) and, if a race is detected, calls placeActivityManual with the now-existing id instead
//      of creating a duplicate -- never throws, never silently drops the director's Enter keystroke.
//   2. newId = crypto.randomUUID().
//   3. Write the new activities row via repo.writeActivityFields(newId, { name, camp_id: campId,
//      location: null, is_outdoor: false, max_groups_per_slot: 1, min_per_week: 1, max_per_week: null,
//      span_blocks: 1, same_tier_only: false, priority: 'normal', eligible_tier_ids: [],
//      eligible_group_ids: [], prefer_before_day: null, prefer_before_day_min: null,
//      weather_alternative_id: null, notes: null }) -- min_per_week: 1 because this call IS the
//      activity's first placement (the "usage-derived, self-calibrating" target -- see Approach note
--      below for why 1-at-creation is the chosen implementation of that spec requirement).
--      priority: 'normal' -- addActivityQuick in ActivitiesScreen.jsx uses 'low' for its quick-add path;
--      this plan uses 'normal' because "normal/default priority" is the spec's literal wording -- confirm
--      this against ActivitiesScreen.jsx's priority enum before implementing (see Task 6 step 0 below).
//   4. On success: setActivities(prev => [...prev, newRow]) so the palette picks it up on the next
//      render (no reload needed -- mirrors placeActivityManual's local-state-first pattern, NOT
--      addActivityQuick's full `await load()` reload, because this is a hot single-cell path, not a
--      settings screen).
//   5. Then call placeActivityManual(newId, target.groupId, target.dayId, target.blockId) to place it
//      into the originating cell -- reuses the EXISTING placement mutation rather than duplicating its
//      slot-write + undo + recalc logic. This means creating an activity produces TWO undo-stack
//      entries (create, then place) rather than one atomic entry -- flagged as an open question for
--      Governor below, since the spec does not specify undo granularity for this path.
//   6. On the activities-write failure: setActionError(...), do not call placeActivityManual.
```

**Steps:**

0. Before writing code, resolve the `priority` enum question by reading how `priority` is consumed elsewhere: `grep -n "priority ===" src/screens/schedule/useSlotMutations.js src/utils/*.js` — `EditModal.jsx` (now deleted) checked `a.priority === 'high'`; `ActivitiesScreen.jsx`'s `addActivityQuick` writes `'low'`. Confirm there are exactly two/three valid values (`'high' | 'low'` or `'high' | 'normal' | 'low'`) by checking `resolveFieldWrite` in `fieldUpdate.js` (already read: line 112–117 validates only `'high'`/`'low'` — there is NO `'normal'` value in the schema's actual validation). **Decision: use `priority: null`** (not `'normal'`, which `resolveFieldWrite` would reject as invalid if this activity is ever re-validated through that path) to mean "default priority" — this matches `swapSlots`/`placeActivityManual`'s existing convention of leaving unset fields `null` rather than inventing a third enum value. Flag this correction in the Spec Coverage Check below (the spec's "normal ... priority" phrasing is satisfied by `null`, i.e. "no priority boost", not a literal string).

1. Write the failing test first, appended to `src/screens/schedule/useSlotMutations.test.js`:

```js
describe('useSlotMutations — createActivityFromCell', () => {
  it('creates a camp-scoped activity with usage-derived rule (min_per_week=1, max=null, all-groups eligible), adds it to the palette list, and places it', async () => {
    const slots = [
      { id: 'row-target', group_id: 'g1', day_id: 'd1', time_block_id: 'b1', activity_id: null, flags: {}, is_anchor: false },
    ]
    const { hook, props } = setup({ slots, activities: [], campId: 'camp-1', groups: [{ id: 'g1', tier_id: 't1' }] })
    await act(async () => {
      await hook.result.current.createActivityFromCell('Kayaking', { groupId: 'g1', dayId: 'd1', blockId: 'b1' })
    })
    const createCall = props.repo.writeActivityFields.mock.calls[0]
    expect(createCall[1]).toMatchObject({
      name: 'Kayaking', camp_id: 'camp-1', min_per_week: 1, max_per_week: null,
      eligible_tier_ids: [], eligible_group_ids: [], priority: null,
    })
    expect(props.setActivities).toHaveBeenCalled()
    // placeActivityManual's own write follows — assert the slot write landed too:
    expect(props.repo.writeSlotFields).toHaveBeenCalledWith('row-target', expect.objectContaining({ activity_id: createCall[0] }))
  })

  it('a name that collapses (case/space-insensitive) to an existing activity places the existing one instead of creating a duplicate', async () => {
    const slots = [
      { id: 'row-target', group_id: 'g1', day_id: 'd1', time_block_id: 'b1', activity_id: null, flags: {}, is_anchor: false },
    ]
    const { hook, props } = setup({
      slots, campId: 'camp-1', groups: [{ id: 'g1', tier_id: 't1' }],
      activities: [{ id: 'act-existing', name: 'Kayaking', eligible_tier_ids: [], eligible_group_ids: [] }],
    })
    await act(async () => {
      await hook.result.current.createActivityFromCell('  kayaking  ', { groupId: 'g1', dayId: 'd1', blockId: 'b1' })
    })
    expect(props.repo.writeActivityFields).not.toHaveBeenCalled()
    expect(props.repo.writeSlotFields).toHaveBeenCalledWith('row-target', expect.objectContaining({ activity_id: 'act-existing' }))
  })

  it('does not place when the activity write fails', async () => {
    const slots = [
      { id: 'row-target', group_id: 'g1', day_id: 'd1', time_block_id: 'b1', activity_id: null, flags: {}, is_anchor: false },
    ]
    const repo = makeRepo({ writeActivityFields: vi.fn(async () => { throw new Error('boom') }) })
    const { hook, props } = setup({ slots, campId: 'camp-1', groups: [{ id: 'g1', tier_id: 't1' }], activities: [], repo })
    await act(async () => {
      await hook.result.current.createActivityFromCell('Kayaking', { groupId: 'g1', dayId: 'd1', blockId: 'b1' })
    })
    expect(props.setActionError).toHaveBeenCalled()
    expect(props.repo.writeSlotFields).not.toHaveBeenCalled()
  })
})
```
(`makeRepo` is already imported/defined at the top of the test file — reuse it, don't redefine.)

2. Run: expect failure (`createActivityFromCell is not a function`, plus `campId` not yet an accepted prop).

3. Implement in `src/screens/schedule/useSlotMutations.js`:
   - Add `campId` to the destructured params (line 25–42 block): `campId,` alongside `timeBlocks,`.
   - Add near the bottom of the file, before the `return { ... }` statement:
```js
  async function createActivityFromCell(name, target) {
    const trimmed = String(name ?? '').trim()
    if (!trimmed) return

    const dupe = activities.find(a => normalizeName(a.name) === normalizeName(trimmed))
    if (dupe) {
      await placeActivityManual(dupe.id, target.groupId, target.dayId, target.blockId)
      return
    }

    const newId = crypto.randomUUID()
    const newRow = {
      id: newId,
      name: trimmed,
      camp_id: campId,
      priority: null,
      is_locked: false,
      span_blocks: 1,
      location: null,
      is_outdoor: false,
      max_groups_per_slot: 1,
      // Usage-derived: this write IS the activity's first placement, so the
      // target starts at 1 — never a spurious under-served flag on the week
      // it was hand-created for. Placing it again later simply exceeds the
      // met target quietly (ActivityPalette already renders count > target
      // as "met", never as a flag); it does not chase every future count.
      min_per_week: 1,
      max_per_week: null,
      same_tier_only: false,
      eligible_tier_ids: [],
      eligible_group_ids: [],
      prefer_before_day: null,
      prefer_before_day_min: null,
      weather_alternative_id: null,
      notes: null,
    }

    setActionError(null)
    try {
      const { id: _id, ...fields } = newRow
      await repo.writeActivityFields(newId, fields)
    } catch (err) {
      setActionError(describeWriteFailure(err, 'That activity could not be created.'))
      return
    }

    setActivities(prev => [...prev, newRow])
    await placeActivityManual(newId, target.groupId, target.dayId, target.blockId)
  }
```
   - Add the import: `import { normalizeName } from '../../ingest/preview.js'` at the top of the file.
   - Add `createActivityFromCell,` to the returned object.

4. Run the test file — expect green. Run the full suite once more: `npx vitest run --no-file-parallelism`.

5. Wire `campId` into `useSlotMutations`'s call site in `ScheduleScreen.jsx` (line 202–207 block) — add `campId,` to the props passed (the screen already has `campId` in scope from its own props/state — confirm with `grep -n "campId" src/screens/ScheduleScreen.jsx | head -5`).

6. Replace the Task 5 stub in `ScheduleScreen.jsx`:
```js
function handleCellCreateNew(slot, name) {
  const groupId = slot.groupId ?? slot.group_id
  const dayId = slot.dayId ?? slot.day_id
  const blockId = slot.blockId ?? slot.time_block_id
  createActivityFromCell(name, { groupId, dayId, blockId })
}
```
and destructure `createActivityFromCell` from `slotMutations` alongside `replaceSlot` (line 209).

7. Run the full suite: `npx vitest run --no-file-parallelism`.

8. Commit: `git add -A && git commit -m "createActivityFromCell: usage-derived rule, human provenance via existing write path, immediate palette appearance"`.

---

### Task 7 — Dup-name-collapses-to-match: end-to-end confirmation at the `CellInlineEditor` boundary

**Files:**
- Modify: `src/components/schedule/CellInlineEditor.test.jsx` (already covers this at the component level — Task 5 step 1 included it)
- Modify: `src/screens/schedule/useSlotMutations.test.js` (already covers this at the mutation level — Task 6 step 1 included it)
- No new production code expected.

This task is a verification pass, not new implementation: the dup-name rule is enforced at TWO layers by design (defense in depth, per Task 6's interface note about a possible race) — `CellInlineEditor`'s `exact` check (Task 5) stops the common case before `onCreateNew` is ever called, and `createActivityFromCell`'s own `normalizeName` check (Task 6) stops the race case. Confirm both are exercised and both pass; if either is missing, that's the gap to close, not new design.

**Steps:**

1. Run both test files together: `npx vitest run --no-file-parallelism src/components/schedule/CellInlineEditor.test.jsx src/screens/schedule/useSlotMutations.test.js`.

2. If both pass (expected, since Tasks 5 and 6 already wrote these cases), no code changes are needed — this task's "commit" is a no-op checkpoint. Do not commit an empty diff; instead, note in the final report that Task 7's coverage was folded into Tasks 5–6, per the Spec Coverage Check below.

---

### Task 8 — Accessibility / keyboard note: confirm the inline editor is the click-to-cell keyboard path

**Files:**
- Modify: `src/components/schedule/SlotCell.test.jsx`
- Modify: `src/components/schedule/ScheduleGridKeyboardNav.test.jsx` (read first — it may already assert Enter-on-a-focused-cell behavior that needs updating now that Enter opens the inline editor rather than the modal)

**Interfaces:** none new. This task verifies the existing roving-tabindex keyboard navigation (T59, referenced in `SlotCell.jsx`'s comments at lines 142–148) still reaches a focused cell, and that pressing Enter on a focused (not clicked) cell also activates inline write — closing the exact gap the spec's Testing Seams section names: *"Accessibility: click-to-write gives the cell a keyboard path (the previous concern about a dead cell is resolved by inline write)."*

**Steps:**

1. Read `src/components/schedule/ScheduleGridKeyboardNav.test.jsx` in full: `grep -n "Enter\|onEdit\|onActivate" src/components/schedule/ScheduleGridKeyboardNav.test.jsx`. Determine whether it currently asserts an Enter keypress on a focused cell calls `onEdit` (modal open) — if so, this is the exact test to update.

2. If `SlotCell.jsx`'s shell element has no `onKeyDown` handler today (check: `grep -n "onKeyDown" src/components/schedule/SlotCell.jsx` — expect none, since dnd-kit's keyboard sensor owns keydown per the file's own header comment at lines 142–148, and clicking was the only way in), add one: an Enter or Space keydown on the cell shell (when not locked, not `onSelect`-mode, not anchor/unavailable) should do the same thing `handleClick` does — call `setEditing(true)`. Add:
```js
  function handleKeyDown(e) {
    if (e.key !== 'Enter' && e.key !== ' ') return
    // Only when the cell itself has focus (not while a drag's keyboard sensor
    // or the inline editor's own input owns the keystroke) — dnd-kit's sensor
    // calls preventDefault on the keys it consumes for drag, so this only
    // fires for a genuine "I focused this cell and pressed Enter to edit it."
    if (editing) return
    e.preventDefault()
    triggerPress()
    if (isLocked) { onRelease?.(slot); return }
    if (onSelect) return
    setEditing(true)
  }
```
   add `onKeyDown={handleKeyDown}` to the cell shell's props (same element that has `onClick={handleClick}`).

3. Write/update the test in `SlotCell.test.jsx`:
```jsx
it('Enter on a focused, unlocked activity cell activates inline write', () => {
  render(<SlotCell slot={{ groupId: 'g1', dayId: 'd1', blockId: 'b1', type: 'activity', activity_id: 'act-1' }}
    activity={{ id: 'act-1', name: 'Swim' }} isDndEnabled
    eligibleActivities={[{ id: 'act-1', name: 'Swim' }]} onPlace={vi.fn()} onCreateNew={vi.fn()} />)
  const cell = screen.getByRole('gridcell')
  cell.focus()
  fireEvent.keyDown(cell, { key: 'Enter' })
  expect(screen.getByRole('textbox')).toBeInTheDocument()
})
```

4. Update `ScheduleGridKeyboardNav.test.jsx` if step 1 found a stale `onEdit`-modal assertion — repoint it to assert the inline editor mounts (or that `onPlace`/`onCreateNew` props are reachable), following that file's existing render/assertion pattern.

5. Run: `npx vitest run --no-file-parallelism src/components/schedule/SlotCell.test.jsx src/components/schedule/ScheduleGridKeyboardNav.test.jsx`.

6. Run the FULL suite one final time before considering the feature done: `npx vitest run --no-file-parallelism`.

7. Commit: `git add -A && git commit -m "Inline-write keyboard path: Enter on a focused cell activates the editor (closes the dead-cell accessibility gap)"`.

---

## Self-Review

### Spec Coverage Check

| Spec requirement | Task(s) | Notes |
|---|---|---|
| Drag from palette → empty slot places | Task 3 (dragHandlers) | reuses existing `placeActivityManual` |
| Drag from palette → occupied slot replaces | Task 3 | new branch in `dragHandlers.commit`, routes to `replaceSlot` |
| Drag grid card → another slot moves; occupied target replaces | Task 1, Task 3 | `replaceSlot`'s grid-to-grid path |
| Drag grid card → palette clears the source | **GAP — closed below** | see note |
| Anchors not valid targets/sources | Task 1 (`replaceSlot` refuses anchor targets), Task 3 (dragHandlers refuses `slotB.is_anchor`) | source-side: `placeActivityManual`/`replaceSlot` never read from an anchor because `SlotCell`'s `canDrag` already excludes `slot?.type !== 'activity'` (anchors render via the separate `type === 'anchor'` branch with no `useDraggable` at all — confirmed at HEAD, `SlotCell.jsx` line 130, 136-140) |
| Static ghost + dimmed occupant, no motion, data-attribute only | Task 3 | `data-drag-replace` + CSS `::after`/opacity rule |
| Click cell → inline write, typeahead over eligible | Task 5 | `CellInlineEditor` + `eligibleActivitiesFor` |
| Enter places/replaces top match | Task 5 | `commitTop()` |
| No-match → create-new, human provenance, usage-derived rule, all-groups, any role, appears in palette | Task 6 | provenance is free (existing `write()` default), role is free (existing permission matrix) |
| Placing existing activity never creates/changes a rule | Task 5 (`onPlace` only ever calls `placeActivityManual`/`replaceSlot`, never touches `activities`) | implicit — no code path from `onPlace` writes to the `activities` table |
| Escape/blur cancels | Task 5 | `CellInlineEditor`'s `onCancel` |
| Dup-name collapses to match | Task 5 (component layer) + Task 6 (mutation-layer defense in depth) + Task 7 (verification) | |
| Counts/flags update same beat | Task 1, Task 3, Task 6 (`recalcStats`/`recalcFindings` called inside every mutation) | |
| EditModal removed | Task 4 | |
| DisplacedPalette removed | Task 2 | |
| Accessibility keyboard path | Task 8 | |
| No engine/DnD-activation/snapshot changes | all tasks | verified no task touches `electron/`'s engine, `PointerSensor` activation distance, or snapshot code |
| No swap | Task 1 | `swapSlots` deleted outright, not renamed-and-kept |
| Weather-alt per-slot swap deferred | n/a | correctly out of scope — no task touches `weather_alternative_id`'s per-slot swap UI (only reads it defensively as `null` on create) |

**Gap found and closed:** the spec's interaction model item 3 ("Drag grid card → palette. Clears the slot") has no explicit task step. Tracing it through the current machinery: `resolveHit` (in `useDragFSM.js`) returns `null` when `elementFromPoint` finds no `[data-cell-key]` ancestor — which is exactly what happens when the pointer is released over the sidebar/palette DOM, since `ActivityPalette`'s items carry `data-palette-activity`, not `data-cell-key`. A `null` hit makes `dragFSM`'s `POINTER_UP` handler in the `DRAGGING` state take the `!isValidHit(finalHit)` branch (`dragFSM.js` lines 109–113), which tears down and returns to `Idle` **without calling `commit` at all** — so today, dragging a grid card out to the palette and releasing does *nothing*, not even a clear. This is a real gap: closing it needs a small addition to Task 3, not a new task (folding it in keeps the task list at 8, matching the "smallest responsible" instruction rather than adding a Task 9 for one missing branch).

**Fix, folded into Task 3 step 8** (add this to `dragHandlers.js`'s `commit`, and a matching addition to `useDragFSM.js`'s `onDragEnd`): `onDragEnd` in `useDragFSM.js` should check, when `resolveHit` returns `null`, whether the release point is over an element with `[data-palette-activity]` or the palette's container (add a `data-activity-palette` attribute to `ActivityPalette.jsx`'s root div as a cheap, additive change — one new `data-` attribute, not a prop/behavior change, so it does not need its own task) — if so, dispatch a distinct `hit` shape `{ toPalette: true, valid: true }` instead of `null`, so `isValidHit` accepts it and `POINTER_UP` proceeds to `commit`. `dragHandlers.commit` then gets one more branch, checked before the grid-to-grid `isValidHit`-style logic: `if (hit.toPalette) { if (data.slot) clearSourceOnly(data.slot) ; return }`, where `clearSourceOnly` is a two-line addition to `useSlotMutations.js` (or, simpler and reusing existing code exactly: call `releaseCell`-shaped logic is wrong since that sets `is_released`, not what's wanted — instead add a tiny `clearSlot(source)` sibling to `replaceSlot` in Task 1, OR, simplest of all per karpathy-guidelines, express "clear source" as `replaceSlot({ activityId: null }, source)` reusing `replaceSlot` itself with a `null` incoming id, since `replaceSlot`'s target-write already handles `activity_id: null` correctly as a value — verify `repo.writeSlotFields(targetRow.id, { activity_id: null, flags: {} })` is valid, which it is, matching `editSlotSave`'s existing `nextActivityId = newActivityId || null` pattern). **Concretely: Task 3 step 8's `commit` gains, before the palette-drop and grid-to-grid branches:**
```js
if (hit.toPalette) {
  if (data.slot) replaceSlot({ activityId: null }, { groupId: data.slot.groupId, dayId: data.slot.dayId, blockId: data.slot.blockId })
  return
}
```
This is folded into Task 3's implementation step and its test list (add one test: `'dragging a grid card onto the palette clears the source slot'`, asserting `replaceSlot` called with `{ activityId: null }`). No standalone task needed — noted here so the gap is visibly closed rather than silently absorbed.

### Placeholder scan

No task contains "similar to Task N", "add error handling" (without specifying which), "TODO" left unresolved at task end, or any elided code block. The one deliberate, explicitly-labeled stub (Task 5's `handleCellCreateNew` placeholder, replaced in Task 6 step 6) is called out by name in both tasks' text and its commit message says "stubbed" — not hidden.

### Type-consistency check

- `replaceSlot(incoming, target)` — named identically in `useSlotMutations.js` (defined, Task 1), `dragHandlers.js` (consumed, Task 3), `ScheduleScreen.jsx` (destructured + passed into `dragDeps` and `handleCellPlace`, Tasks 3/5). No file calls it `replaceActivity` or `doReplace`.
- `createActivityFromCell(name, target)` — named identically in `useSlotMutations.js` (defined, Task 6) and `ScheduleScreen.jsx` (Task 6 step 6). Not aliased.
- `eligibleActivitiesFor(groupId)` — defined once in `ScheduleScreen.jsx` (Task 5), threaded by the same name as a value (not re-derived) into `ManualBuildView`/`ScheduleGroupView`/`ScheduleDayView`'s per-cell `eligibleActivities` prop.
- `CellInlineEditor`'s props (`eligibleActivities`, `currentActivityName`, `onPlace`, `onCreateNew`, `onCancel`) match `SlotCell.jsx`'s prop names 1:1 where `SlotCell` forwards them (Task 5).
- `data-drag-replace` / `data-drag-ghost-label` are the only two new DOM attributes introduced; both are written and cleared in the same two places (`paintTarget`/`clearTarget` in `useDragFSM.js`), matching the existing `data-drag-over`/`data-drop-edge`/`data-drag-kind` pair's lifecycle exactly — no attribute is set without a corresponding removal.
- `allowSwap` is fully retired: removed from `makeDragHandlers`'s param object (Task 3), removed from both call sites in `ScheduleScreen.jsx` (Task 3), removed from `dragHandlers.test.js`'s `baseDeps()` (Task 3). `grep -rn "allowSwap"` should return zero hits after Task 3's commit — add this grep as a final check in Task 3 step 13.

---

## Open questions for Governor

1. **Undo granularity for create-new.** Task 6's `createActivityFromCell` calls `repo.writeActivityFields` then `placeActivityManual`, producing two separate undo-stack entries (one to undo the placement, a second undo to "un-create" the activity — except `placeActivityManual`'s undo only clears the slot, it does NOT delete the activities row, so undoing twice leaves an orphaned, unplaced, human-provenance activity sitting in the palette forever). Is that acceptable, or should create-new be a single atomic undo entry that also deletes the row on undo? The spec doesn't say. This plan ships the two-entry, no-auto-delete-on-undo version because it reuses `placeActivityManual` verbatim (smallest responsible change) — flag if the director-facing behavior ("undo once, the whole create-and-place goes away") is actually required.

2. **`priority: null` vs. a literal `'normal'` string.** The spec's exact wording is "normal/default priority." This plan resolves that to `priority: null` because `resolveFieldWrite` in `fieldUpdate.js` only validates `'high'`/`'low'` as legal values and there is no `'normal'` enum member anywhere in the schema — `null` is this codebase's actual "no priority set" convention. Confirm this reading is correct before Maker starts Task 6, since it's a judgment call resolving an ambiguity in the spec's prose against the DB's real constraint, not a pure implementation detail.

3. **Task 4/5 split leaves one commit where clicking a cell does nothing.** Called out explicitly in Task 4's steps — acceptable for incremental review, but if the team wants every commit to leave the app fully usable, squash Tasks 4 and 5 before merging (or execute them in the same PR without an intermediate push to a shared branch).

4. **The drag-to-palette gap** (found during the Spec Coverage Check, folded into Task 3) means Task 3's scope is slightly larger than its original step-by-step implied — it now also needs `ActivityPalette.jsx` to gain one `data-activity-palette` attribute and `useDragFSM.js`'s `onDragEnd`/`resolveHit`-adjacent logic to recognize a palette-area release as a distinct, valid, commit-worthy hit. This is small (three files, one attribute, one new hit shape) but worth Governor's explicit sign-off since it wasn't in the original task breakdown handed to Architect.
