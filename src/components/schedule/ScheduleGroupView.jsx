import { useState } from 'react'
import { DndContext, PointerSensor, useSensor, useSensors, useDroppable } from '@dnd-kit/core'
import SlotCell, { emptyTd } from '../schedule/SlotCell'
import OverlayCell from '../schedule/OverlayCell'
import { S } from '../../styles/shared'

function DroppableEmptyCell({ groupId, dayId, blockId }) {
  const { setNodeRef, isOver } = useDroppable({
    id: `grp-drop-${groupId}-${dayId}-${blockId}`,
    data: { groupId, dayId, blockId },
  })
  return (
    <td
      ref={setNodeRef}
      style={{
        ...emptyTd,
        background: isOver ? 'var(--primary)22' : 'transparent',
        outline: isOver ? '2px dashed var(--primary)' : 'none',
        outlineOffset: -2,
        transition: 'background 0.1s',
        borderRadius: 6,
      }}
    />
  )
}


export default function ScheduleGroupView({
  groups, days, timeBlocks, selectedGroup, onSelectGroup,
  weatherMode, stampMode, actMap, anchorMap,
  overlayForCell, isOverlayHead, getOverlayRowSpan,
  isAnchorTail, getAnchorRowSpan,
  isActivityTail, getActivityRowSpan,
  handleFillEnter, startFill, removeOverlay, handleStampClick,
  onEditSlot, fillState,
  getSlot,
  onExpandSlot,
  onPlaceActivity,
}) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }))
  const [isExpandDragActive, setIsExpandDragActive] = useState(false)

  function handleDragStart({ active }) {
    if (active.data.current?.expandDrag) setIsExpandDragActive(true)
  }

  function handleDragEnd({ active, over }) {
    setIsExpandDragActive(false)
    if (!over) return

    const expandDrag = active.data.current?.expandDrag
    const paletteActivity = active.data.current?.paletteActivity

    if (expandDrag) {
      const { groupId, dayId, blockId: headBlockId } = expandDrag
      const overData = over.data.current || {}
      // Support both DroppableEmptyCell data ({ groupId, dayId, blockId })
      // and SlotCell droppable data ({ slot: { groupId, dayId, blockId } })
      const tailBlockId = overData.blockId || overData.slot?.blockId
      const tailGroupId = overData.groupId || overData.slot?.groupId
      const tailDayId = overData.dayId || overData.slot?.dayId

      if (!tailBlockId || tailGroupId !== groupId || tailDayId !== dayId) return

      // Verify the over block is directly below the head block (consecutive sort_order)
      const headBlock = timeBlocks.find(b => b.id === headBlockId)
      const tailBlock = timeBlocks.find(b => b.id === tailBlockId)
      if (!headBlock || !tailBlock) return
      if (tailBlock.sort_order !== headBlock.sort_order + 1) return

      // Verify the tail cell has an activity to displace
      const tailSlot = getSlot(groupId, dayId, tailBlockId)
      if (!tailSlot || !tailSlot.activity_id || tailSlot.is_anchor) return

      const tailActivity = actMap.get(tailSlot.activity_id)
      const tailBlockName = tailBlock.name
      const day = days ? days.find(d => d.id === dayId) : null
      const dayLabel = day ? day.label : dayId

      onExpandSlot(
        groupId,
        dayId,
        headBlockId,
        tailBlockId,
        tailSlot.activity_id,
        tailActivity?.name || '',
        tailBlockName,
        dayLabel,
      )
      return
    }

    if (paletteActivity && onPlaceActivity) {
      const overData = over.data.current || {}
      const { groupId, dayId, blockId } = overData
      if (!groupId || !dayId || !blockId) return
      const targetSlot = getSlot(groupId, dayId, blockId)
      if (targetSlot && targetSlot.activity_id) return
      onPlaceActivity(paletteActivity.id, groupId, dayId, blockId)
    }
  }

  return (
    <DndContext sensors={sensors} onDragStart={handleDragStart} onDragEnd={handleDragEnd} onDragCancel={() => setIsExpandDragActive(false)}>
      <div>
        {/* Group pills */}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
          {groups.map(g => (
            <button key={g.id} onClick={() => onSelectGroup(g.id)} style={{
              padding: '5px 12px', borderRadius: 20, border: `1.5px solid ${selectedGroup === g.id ? 'var(--primary)' : 'var(--border)'}`,
              background: selectedGroup === g.id ? 'var(--primary)' : 'var(--surface)',
              color: selectedGroup === g.id ? '#fff' : 'var(--text)',
              fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'var(--font-sans)',
            }}>{g.name}</button>
          ))}
        </div>

        {selectedGroup && (
          <div style={{ overflowX: 'auto' }}>
              <table style={{ borderCollapse: 'collapse', tableLayout: 'fixed', minWidth: 500, width: '100%', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden' }}>
                <thead>
                  <tr style={{ background: 'var(--surface-elevated)', borderBottom: '1.5px solid var(--border)' }}>
                    <th style={{ ...S.th, whiteSpace: 'nowrap', width: 140, position: 'sticky', top: 0, left: 0, background: 'var(--surface-elevated)', zIndex: 3 }}>Block</th>
                    {days.map(d => <th key={d.id} style={{ ...S.th, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', position: 'sticky', top: 0, background: 'var(--surface-elevated)', zIndex: 2 }}>{d.label}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {timeBlocks.map(block => (
                    <tr
                      key={block.id}
                      style={{ borderBottom: '1px solid var(--border)' }}
                      onPointerEnter={() => {
                        const b = timeBlocks.find(tb => tb.id === block.id)
                        if (b && fillState) handleFillEnter(b.sort_order)
                      }}
                    >
                      <td style={{ padding: '10px 14px', verticalAlign: 'middle', whiteSpace: 'nowrap', position: 'sticky', left: 0, background: 'var(--surface)', zIndex: 1, borderRight: '1px solid var(--border)' }}>
                        <div style={{ fontFamily: 'var(--font-condensed)', fontWeight: 600, fontSize: 14, color: 'var(--text)' }}>{block.name}</div>
                        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-secondary)', marginTop: 2 }}>{block.start_time?.slice(0,5)}–{block.end_time?.slice(0,5)}</div>
                      </td>
                      {days.map(day => {
                        // Overlay check — takes priority over schedule slot
                        const overlay = overlayForCell(selectedGroup, day.id, block.id)
                        if (overlay && !isOverlayHead(selectedGroup, day.id, block.id)) return null // tail — covered by head rowSpan
                        if (overlay && isOverlayHead(selectedGroup, day.id, block.id)) {
                          const rowSpan = getOverlayRowSpan(overlay)
                          return (
                            <OverlayCell
                              key={day.id}
                              label={overlay.label}
                              rowSpan={rowSpan}
                              onRemove={() => removeOverlay(overlay.id)}
                              showFillHandle={true}
                              fillHandleDirection="vertical"
                              onFillStart={() => startFill(overlay)}
                            />
                          )
                        }

                        const slot = getSlot(selectedGroup, day.id, block.id)
                        if (!slot) return <DroppableEmptyCell key={day.id} groupId={selectedGroup} dayId={day.id} blockId={block.id} />
                        if (slot.is_anchor && isAnchorTail(selectedGroup, day.id, block.id)) return null
                        if (!slot.is_anchor && isActivityTail(selectedGroup, day.id, block.id)) return null
                        const rowSpan = slot.is_anchor
                          ? getAnchorRowSpan(selectedGroup, day.id, block.id)
                          : getActivityRowSpan(selectedGroup, day.id, block.id)
                        const act = slot.activity_id ? actMap.get(slot.activity_id) : null
                        const anchor = slot.anchor_id ? anchorMap.get(slot.anchor_id) : null
                        const cellClickHandler = stampMode
                          ? () => handleStampClick(selectedGroup, day.id, block.id)
                          : undefined

                        // Empty slot (no activity) — render as droppable
                        if (!slot.activity_id && !slot.is_anchor) {
                          return <DroppableEmptyCell key={day.id} groupId={selectedGroup} dayId={day.id} blockId={block.id} />
                        }

                        return (
                          <SlotCell
                            key={day.id}
                            rowSpan={rowSpan}
                            slot={slot.is_anchor ? { ...slot, type: 'anchor', groupId: slot.group_id, dayId: slot.day_id, blockId: slot.time_block_id } : { ...slot, type: slot.activity_id || !slot.is_anchor ? 'activity' : 'unavailable', groupId: slot.group_id, dayId: slot.day_id, blockId: slot.time_block_id, flags: slot.flags || {} }}
                            activity={act}
                            anchor={anchor}
                            actColorIdx={act?.colorIdx || 0}
                            weatherMode={weatherMode}
                            onEdit={cellClickHandler || (s => onEditSlot(s))}
                            isExpandDragActive={isExpandDragActive}
                          />
                        )
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
        )}
      </div>
    </DndContext>
  )
}
