import { useDroppable } from '@dnd-kit/core'
import SlotCell from '../schedule/SlotCell'
import OverlayCell from '../schedule/OverlayCell'
import { decideCell } from '../../screens/schedule/gridGeometry'
import { buildRowTracks } from '../../screens/schedule/gridTracks'
import { placeCell, placeRowHeader } from '../../screens/schedule/gridPlacement'
import './scheduleGrid.css'

// Column geometry, not style: it depends on the day count, so it is computed
// here and applied inline to both rowgroups so their tracks are identical.
//
// minmax(0, 1fr) rather than the spec's minmax(<colFloor>, 1fr): no colFloor
// value was ever resolved (D1-D3 cover the ROW floors only), and any non-zero
// floor introduces horizontal scrolling that the table — tableLayout: fixed
// inside minWidth: 500 — does not have today, which would break the
// visual-parity predicate. Left for whoever resolves colFloor.
function columnTemplate(dayCount) {
  return `140px repeat(${dayCount}, minmax(0, 1fr))`
}

function DroppableEmptyCell({ groupId, dayId, blockId, gridRow, gridColumn, ariaColIndex }) {
  const { setNodeRef, isOver } = useDroppable({
    id: `grp-drop-${groupId}-${dayId}-${blockId}`,
    data: { groupId, dayId, blockId },
  })
  return (
    <div
      ref={setNodeRef}
      role="gridcell"
      className="cell"
      data-empty=""
      data-cell-key={`${groupId}|${dayId}|${blockId}`}
      aria-colindex={ariaColIndex}
      style={{ gridRow, gridColumn }}
    >
      {/* isOver is drag state, not hover — it stays inline. The drag layer is
          T57/T58; nothing about it changes here. */}
      <div
        className="cell-empty"
        style={isOver
          ? { background: 'var(--primary)22', outline: '2px dashed var(--primary)', outlineOffset: -2 }
          : undefined}
      >
        Empty
      </div>
    </div>
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
  // Collapse is T55; this view passes the empty set deliberately.
  const rowTracks = buildRowTracks({ timeBlocks, collapsedBlockIds: [] })
  const gridTemplateColumns = columnTemplate(days.length)

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
              {/* role="grid" sits on the frame; the two role="rowgroup"
                  children are the CSS Grid containers. Two containers rather
                  than one because --grid-rows carries a track per TIME BLOCK
                  and placeCell maps blockIndex 0 -> row line 1: a day-header
                  row inside the same container would consume a block's track
                  and force a +1 offset back into every call site, which is the
                  duplication gridPlacement.js exists to prevent. Both share
                  one column template and one width, so their tracks align. */}
              <div
                role="grid"
                className="schedule-grid-frame"
                aria-rowcount={timeBlocks.length + 1}
                aria-colcount={days.length + 1}
              >
                <div role="rowgroup" className="schedule-grid schedule-grid--header" style={{ gridTemplateColumns }}>
                  <div role="row" aria-rowindex={1} style={{ display: 'contents' }}>
                    <div role="columnheader" className="cell row-header" aria-colindex={1} style={placeRowHeader({ blockIndex: 0 })}>Block</div>
                    {days.map((d, dayIndex) => (
                      <div
                        key={d.id}
                        role="columnheader"
                        className="cell"
                        aria-colindex={dayIndex + 2}
                        style={placeCell({ blockIndex: 0, columnIndex: dayIndex })}
                      >{d.label}</div>
                    ))}
                  </div>
                </div>

                <div
                  role="rowgroup"
                  className="schedule-grid schedule-grid--body"
                  style={{ gridTemplateColumns, '--grid-rows': rowTracks }}
                >
                  {timeBlocks.map((block, blockIndex) => (
                    <div
                      key={block.id}
                      role="row"
                      aria-rowindex={blockIndex + 2}
                      style={{ display: 'contents' }}
                      onPointerEnter={() => {
                        const b = timeBlocks.find(tb => tb.id === block.id)
                        if (b && fillState) handleFillEnter(b.sort_order)
                      }}
                    >
                      <div role="rowheader" className="cell row-header" aria-colindex={1} style={placeRowHeader({ blockIndex })}>
                        <div className="block-name">{block.name}</div>
                        <div className="block-time">{block.start_time?.slice(0,5)}–{block.end_time?.slice(0,5)}</div>
                      </div>
                      {days.map((day, dayIndex) => {
                        const decision = decideCell(geometry, selectedGroup, day.id, block.id)
                        if (decision.kind === 'skip') return null // tail — covered by the head's grid-row span
                        const ariaColIndex = dayIndex + 2
                        const cellKey = `${selectedGroup}|${day.id}|${block.id}`

                        if (decision.kind === 'empty') {
                          return (
                            <DroppableEmptyCell
                              key={day.id}
                              groupId={selectedGroup}
                              dayId={day.id}
                              blockId={block.id}
                              ariaColIndex={ariaColIndex}
                              {...placeCell({ blockIndex, columnIndex: dayIndex })}
                            />
                          )
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
                              renderAs="gridcell"
                              ariaColIndex={ariaColIndex}
                              cellKey={cellKey}
                              {...placeCell({ blockIndex, columnIndex: dayIndex, rowSpan })}
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

                        const isMerged = Boolean(slot.flags?.expanded)
                        const isSelected = selectedSlotKeys?.has(cellKey) ?? false
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
                            renderAs="gridcell"
                            ariaColIndex={ariaColIndex}
                            cellKey={cellKey}
                            {...placeCell({ blockIndex, columnIndex: dayIndex, rowSpan })}
                          />
                        )
                      })}
                    </div>
                  ))}
                </div>
              </div>
            </div>
        )}
      </div>
  )
}
