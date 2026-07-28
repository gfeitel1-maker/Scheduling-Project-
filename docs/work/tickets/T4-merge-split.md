---
title: T4-merge-split
document_type: ticket
status: completed
created: 2026-07-26
governing_docs: [docs/governance/standards/ARCHITECTURE_STANDARD.md]
related_adrs: []
archive_when: with its parent spec, docs/work/specs/2026-07-26-manual-grid-editing.md
---

> **COMPLETED** — recorded Done in `docs/work/task-state/2026-07-26-manual-grid-editing-state.md`.

# T4 — Surface Merge-Down and Split in Grid

**Spec:** `docs/work/specs/2026-07-26-manual-grid-editing.md`  
**Risk:** Low-Moderate  
**Depends on:** T1 (layout stable), T2 (DnD context stable)  
**Blocks:** T5 (undo stack needs merge/split as known undoable actions)

---

## What to build

Surface the existing `expandSlot` (merge-down) function as a one-click button in the cell, and add a new `splitSlot` function that reverses a merge. Both are accessible via hover controls on SlotCell.

## Observable completion evidence

1. Hovering a filled, non-anchor, non-merged slot with a next-block sibling: a 16×16px `↕` button appears at `top: 4, right: 4` of the inner div. Clicking it calls `expandSlot` — the cell grows to span two blocks, the displaced activity appears in DisplacedPalette.
2. The merge button is NOT shown when there is no next block (last block of the day, or next slot is an anchor).
3. The existing ExpandHandle bottom-edge drag gesture still works and is unaffected by this change.
4. Hovering a merged cell (slot where `is_span_head !== false` and `flags.expanded` is set): a `↕` button appears at `top: 4, right: 4` with amber hover state (border + color shift to `var(--warning)`). Clicking it calls `splitSlot`.
5. After split: the tail block becomes an empty unassigned slot. If `flags.expanded.displacedActivityId` exists, it reappears in DisplacedPalette. The head slot returns to single-block height with `flags.expanded` removed.
6. Merge button and split button never appear on the same cell simultaneously.
7. Merge and split buttons do not trigger the cell's selection handler (`e.stopPropagation()` on click).

## New function in ScheduleScreen

```js
async function splitSlot(groupId, dayId, headBlockId) {
  if (!templateId) return
  const headSlot = slots.find(s =>
    s.group_id === groupId && s.day_id === dayId && s.time_block_id === headBlockId
  )
  if (!headSlot || !headSlot.flags?.expanded) return

  const { displacedActivityId, displacedActivityName, from_block: tailBlockId } = headSlot.flags.expanded
  const tailSlot = slots.find(s =>
    s.group_id === groupId && s.day_id === dayId && s.time_block_id === tailBlockId
  )
  if (!tailSlot) return

  const cleanedFlags = { ...headSlot.flags }
  delete cleanedFlags.expanded

  setActionError(null)
  try {
    await writeFields('template_slots', tailSlot.id, {
      activity_id: null,
      is_span_head: true,
      flags: {},
    })
    await writeFields('template_slots', headSlot.id, { flags: cleanedFlags })
  } catch {
    setActionError('Failed to split slot — check your connection and try again')
    return
  }

  setSlots(prev => prev.map(s => {
    if (s.group_id === groupId && s.day_id === dayId && s.time_block_id === tailBlockId)
      return { ...s, activity_id: null, is_span_head: true, flags: {} }
    if (s.group_id === groupId && s.day_id === dayId && s.time_block_id === headBlockId)
      return { ...s, flags: cleanedFlags }
    return s
  }))

  // Re-surface displaced activity in DisplacedPalette if metadata exists
  if (displacedActivityId && displacedActivityName) {
    const colorIdx = activities.findIndex(a => a.id === displacedActivityId)
    const tailBlock = timeBlocks.find(b => b.id === tailBlockId)
    const day = days.find(d => d.id === dayId)
    setDisplacedItems(prev => [
      ...prev,
      {
        activityId: displacedActivityId,
        activityName: displacedActivityName,
        fromBlockName: tailBlock?.name ?? '',
        dayLabel: day?.label ?? '',
        colorIdx: colorIdx >= 0 ? colorIdx : 0,
      },
    ])
  }
}
```

## Files expected to change

- `src/screens/ScheduleScreen.jsx` — add `splitSlot` function, pass `onSplitSlot` and `onMergeSlot` props down to views.
- `src/components/schedule/SlotCell.jsx` — add `hasMergeDown`, `isMerged`, `onMergeDown`, `onSplitSlot` props. Render merge button when `hasMergeDown && !isMerged`. Render split button when `isMerged`. Apply styles per Designer spec Section 5.2, 6.2 (`cellActionBtn` from shared.js, warning colors on split hover).
- `src/components/schedule/ManualBuildView.jsx` — compute `hasMergeDown` for each cell (next time block exists and is not an anchor), pass to SlotCell.
- `src/components/schedule/ScheduleGroupView.jsx` — same.
- `src/styles/shared.js` — add `cellActionBtn` style constant.

## Design spec reference

Designer spec Sections 5 (Merge-Down), 6 (Split).

## Test seam

- Unit: `splitSlot(groupId, dayId, headBlockId)` with a mock slot state — verify tail slot is written with `activity_id: null, is_span_head: true` and head slot loses `flags.expanded`. Verify DisplacedPalette entry is created when displacedActivityId is present.
- Unit: `splitSlot` with missing `flags.expanded` — verify early return, no write.
- Unit: `splitSlot` with null `displacedActivityId` — split succeeds, no DisplacedPalette entry added.
- Integration (dev mode): merge a slot via button, verify span appears; split via button, verify both slots independent.

## Notes

- Multi-block spans (3+): split removes `flags.expanded` from head and sets all tail slots to `activity_id: null, is_span_head: true`. Maker needs to find all tail slots (all slots for same group+day where `is_span_head = false`), not just the one stored in `flags.expanded.from_block`. Inspect the actual `slots` array for tails; `flags.expanded.from_block` only records the first tail in the current implementation.
- The merge button is separate from the ExpandHandle. Both should coexist — the handle is the DnD gesture (for multi-block merges); the button is the one-click single-block-down shortcut.
