import { useDroppable } from '@dnd-kit/core'
import SlotCell from '../schedule/SlotCell'
import { emptyTd } from '../schedule/slotCellConstants'
import OverlayCell from '../schedule/OverlayCell'
import { S } from '../../styles/shared'
import { decideCell } from '../../screens/schedule/gridGeometry'

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


// DndContext lives in ScheduleScreen for group view (covers sidebar + grid).
// isExpandDragActive is passed down from ScheduleScreen's drag-start handler.
export default function ScheduleGroupView({
  groups, days, timeBlocks, selectedGroup, onSelectGroup,
  weatherMode, stampMode, actMap, anchorMap,
  releaseCell,
  geometry,
  handleFillEnter, startFill, removeOverlay, handleStampClick,
  onEditSlot, fillState,
  onExpandSlot,
  onSplitSlot,
  isExpandDragActive,
  selectedSlotKeys,
  pasteMode,
  onCellSelect,
  // Generated "track changes" review: calm grid (showIdentityDot=false) and the
  // lit-cell set for the active concern. highlightMap is Map<slotId, reason>.
  showIdentityDot = true,
  highlightMap,
  highlightColor = 'var(--danger)',
}) {
  return (
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
                        const decision = decideCell(geometry, selectedGroup, day.id, block.id)
                        if (decision.kind === 'skip') return null // tail — covered by head rowSpan
                        if (decision.kind === 'empty') {
                          return <DroppableEmptyCell key={day.id} groupId={selectedGroup} dayId={day.id} blockId={block.id} />
                        }
                        if (decision.kind === 'overlay') {
                          const { overlay, rowSpan } = decision
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

                        const { slot, rowSpan, cellType } = decision
                        const act = slot.activity_id ? actMap.get(slot.activity_id) : null
                        const anchor = slot.anchor_id ? anchorMap.get(slot.anchor_id) : null
                        const cellClickHandler = stampMode
                          ? () => handleStampClick(selectedGroup, day.id, block.id)
                          : undefined

                        const actIsLocked = slot.activity_id && act?.is_locked
                        const isLocked = Boolean(actIsLocked && !slot.is_released)

                        const slotKey = `${selectedGroup}|${day.id}|${block.id}`
                        const isMerged = Boolean(slot.flags?.expanded)
                        const isSelected = selectedSlotKeys?.has(slotKey) ?? false
                        const isMultiSelected = isSelected && (selectedSlotKeys?.size ?? 0) > 1
                        const nextBlock = timeBlocks.find(b => b.sort_order === block.sort_order + 1)
                        const nextSlot = nextBlock ? geometry.getSlot(selectedGroup, day.id, nextBlock.id) : null
                        const hasMergeDown = !isMerged && Boolean(nextBlock) && !nextSlot?.is_anchor && nextSlot?.is_span_head !== false
                        const onMergeDown = hasMergeDown && onExpandSlot ? () => {
                          const tailAct = nextSlot?.activity_id ? actMap.get(nextSlot.activity_id) : null
                          onExpandSlot(selectedGroup, day.id, block.id, nextBlock.id, nextSlot?.activity_id ?? null, tailAct?.name ?? '', nextBlock.name, day.label)
                        } : undefined
                        const onSplit = isMerged && onSplitSlot ? () => onSplitSlot(selectedGroup, day.id, block.id) : undefined

                        return (
                          <SlotCell
                            key={day.id}
                            rowSpan={rowSpan}
                            slot={slot.is_anchor ? { ...slot, type: 'anchor', groupId: slot.group_id, dayId: slot.day_id, blockId: slot.time_block_id } : { ...slot, type: cellType, groupId: slot.group_id, dayId: slot.day_id, blockId: slot.time_block_id, flags: slot.flags || {} }}
                            activity={act}
                            anchor={anchor}
                            actColorIdx={act?.colorIdx || 0}
                            weatherMode={weatherMode}
                            onEdit={cellClickHandler || (s => onEditSlot(s))}
                            onRelease={s => releaseCell(s.id)}
                            isLocked={isLocked}
                            onSelect={!stampMode && !slot.is_anchor ? onCellSelect : undefined}
                            isDndEnabled={!stampMode && !slot.is_anchor && !isLocked}
                            isExpandDragActive={isExpandDragActive}
                            isSelected={isSelected}
                            isMultiSelected={isMultiSelected}
                            pasteMode={pasteMode}
                            hasMergeDown={hasMergeDown}
                            isMerged={isMerged}
                            onMergeDown={onMergeDown}
                            onSplitSlot={onSplit}
                            showIdentityDot={showIdentityDot}
                            isFlagHighlighted={highlightMap?.has(slot.id) ?? false}
                            highlightColor={highlightColor}
                            highlightReason={highlightMap?.get(slot.id) ?? null}
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
