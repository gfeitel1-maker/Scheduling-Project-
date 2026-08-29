import { useState } from 'react'
import SlotCell from './SlotCell'
import EmptyCell from './EmptyCell'
import PulledCell from './PulledCell'
import { buildRowTracks, columnTracks } from '../../screens/schedule/gridTracks'
import { placeCell, placeRowHeader } from '../../screens/schedule/gridPlacement'
import { rowFlagKind, ROW_FLAG_TITLE } from '../../screens/schedule/rowFlags'
import { blockNamesForSpan } from './cellLabel'
import { computeSpanCellProps } from '../../screens/schedule/gridGeometry'
import useGridKeyboardNav from './useGridKeyboardNav'
import { S } from '../../styles/shared'
import './scheduleGrid.css'

const NO_COLLAPSE = new Set()

// T92. Device-local UI chrome, not camp data: never routed through
// window.shoresh/op-log/sync, per the spec's "must not become a per-device
// write conflict" instruction. localStorage can throw (private browsing,
// disabled storage) — treat that the same as "already seen" so the app never
// crashes over a hint.
const MERGE_HINT_KEY = 'shoresh:manualMergeHintSeen'

function readMergeHintSeen() {
  try {
    return localStorage.getItem(MERGE_HINT_KEY) === '1'
  } catch {
    return true
  }
}

function writeMergeHintSeen() {
  try {
    localStorage.setItem(MERGE_HINT_KEY, '1')
  } catch {
    // Storage unavailable — nothing to persist, nothing to crash over.
  }
}

// Pure lookup, computed once per render rather than as a mutable flag threaded
// through the JSX map (a render-time reassignment the react-compiler lint
// rule rejects). Mirrors the exact hasMergeDown condition the render loop
// below applies per cell, in block/day order, so "first" means the same thing
// in both places.
function firstMergeableCellKey({ selectedGroup, days, timeBlocks, geometry }) {
  for (const block of timeBlocks) {
    const nextBlock = timeBlocks.find(b => b.sort_order === block.sort_order + 1)
    if (!nextBlock) continue
    for (const day of days) {
      const slot = geometry.getSlot(selectedGroup, day.id, block.id)
      if (!slot?.activity_id || slot.is_anchor) continue
      if (slot.flags?.expanded) continue
      const nextSlot = geometry.getSlot(selectedGroup, day.id, nextBlock.id)
      if (nextSlot?.is_anchor || nextSlot?.is_span_head === false) continue
      return `${selectedGroup}|${day.id}|${block.id}`
    }
  }
  return null
}

