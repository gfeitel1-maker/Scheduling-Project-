// Pure grid geometry for the schedule grids. Extracted verbatim from
// ScheduleScreen.jsx (T29): given plain data (DB-shaped, normalizeSlots-normalized
// slot rows plus timeBlocks/groups), it
// answers "what goes in this cell and how tall is it". No React, no IPC, no
// closure over component state — every input is an explicit argument, which is
// what makes it directly unit-testable.

import { getSpanTailBlockIds } from '../../components/schedule/cellLabel'

export function getSlot(slots, groupId, dayId, blockId) {
  return slots.find(s => s.group_id === groupId && s.day_id === dayId && s.time_block_id === blockId)
}

// Returns true if this slot is a tail block of a multi-block anchor
// (i.e., the previous block for this group+day has the same anchor_id)
export function isAnchorTail(slots, timeBlocks, groupId, dayId, blockId) {
  const slot = getSlot(slots, groupId, dayId, blockId)
  if (!slot?.is_anchor || !slot?.anchor_id) return false
  const blockIdx = timeBlocks.findIndex(b => b.id === blockId)
  if (blockIdx <= 0) return false
  const prevSlot = getSlot(slots, groupId, dayId, timeBlocks[blockIdx - 1].id)
  return Boolean(prevSlot?.is_anchor && prevSlot?.anchor_id === slot.anchor_id)
}

// Returns how many consecutive blocks share the same anchor_id starting at blockId
export function getAnchorRowSpan(slots, timeBlocks, groupId, dayId, blockId) {
  const slot = getSlot(slots, groupId, dayId, blockId)
  if (!slot?.is_anchor || !slot?.anchor_id) return 1
  const startIdx = timeBlocks.findIndex(b => b.id === blockId)
  if (startIdx === -1) return 1
  let span = 1
  for (let i = startIdx + 1; i < timeBlocks.length; i++) {
    const nextSlot = getSlot(slots, groupId, dayId, timeBlocks[i].id)
    if (nextSlot?.is_anchor && nextSlot?.anchor_id === slot.anchor_id) {
      span++
    } else {
      break
    }
  }
  return span
}

export function isActivityTail(slots, groupId, dayId, blockId) {
  const slot = getSlot(slots, groupId, dayId, blockId)
  if (slot?.is_anchor || !slot?.activity_id) return false
  return slot.is_span_head === false
}

export function getActivityRowSpan(slots, timeBlocks, groupId, dayId, blockId) {
  const slot = getSlot(slots, groupId, dayId, blockId)
  if (!slot?.activity_id || slot.is_anchor) return 1
  const startIdx = timeBlocks.findIndex(b => b.id === blockId)
  if (startIdx === -1) return 1
  let span = 1
  for (let i = startIdx + 1; i < timeBlocks.length; i++) {
    const nextSlot = getSlot(slots, groupId, dayId, timeBlocks[i].id)
    if (nextSlot?.activity_id === slot.activity_id && nextSlot.is_span_head === false) {
      span++
    } else {
      break
    }
  }
  return span
}

// Binds the current data once so callers (the screen, the views) invoke the
// readers with just a cell coordinate — the same call shape they used when these
// were closures on the component. Pure: data in → a facade of bound pure fns out.
export function makeGridGeometry({ slots, timeBlocks }) {
  return {
    getSlot: (groupId, dayId, blockId) => getSlot(slots, groupId, dayId, blockId),
    isAnchorTail: (groupId, dayId, blockId) => isAnchorTail(slots, timeBlocks, groupId, dayId, blockId),
    getAnchorRowSpan: (groupId, dayId, blockId) => getAnchorRowSpan(slots, timeBlocks, groupId, dayId, blockId),
    isActivityTail: (groupId, dayId, blockId) => isActivityTail(slots, groupId, dayId, blockId),
    getActivityRowSpan: (groupId, dayId, blockId) => getActivityRowSpan(slots, timeBlocks, groupId, dayId, blockId),
  }
}

