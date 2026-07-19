import { DndContext } from '@dnd-kit/core'
import SlotCell, { emptyTd } from '../schedule/SlotCell'
import OverlayCell from '../schedule/OverlayCell'
import { S } from '../../styles/shared'

export default function ScheduleDayView({
  groups, days, timeBlocks, selectedDay, onSelectDay,
  weatherMode, stampMode, actMap, anchorMap,
  sensors, swapSlots, lockActivity, releaseCell,
  overlayForCell, isOverlayHead, getOverlayRowSpan,
  isAnchorTail, getAnchorRowSpan,
  isActivityTail, getActivityRowSpan,
  handleFillEnter, startFill, removeOverlay, handleStampClick,
  onEditSlot, fillState,
  getSlot,
  onExpandSlot,
}) {
  return (
    <div>
      {/* Day pills */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
        {days.map(d => (
          <button key={d.id} onClick={() => onSelectDay(d.id)} style={{
            padding: '5px 16px', borderRadius: 20,
            border: `1.5px solid ${selectedDay === d.id ? 'var(--primary)' : 'var(--border)'}`,
            background: selectedDay === d.id ? 'var(--primary)' : 'var(--surface)',
            color: selectedDay === d.id ? '#fff' : 'var(--text)',
            fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'var(--font-sans)',
          }}>{d.label}</button>
        ))}
      </div>

      {selectedDay && (
        <DndContext
          sensors={sensors}
          onDragEnd={({ active, over }) => {
            if (!over) return

            const expandDrag = active.data.current?.expandDrag
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

            const slotA = active.data.current?.slot
            const slotB = over.data.current?.slot
            if (!slotA || !slotB) return
            if (slotA.groupId === slotB.groupId && slotA.dayId === slotB.dayId && slotA.blockId === slotB.blockId) return
            if (slotB.type === 'anchor' || slotB.type === 'unavailable') return
            swapSlots(
              { groupId: slotA.groupId, dayId: slotA.dayId, blockId: slotA.blockId, activityId: slotA.activity_id },
              { groupId: slotB.groupId, dayId: slotB.dayId, blockId: slotB.blockId, activityId: slotB.activity_id }
            )
          }}
        >
        <div style={{ overflowX: 'auto' }}>
          <table style={{ borderCollapse: 'collapse', tableLayout: 'fixed', width: '100%', minWidth: 140 + groups.length * 130, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden' }}>
            <thead>
              <tr style={{ background: 'var(--surface-elevated)', borderBottom: '1.5px solid var(--border)' }}>
                <th style={{ ...S.th, whiteSpace: 'nowrap', width: 140, position: 'sticky', top: 0, left: 0, background: 'var(--surface-elevated)', zIndex: 3 }}>Block</th>
                {groups.map(g => <th key={g.id} style={{ ...S.th, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', position: 'sticky', top: 0, background: 'var(--surface-elevated)', zIndex: 2 }}>{g.name}</th>)}
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
                  {groups.map(group => {
                    // Overlay check
                    const overlay = overlayForCell(group.id, selectedDay, block.id)
                    if (overlay && !isOverlayHead(group.id, selectedDay, block.id)) return null
                    if (overlay && isOverlayHead(group.id, selectedDay, block.id)) {
                      const rowSpan = getOverlayRowSpan(overlay)
                      return (
                        <OverlayCell
                          key={group.id}
                          label={overlay.label}
                          rowSpan={rowSpan}
                          onRemove={() => removeOverlay(overlay.id)}
                          showFillHandle={true}
                          fillHandleDirection="both"
                          onFillStart={() => startFill(overlay)}
                        />
                      )
                    }

                    const slot = getSlot(group.id, selectedDay, block.id)
                    if (!slot) return <td key={group.id} style={emptyTd} />
                    if (slot.is_anchor && isAnchorTail(group.id, selectedDay, block.id)) return null
                    if (!slot.is_anchor && isActivityTail(group.id, selectedDay, block.id)) return null
                    const rowSpan = slot.is_anchor
                      ? getAnchorRowSpan(group.id, selectedDay, block.id)
                      : getActivityRowSpan(group.id, selectedDay, block.id)
                    const act = slot.activity_id ? actMap.get(slot.activity_id) : null
                    const anchor = slot.anchor_id ? anchorMap.get(slot.anchor_id) : null
                    const actIsLocked = slot.activity_id && act?.is_locked
                    const isLocked = Boolean(actIsLocked && !slot.is_released)
                    const cellClickHandler = stampMode
                      ? () => handleStampClick(group.id, selectedDay, block.id)
                      : undefined
                    return (
                      <SlotCell
                        key={group.id}
                        rowSpan={rowSpan}
                        slot={slot.is_anchor
                          ? { ...slot, type: 'anchor', groupId: slot.group_id, dayId: slot.day_id, blockId: slot.time_block_id }
                          : { ...slot, type: 'activity', groupId: slot.group_id, dayId: slot.day_id, blockId: slot.time_block_id, flags: slot.flags || {} }}
                        activity={act}
                        anchor={anchor}
                        actColorIdx={act?.colorIdx || 0}
                        weatherMode={weatherMode}
                        onEdit={cellClickHandler || (s => onEditSlot(s))}
                        onLock={s => lockActivity(s.activity_id)}
                        onRelease={s => releaseCell(s.id)}
                        isLocked={isLocked}
                        isDndEnabled={!isLocked && !stampMode}
                      />
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        </DndContext>
      )}
    </div>
  )
}
