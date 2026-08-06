import { useDroppable } from '@dnd-kit/core'
import SlotCell from './SlotCell'
import { buildRowTracks, columnTracks } from '../../screens/schedule/gridTracks'
import { placeCell, placeRowHeader } from '../../screens/schedule/gridPlacement'
import { rowFlagKind, ROW_FLAG_TITLE } from '../../screens/schedule/rowFlags'
import './scheduleGrid.css'

const NO_COLLAPSE = new Set()

function EmptyDropCell({ groupId, dayId, blockId, gridRow, gridColumn, ariaColIndex, collapsed }) {
  const { setNodeRef, isOver } = useDroppable({
    id: `drop-${groupId}-${dayId}-${blockId}`,
    data: { groupId, dayId, blockId },
  })
  return (
    <div
      ref={setNodeRef}
      role="gridcell"
      className="cell"
      data-empty=""
      data-cell-key={`${groupId}|${dayId}|${blockId}`}
      data-collapsed={collapsed ? '' : undefined}
      aria-colindex={ariaColIndex}
      style={{ gridRow, gridColumn }}
    >
      {/* isOver is drag state, not hover — it stays inline. The drag layer is
          T58; nothing about it changes here. */}
      <div
        className="cell-empty"
        style={isOver
          ? { background: 'color-mix(in srgb, var(--primary) 13%, transparent)', border: '2px dashed var(--primary)' }
          : undefined}
      />
    </div>
  )
}

