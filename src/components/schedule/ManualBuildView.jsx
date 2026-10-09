import { useState } from 'react'
import SlotCell from './SlotCell'
import EmptyCell from './EmptyCell'
import { placeCell } from '../../screens/schedule/gridPlacement'
import { blockNamesForSpan } from './cellLabel'
import { computeSpanCellProps } from '../../screens/schedule/gridGeometry'
import GroupGridFrame from './GroupGridFrame'

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
      if (!slot?.activity_id || slot.is_fixed_event) continue
      if (slot.flags?.expanded) continue
      const nextSlot = geometry.getSlot(selectedGroup, day.id, nextBlock.id)
      if (nextSlot?.is_fixed_event || nextSlot?.is_span_head === false) continue
      return `${selectedGroup}|${day.id}|${block.id}`
    }
  }
  return null
}

// DndContext and the one grid-surface droppable live in ScheduleScreen. The
// pills, header and row chrome are GroupGridFrame, shared with the generated
// route (ScheduleGroupView); this component supplies only the manual cells.
export default function ManualBuildView({
  groups, days, timeBlocks,
  selectedGroup, onSelectGroup,
  actMap, fixedEventMap,
  geometry,
  eligibleActivitiesFor, onPlace, onCreateNew,
  onExpandSlot, onSplitSlot,
  // T107 item 1 — starts the drag-to-extend gesture (useSpanExtendDrag,
  // owned by ScheduleScreen). Omitted entirely disables the handle, same
  // "undefined prop = feature off" convention onMergeDown already uses.
  onSpanExtendStart,
  selectedSlotKeys, pasteMode, onCellSelect,
  collapsedBlockIds,
  onToggleBlockCollapsed,
  // T105
  electiveSetsAll = [], electiveMembersBySet, onCreateElective, onOpenElective,
  // Events overlay placement Slice 1
  eventsAll = [], onPlaceEvent, onOpenEvent,
  isContentRaced, onDismissContentRace,
  // T350 slice 4 — drawn by GroupGridFrame, identical on both routes.
  replacements, onOpenSpecialDay,
}) {
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

  function renderCell({ day, dayIndex, block, blockIndex, isCollapsed, ariaColIndex, cellKey }) {
    const slot = geometry.getSlot(selectedGroup, day.id, block.id)

    // The tail of a fixed event span — covered by the head's grid-row span.
    if (slot?.is_fixed_event && geometry.isFixedEventTail(selectedGroup, day.id, block.id)) return null

    // The tail of a merged activity span — covered by the head's grid-row span.
    if (slot?.activity_id && !slot.is_fixed_event && geometry.isActivityTail(selectedGroup, day.id, block.id)) return null

    if (slot?.is_fixed_event) {
      const rowSpan = geometry.getFixedEventRowSpan(selectedGroup, day.id, block.id)
      const fixedEvent = slot.fixed_event_id ? fixedEventMap.get(slot.fixed_event_id) : null
      return (
        <SlotCell
          key={day.id}
          rowSpan={rowSpan}
          slot={{ ...slot, type: 'fixed_event', groupId: slot.group_id, dayId: slot.day_id, blockId: slot.time_block_id }}
          fixedEvent={fixedEvent}
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
      // One-time discoverability pulse. Now targets the drag bar
      // only — the merge chevron it used to also light is gone.
      const showExtendHintForCell = hasMergeDown && cellKey === hintTargetKey
      return (
        <SlotCell
          key={day.id}
          rowSpan={rowSpan}
          slot={{ ...slot, type: 'activity', groupId: slot.group_id, dayId: slot.day_id, blockId: slot.time_block_id, flags: slot.flags || {} }}
          activity={act}
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
          spanTailBlockIds={spanTailBlockIds}
          onSplitAt={onSplitAt}
          onExtendGrab={onExtendGrab}
          showExtendHint={showExtendHintForCell}
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
        electiveSetsAll={electiveSetsAll}
        eligibleEvents={eventsAll}
        onPlaceEvent={onPlaceEvent}
        {...placeCell({ blockIndex, columnIndex: dayIndex })}
      />
    )
  }

  return (
    <GroupGridFrame
      groups={groups}
      days={days}
      timeBlocks={timeBlocks}
      selectedGroup={selectedGroup}
      onSelectGroup={onSelectGroup}
      geometry={geometry}
      collapsedBlockIds={collapsedBlockIds}
      onToggleBlockCollapsed={onToggleBlockCollapsed}
      renderCell={renderCell}
      replacements={replacements}
      actMap={actMap}
      onOpenSpecialDay={onOpenSpecialDay}
    />
  )
}