// DndContext and the one grid-surface droppable live in ScheduleScreen (for
// manual mode). This component is just the grid — group pills + slot grid.
export default function ManualBuildView({
  groups, days, timeBlocks,
  selectedGroup, onSelectGroup,
  actMap, anchorMap,
  geometry,
  eligibleActivitiesFor, onPlace, onCreateNew,
  onExpandSlot, onSplitSlot,
  // T107 item 1 — starts the drag-to-extend gesture (useSpanExtendDrag,
  // owned by ScheduleScreen). Omitted entirely disables the handle, same
  // "undefined prop = feature off" convention onMergeDown already uses.
  onSpanExtendStart,
  selectedSlotKeys, pasteMode, onCellSelect,
  collapsedBlockIds = NO_COLLAPSE,
  onToggleBlockCollapsed,
  // T105
  electiveSetsAll = [], electiveMembersBySet, onCreateElective, onOpenElective,
  // Events overlay placement Slice 1
  eventsAll = [], onPlaceEvent, onOpenEvent,
  isContentRaced, onDismissContentRace,
}) {
  const gridTemplateColumns = columnTracks(days.length)
  const rowTracks = buildRowTracks({ timeBlocks, collapsedBlockIds })
  const rowCells = days.map(d => ({ groupId: selectedGroup, dayId: d.id }))
  const gridNav = useGridKeyboardNav()

  // T92 onboarding pulse: exactly one cell — the first mergeable one — gets
  // the hint, and only until the flag is cleared (first interaction with any
  // merge button).
  const [hintSeen, setHintSeen] = useState(readMergeHintSeen)
  const hintTargetKey = (!hintSeen && selectedGroup)
    ? firstMergeableCellKey({ selectedGroup, days, timeBlocks, geometry })
    : null
  function clearMergeHint() {
    if (hintSeen) return
    writeMergeHintSeen()
    setHintSeen(true)
  }

  return (
    <div style={{ flex: 1, minWidth: 0 }}>
      {/* Group pills */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
        {groups.map(g => (
          <button key={g.id} onClick={() => onSelectGroup(g.id)} style={S.chip('var(--primary)', selectedGroup === g.id, { fontSize: 12, fontFamily: 'var(--font-sans)' })}>{g.name}</button>
        ))}
      </div>

      {selectedGroup && (
        <div style={{ overflowX: 'auto' }}>
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

                      // The tail of a merged activity span — covered by the head's grid-row span.
                      if (slot?.activity_id && !slot.is_anchor && geometry.isActivityTail(selectedGroup, day.id, block.id)) return null

                      // T108 Phase 2 (design §5.1) — a PULL override, never droppable.
                      // Manual route has no decideCell dispatch (this view mirrors it
                      // inline, per this file's own header note), so the pull check
                      // is repeated here rather than routed through gridGeometry.js.
                      if (slot?.is_overridden && slot?.is_pull) {
                        return (
                          <PulledCell
                            key={day.id}
                            slot={slot}
                            ariaColIndex={ariaColIndex}
                            cellKey={cellKey}
                            collapsed={isCollapsed}
                            blockNames={blockNamesForSpan(timeBlocks, blockIndex)}
                            column={day.label}
                            {...placeCell({ blockIndex, columnIndex: dayIndex })}
                          />
                        )
                      }

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
                            isDndEnabled={false}
                            ariaColIndex={ariaColIndex}
                            cellKey={cellKey}
                            collapsed={isCollapsed}
                            blockNames={blockNamesForSpan(timeBlocks, blockIndex, rowSpan)}
                            column={day.label}
                            {...placeCell({ blockIndex, columnIndex: dayIndex, rowSpan })}
                          />
                        )
                      }

                      if (slot?.activity_id || slot?.elective_set_id || slot?.event_id) {
                        const act = slot.activity_id ? actMap.get(slot.activity_id) : null
                        const rowSpan = geometry.getActivityRowSpan(selectedGroup, day.id, block.id)
                        const isSelected = selectedSlotKeys?.has(cellKey) ?? false
                        const isMultiSelected = isSelected && (selectedSlotKeys?.size ?? 0) > 1
                        const {
                          isMerged, nextBlock, hasMergeDown, spanTailBlockIds,
                          onSplit, onSplitAt, onExtendGrab,
                        } = computeSpanCellProps({
                          geometry, selectedGroup, day, block, blockIndex, timeBlocks, rowSpan, slot,
                          onSplitSlot, onSpanExtendStart,
                        })
                        const onMergeDown = hasMergeDown && onExpandSlot ? () => {
                          clearMergeHint()
                          onExpandSlot(selectedGroup, day.id, block.id, nextBlock.id)
                        } : undefined
                        const showMergeHint = hasMergeDown && cellKey === hintTargetKey
                        return (
                          <SlotCell
                            key={day.id}
                            rowSpan={rowSpan}
                            slot={{ ...slot, type: 'activity', groupId: slot.group_id, dayId: slot.day_id, blockId: slot.time_block_id, flags: slot.flags || {} }}
                            activity={act}
                            actColorIdx={slot.activity_id}
                            weatherMode={false}
                            eligibleActivities={eligibleActivitiesFor?.(selectedGroup) ?? []}
                            onPlace={onPlace}
                            onCreateNew={onCreateNew}
                            onCreateElective={onCreateElective}
                            electiveSetsAll={electiveSetsAll}
                            electiveMembersBySet={electiveMembersBySet}
                            onOpenElective={onOpenElective}
                            eventsAll={eventsAll}
                            onOpenEvent={onOpenEvent}
                            onPlaceEvent={onPlaceEvent}
                            isContentRaced={isContentRaced?.(selectedGroup, day.id, block.id)}
                            onDismissContentRace={() => onDismissContentRace?.(`${selectedGroup}|${day.id}|${block.id}`)}
                            onSelect={onCellSelect}
                            isDndEnabled={true}
                            isSelected={isSelected}
                            isMultiSelected={isMultiSelected}
                            pasteMode={pasteMode}
                            hasMergeDown={hasMergeDown}
                            isMerged={isMerged}
                            onMergeDown={onMergeDown}
                            onSplitSlot={onSplit}
                            showMergeHint={showMergeHint}
                            spanTailBlockIds={spanTailBlockIds}
                            onSplitAt={onSplitAt}
                            onExtendGrab={onExtendGrab}
                            showExtendHint={showMergeHint}
                            ariaColIndex={ariaColIndex}
                            cellKey={cellKey}
                            collapsed={isCollapsed}
                            blockNames={blockNamesForSpan(timeBlocks, blockIndex, rowSpan)}
                            column={day.label}
                            {...placeCell({ blockIndex, columnIndex: dayIndex, rowSpan })}
                          />
                        )
                      }

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
                          eligibleEvents={eventsAll}
                          onPlaceEvent={onPlaceEvent}
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
        Drag activities from the left panel onto any open cell, or click an empty cell to type one in. An empty cell just isn’t filled yet.
      </div>
    </div>
  )
}
