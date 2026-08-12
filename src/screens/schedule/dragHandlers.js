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
  expandSlot, placeActivityManual, replaceSlot,
}) {
  function commit(active, hit) {
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
        replaceSlot({ activityId: null }, { groupId: data.slot.groupId, dayId: data.slot.dayId, blockId: data.slot.blockId })
      }
      return
    }

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
