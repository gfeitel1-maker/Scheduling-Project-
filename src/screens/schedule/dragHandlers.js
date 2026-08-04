export function makeDragHandlers({
  timeBlocks, days, slots, actMap, getSlot,
  expandSlot, placeActivityManual, swapSlots,
  setExpandDragActive, allowSwap,
}) {
  function handleDragStart({ active }) {
    if (active.data.current?.expandDrag) setExpandDragActive(true)
  }

  function handleDragEnd({ active, over }) {
    setExpandDragActive(false)
    if (!over) return

    const expandDrag = active.data.current?.expandDrag
    const paletteActivity = active.data.current?.paletteActivity

    if (expandDrag) {
      const { groupId, dayId, blockId: headBlockId } = expandDrag
      const overData = over.data.current || {}
      const tailBlockId = overData.blockId || overData.slot?.blockId
      const tailGroupId = overData.groupId || overData.slot?.groupId
      const tailDayId = overData.dayId || overData.slot?.dayId

      if (!tailBlockId || tailGroupId !== groupId || tailDayId !== dayId) return

      const headBlock = timeBlocks.find(b => b.id === headBlockId)
      const tailBlock = timeBlocks.find(b => b.id === tailBlockId)
      if (!headBlock || !tailBlock) return
      if (tailBlock.sort_order !== headBlock.sort_order + 1) return

      const tailSlot = getSlot(slots, groupId, dayId, tailBlockId)
      if (!tailSlot || !tailSlot.activity_id || tailSlot.is_anchor) return

      const tailActivity = actMap.get(tailSlot.activity_id)
      const day = days.find(d => d.id === dayId)
      expandSlot(groupId, dayId, headBlockId, tailBlockId, tailSlot.activity_id, tailActivity?.name || '', tailBlock.name, day?.label ?? dayId)
      return
    }

    if (paletteActivity) {
      const d = over.data.current || {}
      const groupId = d.groupId ?? d.slot?.groupId
      const dayId = d.dayId ?? d.slot?.dayId
      const blockId = d.blockId ?? d.slot?.blockId
      if (!groupId || !dayId || !blockId) return
      const targetSlot = getSlot(slots, groupId, dayId, blockId)
      if (targetSlot?.is_anchor) return
      placeActivityManual(paletteActivity.id, groupId, dayId, blockId)
      return
    }

    if (!allowSwap) return

    const slotA = active.data.current?.slot
    const slotB = over.data.current?.slot
    if (!slotA || !slotB) return
    if (slotA.groupId === slotB.groupId && slotA.dayId === slotB.dayId && slotA.blockId === slotB.blockId) return
    if (slotB.type === 'anchor' || slotB.type === 'unavailable') return
    swapSlots(
      { groupId: slotA.groupId, dayId: slotA.dayId, blockId: slotA.blockId, activityId: slotA.activity_id },
      { groupId: slotB.groupId, dayId: slotB.dayId, blockId: slotB.blockId, activityId: slotB.activity_id }
    )
  }

  return { handleDragStart, handleDragEnd }
}
