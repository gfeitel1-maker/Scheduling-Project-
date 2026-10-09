// Thin adapter between the drag FSM's `commit` side effect and the op-log
// mutations. The FSM (dragFSM.js) owns gesture state; this file owns nothing but
// "given the dragged thing and the resolved target cell, which mutation".
//
// It takes a HIT ({ groupId, dayId, blockId }) rather than dnd-kit's `over`,
// because the target is now resolved from pointer coordinates against
// data-cell-key, not from a per-cell droppable. The eligibility checks below
// reproduce exactly what `useDroppable({ disabled })` plus the old
// `over.data.current.slot` shape used to reject.
export function makeDragHandlers({
  slots, getSlot,
  placeActivityManual, replaceSlot, placeElective,
}) {
  function commit(active, hit, gestureId) {
    if (!active || !hit) return

    const data = active.data.current || {}

    // A grid card dragged out and released over the ActivityPalette: the FSM
    // resolves this to a distinct `{ toPalette: true }` hit (not the usual
    // cell coordinates), so it is handled before anything reads groupId/dayId/
    // blockId off `hit`. Only a grid-card source clears — a palette-to-palette
    // release (e.g. a bare click that resolves as a drag) has no source slot
    // to clear, so it is a no-op.
    if (hit.toPalette) {
      if (data.slot) {
        replaceSlot({ activityId: null }, { groupId: data.slot.groupId, dayId: data.slot.dayId, blockId: data.slot.blockId }, gestureId)
      }
      return
    }

    const { groupId, dayId, blockId } = hit

    if (data.paletteActivity) {
      if (!groupId || !dayId || !blockId) return
      const targetSlot = getSlot(slots, groupId, dayId, blockId)
      if (targetSlot?.is_fixed_event) return
      if (targetSlot?.activity_id) {
        replaceSlot({ activityId: data.paletteActivity.id }, { groupId, dayId, blockId }, gestureId)
      } else {
        // placeActivityManual now goes through the same claim/chain/dispatch
        // path as replaceSlot/expandSlot/splitSlot (2026-08-12 ADR, FIX 1):
        // two empty-cell writers can still race the same cell. Its 5th
        // positional param is activityOverride, not gestureId — pass
        // `undefined` there and the gesture id as the 6th.
        placeActivityManual(data.paletteActivity.id, groupId, dayId, blockId, undefined, gestureId)
      }
      return
    }

    // Audit-2 A9: a reusable elective set dragged from the rail. It places by
    // name through the same path as picking it in the cell editor, which
    // resolves to the existing durable set.
    if (data.paletteElective) {
      if (!groupId || !dayId || !blockId) return
      if (getSlot(slots, groupId, dayId, blockId)?.is_fixed_event) return
      placeElective(data.paletteElective.name, { groupId, dayId, blockId })
      return
    }

    const slotA = data.slot
    if (!slotA) return
    if (slotA.groupId === groupId && slotA.dayId === dayId && slotA.blockId === blockId) return

    const slotB = getSlot(slots, groupId, dayId, blockId)
    if (!slotB || slotB.is_fixed_event) return

    replaceSlot(
      { groupId: slotA.groupId, dayId: slotA.dayId, blockId: slotA.blockId, activityId: slotA.activity_id },
      { groupId, dayId, blockId },
      gestureId
    )
  }

  return { commit }
}
