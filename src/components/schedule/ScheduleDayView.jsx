import SlotCell from '../schedule/SlotCell'
import OverlayCell from '../schedule/OverlayCell'
import { decideCell } from '../../screens/schedule/gridGeometry'
import { buildRowTracks, columnTracks } from '../../screens/schedule/gridTracks'
import { placeCell, placeRowHeader } from '../../screens/schedule/gridPlacement'
import { rowFlagKind, ROW_FLAG_TITLE } from '../../screens/schedule/rowFlags'
import { cellAccessibleName, blockNamesForSpan } from './cellLabel'
import useGridKeyboardNav from './useGridKeyboardNav'
import './scheduleGrid.css'

const NO_COLLAPSE = new Set()

// No per-cell droppable: T58 moved hit resolution to the grid surface, and the
// drop-target paint to `.cell[data-drag-over]` in scheduleGrid.css.
function EmptyCell({ groupId, dayId, blockId, gridRow, gridColumn, ariaColIndex, collapsed, blockNames, column }) {
  return (
    <div
      role="gridcell"
      className="cell"
      data-empty=""
      data-cell-key={`${groupId}|${dayId}|${blockId}`}
      data-collapsed={collapsed ? '' : undefined}
      aria-colindex={ariaColIndex}
      // T59. An empty cell announces as empty, never as a blank cell.
      aria-label={cellAccessibleName({ subject: 'Empty', blockNames, column })}
      style={{ gridRow, gridColumn }}
    >
      <div className="cell-empty" />
    </div>
  )
}

// DndContext and the one grid-surface droppable live in ScheduleScreen (they
// cover sidebar + grid). Drag state is the FSM's and reaches cells as data
// attributes written directly to the DOM — no drag prop is threaded through here.
//
// The COLUMNS OF THIS VIEW ARE GROUPS, not days. placeCell's columnIndex is
// column-semantics-agnostic by design, so the group index goes straight in;
// there is deliberately no second placement helper.
export default function ScheduleDayView({
  groups, days, timeBlocks, selectedDay, onSelectDay,
  weatherMode, stampMode, actMap, anchorMap,
  releaseCell,
  geometry,
  handleFillEnter, startFill, removeOverlay, handleStampClick,
  onEditSlot, fillState,
  // Generated "track changes" review; empty/true on the manual route so its
  // day view is unchanged. highlightMap is Map<slotId, reason>.
  showIdentityDot = true,
  highlightMap,
  highlightColor = 'var(--danger)',
  collapsedBlockIds = NO_COLLAPSE,
  onToggleBlockCollapsed,
}) {
  const gridTemplateColumns = columnTracks(groups.length)
  const rowTracks = buildRowTracks({ timeBlocks, collapsedBlockIds })
  const rowCells = groups.map(g => ({ groupId: g.id, dayId: selectedDay }))
  const gridNav = useGridKeyboardNav()

  return (
    <div>
      {/* Day pills */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
        {days.map(d => (
          <button key={d.id} onClick={() => onSelectDay(d.id)} className="press-98" style={{
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
          <div
            role="grid"
            className="schedule-grid-frame"
            aria-rowcount={timeBlocks.length + 1}
            aria-colcount={groups.length + 1}
            // This view's own minWidth, unchanged from the table it replaces.
            style={{ '--frame-min-width': `${140 + groups.length * 130}px` }}
            {...gridNav}
          >
            <div role="rowgroup" className="schedule-grid schedule-grid--header" style={{ gridTemplateColumns }}>
              <div role="row" aria-rowindex={1} style={{ display: 'contents' }}>
                <div role="columnheader" className="cell row-header" aria-colindex={1} style={placeRowHeader({ blockIndex: 0 })}>Block</div>
                {groups.map((g, groupIndex) => (
                  <div
                    key={g.id}
                    role="columnheader"
                    className="cell"
                    aria-colindex={groupIndex + 2}
                    style={placeCell({ blockIndex: 0, columnIndex: groupIndex })}
                  >{g.name}</div>
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
                    onClickCapture={isCollapsed ? (e => { e.stopPropagation(); toggle() }) : undefined}
                    onPointerEnter={() => {
                      const b = timeBlocks.find(tb => tb.id === block.id)
                      if (b && fillState) handleFillEnter(b.sort_order)
                    }}
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
                    {groups.map((group, groupIndex) => {
                      const decision = decideCell(geometry, group.id, selectedDay, block.id)
                      if (decision.kind === 'skip') return null // tail — covered by the head's grid-row span
                      const ariaColIndex = groupIndex + 2
                      const cellKey = `${group.id}|${selectedDay}|${block.id}`

                      if (decision.kind === 'empty') {
                        return (
                          <EmptyCell
                            key={group.id}
                            groupId={group.id}
                            dayId={selectedDay}
                            blockId={block.id}
                            ariaColIndex={ariaColIndex}
                            collapsed={isCollapsed}
                            blockNames={blockNamesForSpan(timeBlocks, blockIndex)}
                            column={group.name}
                            {...placeCell({ blockIndex, columnIndex: groupIndex })}
                          />
                        )
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
                            ariaColIndex={ariaColIndex}
                            cellKey={cellKey}
                            collapsed={isCollapsed}
                            blockNames={blockNamesForSpan(timeBlocks, blockIndex, rowSpan)}
                            column={group.name}
                            {...placeCell({ blockIndex, columnIndex: groupIndex, rowSpan })}
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
                          showIdentityDot={showIdentityDot}
                          isFlagHighlighted={highlightMap?.has(slot.id) ?? false}
                          highlightColor={highlightColor}
                          highlightReason={highlightMap?.get(slot.id) ?? null}
                          ariaColIndex={ariaColIndex}
                          cellKey={cellKey}
                          collapsed={isCollapsed}
                          blockNames={blockNamesForSpan(timeBlocks, blockIndex, rowSpan)}
                          column={group.name}
                          {...placeCell({ blockIndex, columnIndex: groupIndex, rowSpan })}
                        />
                      )
                    })}
                    <div
                      className="row-flag-dot"
                      aria-hidden="true"
                      data-collapsed={isCollapsed ? '' : undefined}
                      data-flag={flagKind || undefined}
                      title={flagKind ? ROW_FLAG_TITLE[flagKind] : undefined}
                      style={placeCell({ blockIndex, columnIndex: groups.length - 1 })}
                    />
                  </div>
                )
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
