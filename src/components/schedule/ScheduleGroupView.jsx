import SlotCell from '../schedule/SlotCell'
import EmptyCell from './EmptyCell'
import PulledCell from './PulledCell'
import OverlayCell from '../schedule/OverlayCell'
import OverrideToggleButton from './OverrideToggleButton'
import { decideCell } from '../../screens/schedule/gridGeometry'
import { buildRowTracks, columnTracks } from '../../screens/schedule/gridTracks'
import { placeCell, placeRowHeader } from '../../screens/schedule/gridPlacement'
import { rowFlagKind, ROW_FLAG_TITLE } from '../../screens/schedule/rowFlags'
import { blockNamesForSpan } from './cellLabel'
import useGridKeyboardNav from './useGridKeyboardNav'
import './scheduleGrid.css'

const NO_COLLAPSE = new Set()

// DndContext and the one grid-surface droppable live in ScheduleScreen (they
// cover sidebar + grid). Drag state is the FSM's and reaches cells as data
// attributes written directly to the DOM — no drag prop is threaded through here.
export default function ScheduleGroupView({
  groups, days, timeBlocks, selectedGroup, onSelectGroup,
  weatherMode, stampMode, actMap, anchorMap,
  releaseCell,
  geometry,
  handleFillEnter, startFill, removeOverlay, handleStampClick,
  eligibleActivitiesFor, onPlace, onCreateNew, fillState,
  onExpandSlot,
  onSplitSlot,
  selectedSlotKeys,
  pasteMode,
  onCellSelect,
  // Generated "track changes" review: calm grid (showIdentityDot=false) and the
  // lit-cell set for the active concern. highlightMap is Map<slotId, reason>.
  showIdentityDot = true,
  highlightMap,
  highlightColor = 'var(--danger)',
  // T55. A Set of collapsed time-block ids and the toggle for it. Collapse is
  // two concerns: the TRACK (this string, on the container) and the CONTENT
  // PRESENTATION (data-collapsed on the row's cells, styled by scheduleGrid.css).
  // Neither implies the other, which is why both are written here.
  collapsedBlockIds = NO_COLLAPSE,
  onToggleBlockCollapsed,
  // T105
  electiveSetsAll = [], electiveMembersBySet, onCreateElective,
  isContentRaced, onDismissContentRace,
  // T108 Phase 2 (design §6, Designer spec §1.1) — each day COLUMN is its
  // own (week, day) binding here, so the toggle lives once per column, in
  // that column's header cell.
  overrideModeDayId, onToggleOverrideMode,
  // Designer spec §3.3 "whole-day pull" — batches a pull across every block
  // for the selected group on the active override day.
  onPullOverrideDay,
}) {
  const rowTracks = buildRowTracks({ timeBlocks, collapsedBlockIds })
  const rowCells = days.map(d => ({ groupId: selectedGroup, dayId: d.id }))
  const gridTemplateColumns = columnTracks(days.length)
  const gridNav = useGridKeyboardNav()

  return (
      <div className="schedule-view-enter">
        {/* Group pills */}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
          {groups.map(g => (
            <button key={g.id} onClick={() => onSelectGroup(g.id)} className="press-98" style={{
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
                {...gridNav}
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
                        data-override-active={overrideModeDayId === d.id ? '' : undefined}
                        style={{ ...placeCell({ blockIndex: 0, columnIndex: dayIndex }), position: 'relative' }}
                      >
                        {d.label}
                        {onToggleOverrideMode && (
                          <span style={{ position: 'absolute', top: 4, right: 4, display: 'flex', gap: 2 }}>
                            {overrideModeDayId === d.id && onPullOverrideDay && (
                              <button
                                type="button"
                                className="cell-action"
                                title={`Pull ${groups.find(g => g.id === selectedGroup)?.name ?? 'group'} for the whole day`}
                                aria-label={`Pull ${groups.find(g => g.id === selectedGroup)?.name ?? 'group'} for the whole day`}
                                onClick={e => { e.stopPropagation(); onPullOverrideDay(selectedGroup, d.id) }}
                              >⇥</button>
                            )}
                            <OverrideToggleButton
                              active={overrideModeDayId === d.id}
                              onClick={() => onToggleOverrideMode(d.id)}
                            />
                          </span>
                        )}
                      </div>
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
                      // The whole 20px strip is the re-expand target — that is
                      // half of the accepted WCAG 2.5.8 deviation (the row
                      // header's aria-expanded button is the other half). Capture
                      // phase, so a click on a folded cell re-expands instead of
                      // opening its editor; the cell keeps every handler it had,
                      // they simply do not fire at 20px. Nothing is unmounted.
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
                        {/* A real <button>: Enter and Space come free, and that
                            keyboard path is what makes the 20px target's
                            deviation an accepted equivalent mechanism rather
                            than a plain conformance failure. */}
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
                        const decision = decideCell(geometry, selectedGroup, day.id, block.id)
                        if (decision.kind === 'skip') return null // tail — covered by the head's grid-row span
                        const ariaColIndex = dayIndex + 2
                        const cellKey = `${selectedGroup}|${day.id}|${block.id}`

                        if (decision.kind === 'empty') {
                          return (
                            <EmptyCell
                              key={day.id}
                              groupId={selectedGroup}
                              dayId={day.id}
                              blockId={block.id}
                              ariaColIndex={ariaColIndex}
                              collapsed={isCollapsed}
                              blockNames={blockNamesForSpan(timeBlocks, blockIndex)}
                              column={day.label}
                              eligibleActivities={eligibleActivitiesFor?.(selectedGroup) ?? []}
                              onPlace={onPlace}
                              onCreateNew={onCreateNew}
                              onCreateElective={onCreateElective}
                              // Three-way precedence (stamp > paste > edit): onCellClick
                              // is only defined while stamp mode is active, mirroring the
                              // SlotCell call below exactly.
                              onCellClick={stampMode ? (() => handleStampClick(selectedGroup, day.id, block.id)) : undefined}
                              pasteMode={pasteMode}
                              onCellSelect={onCellSelect}
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
                              ariaColIndex={ariaColIndex}
                              cellKey={cellKey}
                              collapsed={isCollapsed}
                              blockNames={blockNamesForSpan(timeBlocks, blockIndex, rowSpan)}
                              column={day.label}
                              {...placeCell({ blockIndex, columnIndex: dayIndex, rowSpan })}
                            />
                          )
                        }

                        // T108 Phase 2 (design §5.1) — a PULL override, never droppable.
                        if (decision.kind === 'pulled') {
                          return (
                            <PulledCell
                              key={day.id}
                              slot={decision.slot}
                              ariaColIndex={ariaColIndex}
                              cellKey={cellKey}
                              collapsed={isCollapsed}
                              blockNames={blockNamesForSpan(timeBlocks, blockIndex)}
                              column={day.label}
                              {...placeCell({ blockIndex, columnIndex: dayIndex })}
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

                        // ADR 2026-08-21 §1/R-HIGH: flags.expanded is retired
                        // as a structural pointer — isMerged is now "this row
                        // is a span head with >=1 tail", read off the chain
                        // (the immediate next block owning this row's own
                        // activity as a tail), not a head-owned flag.
                        const immediateNextBlock = timeBlocks.find(b => b.sort_order === block.sort_order + 1)
                        const immediateNextSlot = immediateNextBlock ? geometry.getSlot(selectedGroup, day.id, immediateNextBlock.id) : null
                        const isMerged = immediateNextSlot?.is_span_head === false && immediateNextSlot?.activity_id === slot.activity_id
                        const isSelected = selectedSlotKeys?.has(cellKey) ?? false
                        const isMultiSelected = isSelected && (selectedSlotKeys?.size ?? 0) > 1
                        // Merge-down always targets the block AFTER the span's
                        // current end (rowSpan-chain-based), not the block
                        // immediately after the head — so a director can keep
                        // extending an already-merged span to arbitrary N, not
                        // just once (the exact bug the owner reported).
                        const nextBlock = timeBlocks[blockIndex + rowSpan]
                        const nextSlot = nextBlock ? geometry.getSlot(selectedGroup, day.id, nextBlock.id) : null
                        const hasMergeDown = Boolean(nextBlock) && !nextSlot?.is_anchor && nextSlot?.is_span_head !== false
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
                            onCellClick={cellClickHandler}
                            eligibleActivities={eligibleActivitiesFor?.(selectedGroup) ?? []}
                            onPlace={onPlace}
                            onCreateNew={onCreateNew}
                            onCreateElective={onCreateElective}
                            electiveSetsAll={electiveSetsAll}
                            electiveMembersBySet={electiveMembersBySet}
                            isContentRaced={isContentRaced?.(selectedGroup, day.id, block.id)}
                            onDismissContentRace={() => onDismissContentRace?.(`${selectedGroup}|${day.id}|${block.id}`)}
                            onRelease={s => releaseCell(s.id)}
                            isLocked={isLocked}
                            onSelect={!stampMode && !slot.is_anchor ? onCellSelect : undefined}
                            isDndEnabled={!stampMode && !slot.is_anchor && !isLocked}
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
                            ariaColIndex={ariaColIndex}
                            cellKey={cellKey}
                            collapsed={isCollapsed}
                            blockNames={blockNamesForSpan(timeBlocks, blockIndex, rowSpan)}
                            column={day.label}
                            {...placeCell({ blockIndex, columnIndex: dayIndex, rowSpan })}
                          />
                        )
                      })}
                      {/* Always mounted, shown by CSS only when the row is both
                          collapsed and flagged — so toggling collapse stays an
                          attribute write and never changes DOM membership.
                          Decorative: every flagged cell keeps its own title and
                          glyph, which is where a screen reader gets the detail. */}
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
      </div>
  )
}