// Single source of the cell-decision branching that ScheduleGroupView and
// ScheduleDayView both ran inline (identically). Given a bound geometry facade
// and a cell coordinate, returns what to render; each view maps the descriptor
// to its own markup (SlotCell prop set) which genuinely
// differs. Returns one of:
//   { kind: 'skip' }                          — tail covered by a head's rowSpan
//   { kind: 'empty' }                         — droppable empty cell
//   { kind: 'slot', slot, rowSpan, cellType } — a SlotCell (anchor vs cellType
//                                               resolved by the view via slot.is_anchor)
export function decideCell(geometry, groupId, dayId, blockId) {
  const slot = geometry.getSlot(groupId, dayId, blockId)
  if (!slot) return { kind: 'empty' }
  if (slot.is_anchor && geometry.isAnchorTail(groupId, dayId, blockId)) return { kind: 'skip' }
  if (!slot.is_anchor && geometry.isActivityTail(groupId, dayId, blockId)) return { kind: 'skip' }

  // T108 Phase 2 (design §5.1) — a PULL override (applyDayOverrides stamps
  // is_overridden + is_pull) renders as a non-droppable PulledCell, never
  // EmptyCell: the director must see the group is intentionally pulled and
  // must not be able to drop into the cell. Placed after the span-tail skip
  // (a pulled span cell is never produced — applyDayOverrides refuses spans)
  // and before the normal empty/slot branches so it never falls into 'empty'.
  if (slot.is_overridden && slot.is_pull) return { kind: 'pulled', slot }

  const rowSpan = slot.is_anchor
    ? geometry.getAnchorRowSpan(groupId, dayId, blockId)
    : geometry.getActivityRowSpan(groupId, dayId, blockId)

  const isUnfillable = Boolean(slot.flags?.UNFILLABLE) && !slot.flags?.UNFILLABLE_dismissed
  // T105 — an elective cell (elective_set_id set, activity_id null under
  // T111's MUTUALLY_EXCLUSIVE_FIELDS invariant) has real content and must
  // render as a slot, never fall into the 'empty' droppable branch. Events
  // overlay placement Slice 1 (docs/adr/2026-08-22-events-overlay-
  // placement.md §3) extends this with event_id, same posture.
  const hasContent = Boolean(slot.activity_id) || Boolean(slot.elective_set_id) || Boolean(slot.event_id)
  if (!hasContent && !slot.is_anchor && !isUnfillable) return { kind: 'empty' }

  const cellType = !hasContent && !isUnfillable ? 'unavailable' : 'activity'
  return { kind: 'slot', slot, rowSpan, cellType }
}

// T107 cleanup — ManualBuildView and ScheduleGroupView each computed this same
// span-interaction data per activity cell (identical in both, per Maker's
// comparison). isMerged/hasMergeDown/spanTailBlockIds/onSplitAt/onExtendGrab
// are pure derivations of geometry + timeBlocks; onMergeDown is NOT included
// here because the two call sites differ (ManualBuildView also clears the
// T92 merge-hint flag) — callers build it themselves from the returned
// nextBlock/nextSlot.
//
// ADR 2026-08-21 §1/R-HIGH: flags.expanded is retired as a structural
// pointer — isMerged is "this row is a span head with >=1 tail", read off
// the chain, not a head-owned flag.
export function computeSpanCellProps({ geometry, selectedGroup, day, block, blockIndex, timeBlocks, rowSpan, slot, onSplitSlot, onSpanExtendStart }) {
  const immediateNextBlock = timeBlocks.find(b => b.sort_order === block.sort_order + 1)
  const immediateNextSlot = immediateNextBlock ? geometry.getSlot(selectedGroup, day.id, immediateNextBlock.id) : null
  const isMerged = immediateNextSlot?.is_span_head === false && immediateNextSlot?.activity_id === slot.activity_id

  // Merge-down always targets the block AFTER the span's current end
  // (rowSpan-chain-based) so a director can keep extending an already-merged
  // span to arbitrary N, not just once.
  const nextBlock = timeBlocks[blockIndex + rowSpan]
  const nextSlot = nextBlock ? geometry.getSlot(selectedGroup, day.id, nextBlock.id) : null
  const hasMergeDown = Boolean(nextBlock) && !nextSlot?.is_anchor && nextSlot?.is_span_head !== false

  const spanTailBlockIds = getSpanTailBlockIds(timeBlocks, blockIndex, rowSpan)

  const onSplit = isMerged && onSplitSlot ? () => onSplitSlot(selectedGroup, day.id, block.id) : undefined
  const onSplitAt = onSplitSlot
    ? (cutBlockId) => onSplitSlot(selectedGroup, day.id, block.id, undefined, cutBlockId)
    : undefined
  const onExtendGrab = hasMergeDown && onSpanExtendStart
    ? () => onSpanExtendStart(selectedGroup, day.id, block.id, slot.activity_id)
    : undefined

  return { isMerged, nextBlock, nextSlot, hasMergeDown, spanTailBlockIds, onSplit, onSplitAt, onExtendGrab }
}
