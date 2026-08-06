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
  timeBlocks, days, slots, actMap, getSlot,
  expandSlot, placeActivityManual, swapSlots,
  allowSwap,
}) {
  // A cell was a swap target only when it rendered a SlotCell — i.e. a slot row
  // exists and it is neither an anchor nor the `unavailable` kind. An empty cell
  // never was one, and this ticket does not add that capability.
  function isSwapTarget(slot) {
    if (!slot || slot.is_anchor) return false
    const unfillable = Boolean(slot.flags?.UNFILLABLE) && !slot.flags?.UNFILLABLE_dismissed
    return Boolean(slot.activity_id) || unfillable
  }

  function commit(active, hit) {
    if (!active || !hit) return

    const data = active.data.current || {}
    const { groupId, dayId, blockId } = hit

    if (data.expandDrag) {
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
      placeActivityManual(data.paletteActivity.id, groupId, dayId, blockId)
      return
    }

    if (!allowSwap) return

    const slotA = data.slot
    if (!slotA) return
    if (slotA.groupId === groupId && slotA.dayId === dayId && slotA.blockId === blockId) return

    const slotB = getSlot(slots, groupId, dayId, blockId)
    if (!isSwapTarget(slotB)) return

    swapSlots(
      { groupId: slotA.groupId, dayId: slotA.dayId, blockId: slotA.blockId, activityId: slotA.activity_id },
      { groupId, dayId, blockId, activityId: slotB.activity_id ?? null }
    )
  }

  return { commit }
}