// DndContext lives in ScheduleScreen (for manual mode). This component is
// just the grid — group pills + droppable slot grid.
export default function ManualBuildView({
  groups, days, timeBlocks,
  selectedGroup, onSelectGroup,
  actMap, anchorMap,
  geometry, onEditSlot,
  onExpandSlot, onSplitSlot,
  selectedSlotKeys, pasteMode, onCellSelect,
  collapsedBlockIds = NO_COLLAPSE,
  onToggleBlockCollapsed,
}) {
  const gridTemplateColumns = columnTracks(days.length)
  const rowTracks = buildRowTracks({ timeBlocks, collapsedBlockIds })
  const rowCells = days.map(d => ({ groupId: selectedGroup, dayId: d.id }))

  return (
    <div style={{ flex: 1, minWidth: 0 }}>
      {/* Group pills */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
        {groups.map(g => (
          <button key={g.id} onClick={() => onSelectGroup(g.id)} style={{
            padding: '5px 12px', borderRadius: 20,
            border: `1.5px solid ${selectedGroup === g.id ? 'var(--primary)' : 'var(--border)'}`,
            background: selectedGroup === g.id ? 'var(--primary)' : 'var(--surface)',
            color: selectedGroup === g.id ? '#fff' : 'var(--text)',
            fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'var(--font-sans)',
          }}>{g.name}</button>
        ))}
      </div>

      {selectedGroup && (
        <div style={{ overflowX: 'auto' }}>
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
              {timeBlocks.map((block, blockIndex) => {
                const isCollapsed = collapsedBlockIds.has(block.id)
                const flagKind = rowFlagKind(geometry, rowCells, block.id)
                const toggle = () => onToggleBlockCollapsed?.(block.id)
                return (
                  <div
                    key={block.id}
                    role="row"
                    aria-rowindex={blockIndex + 2}
                    style={{ display: 'contents' }}
                    // The whole 20px strip is the re-expand target (T55): capture
                    // phase, so a click on a folded cell re-expands instead of
                    // opening its editor. Nothing is unmounted.
                    onClickCapture={isCollapsed ? (e => { e.stopPropagation(); toggle() }) : undefined}
                  >
                    <div
                      role="rowheader"
                      className="cell row-header"
                      aria-colindex={1}
                      data-collapsed={isCollapsed ? '' : undefined}
                      style={placeRowHeader({ blockIndex })}
                    >
                      <button
                        type="button"
                        className="row-header-toggle"
                        aria-expanded={!isCollapsed}
                        onClick={toggle}
                      >
                        <span className="block-name">{block.name}</span>
                        <span className="block-time">{block.start_time?.slice(0,5)}–{block.end_time?.slice(0,5)}</span>
                      </button>
                    </div>
                    {days.map((day, dayIndex) => {
                      const slot = geometry.getSlot(selectedGroup, day.id, block.id)
                      const ariaColIndex = dayIndex + 2
                      const cellKey = `${selectedGroup}|${day.id}|${block.id}`

                      // The tail of an anchor span — covered by the head's grid-row span.
                      if (slot?.is_anchor && geometry.isAnchorTail(selectedGroup, day.id, block.id)) return null

                      if (slot?.is_anchor) {
                        const rowSpan = geometry.getAnchorRowSpan(selectedGroup, day.id, block.id)
                        const anchor = slot.anchor_id ? anchorMap.get(slot.anchor_id) : null
                        return (
                          <SlotCell
                            key={day.id}
                            rowSpan={rowSpan}
                            slot={{ ...slot, type: 'anchor', groupId: slot.group_id, dayId: slot.day_id, blockId: slot.time_block_id }}
                            anchor={anchor}
                            actColorIdx={0}
                            weatherMode={false}
                            onEdit={() => {}}
                            isDndEnabled={false}
                            ariaColIndex={ariaColIndex}
                            cellKey={cellKey}
                            collapsed={isCollapsed}
                            {...placeCell({ blockIndex, columnIndex: dayIndex, rowSpan })}
                          />
                        )
                      }

                      if (slot?.activity_id) {
                        const act = actMap.get(slot.activity_id)
                        const isMerged = Boolean(slot.flags?.expanded)
                        const isSelected = selectedSlotKeys?.has(cellKey) ?? false
                        const isMultiSelected = isSelected && (selectedSlotKeys?.size ?? 0) > 1
                        const nextBlock = timeBlocks.find(b => b.sort_order === block.sort_order + 1)
                        const nextSlot = nextBlock ? geometry.getSlot(selectedGroup, day.id, nextBlock.id) : null
                        const hasMergeDown = !isMerged && Boolean(nextBlock) && !nextSlot?.is_anchor && nextSlot?.is_span_head !== false
                        const onMergeDown = hasMergeDown && onExpandSlot ? () => {
                          const tailAct = nextSlot?.activity_id ? actMap.get(nextSlot.activity_id) : null
                          const dayObj = days.find(d => d.id === day.id)
                          onExpandSlot(selectedGroup, day.id, block.id, nextBlock.id, nextSlot?.activity_id ?? null, tailAct?.name ?? '', nextBlock.name, dayObj?.label ?? day.id)
                        } : undefined
                        const onSplit = isMerged && onSplitSlot ? () => onSplitSlot(selectedGroup, day.id, block.id) : undefined
                        return (
                          <SlotCell
                            key={day.id}
                            rowSpan={1}
                            slot={{ ...slot, type: 'activity', groupId: slot.group_id, dayId: slot.day_id, blockId: slot.time_block_id, flags: slot.flags || {} }}
                            activity={act}
                            actColorIdx={slot.activity_id}
                            weatherMode={false}
                            onEdit={s => onEditSlot(s)}
                            onSelect={onCellSelect}
                            isDndEnabled={true}
                            isSelected={isSelected}
                            isMultiSelected={isMultiSelected}
                            pasteMode={pasteMode}
                            hasMergeDown={hasMergeDown}
                            isMerged={isMerged}
                            onMergeDown={onMergeDown}
                            onSplitSlot={onSplit}
                            ariaColIndex={ariaColIndex}
                            cellKey={cellKey}
                            collapsed={isCollapsed}
                            {...placeCell({ blockIndex, columnIndex: dayIndex })}
                          />
                        )
                      }

                      return (
                        <EmptyDropCell
                          key={day.id}
                          groupId={selectedGroup}
                          dayId={day.id}
                          blockId={block.id}
                          ariaColIndex={ariaColIndex}
                          collapsed={isCollapsed}
                          {...placeCell({ blockIndex, columnIndex: dayIndex })}
                        />
                      )
                    })}
                    <div
                      className="row-flag-dot"
                      aria-hidden="true"
                      data-collapsed={isCollapsed ? '' : undefined}
                      data-flag={flagKind || undefined}
                      title={flagKind ? ROW_FLAG_TITLE[flagKind] : undefined}
                      style={placeCell({ blockIndex, columnIndex: days.length - 1 })}
                    />
                  </div>
                )
              })}
            </div>
          </div>
        </div>
      )}

      <div style={{ marginTop: 10, fontSize: 11, color: 'var(--text-secondary)', fontFamily: 'var(--font-sans)' }}>
        Drag activities from the left panel onto any open cell, or click a cell to pick one. An empty cell just isn’t filled yet.
      </div>
    </div>
  )
}
