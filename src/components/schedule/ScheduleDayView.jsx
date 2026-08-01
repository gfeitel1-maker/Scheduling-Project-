import { useDroppable } from '@dnd-kit/core'
import SlotCell from '../schedule/SlotCell'
import { emptyTd } from '../schedule/slotCellConstants'
import OverlayCell from '../schedule/OverlayCell'
import { S } from '../../styles/shared'
import { decideCell } from '../../screens/schedule/gridGeometry'

// DndContext lives in ScheduleScreen for day view (covers sidebar + grid).
// isExpandDragActive is passed down from ScheduleScreen's drag-start handler.
function DroppableEmptyCell({ groupId, dayId, blockId }) {
  const { setNodeRef, isOver } = useDroppable({
    id: `day-drop-${groupId}-${dayId}-${blockId}`,
    data: { groupId, dayId, blockId },
  })
  return (
    <td
      ref={setNodeRef}
      style={{
        ...emptyTd,
        ...S.cellEmptyOutline,
        background: isOver ? 'var(--primary)22' : S.cellEmptyOutline.background,
        outline: isOver ? '2px dashed var(--primary)' : 'none',
        outlineOffset: -2,
        transition: 'background 0.1s',
        borderRadius: 6,
      }}
    />
  )
}

export default function ScheduleDayView({
  groups, days, timeBlocks, selectedDay, onSelectDay,
  weatherMode, stampMode, actMap, anchorMap,
  releaseCell,
  geometry,
  handleFillEnter, startFill, removeOverlay, handleStampClick,
  onEditSlot, fillState,
  isExpandDragActive,
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
                    const decision = decideCell(geometry, group.id, selectedDay, block.id)
                    if (decision.kind === 'skip') return null
                    if (decision.kind === 'empty') {
                      return <DroppableEmptyCell key={group.id} groupId={group.id} dayId={selectedDay} blockId={block.id} />
                    }
                    if (decision.kind === 'overlay') {
                      const { overlay, rowSpan } = decision
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

                    const { slot, rowSpan, cellType } = decision
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
                          : { ...slot, type: cellType, groupId: slot.group_id, dayId: slot.day_id, blockId: slot.time_block_id, flags: slot.flags || {} }}
                        activity={act}
                        anchor={anchor}
                        actColorIdx={act?.colorIdx || 0}
                        weatherMode={weatherMode}
                        onEdit={cellClickHandler || (s => onEditSlot(s))}
                        onRelease={s => releaseCell(s.id)}
                        isLocked={isLocked}
                        isDndEnabled={!isLocked && !stampMode}
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
  )
}
