import SlotCell from './SlotCell'
import EmptyCell from './EmptyCell'
import { decideCell } from '../../screens/schedule/gridGeometry'
import { placeCell } from '../../screens/schedule/gridPlacement'
import { blockNamesForSpan } from './cellLabel'
import { computeSpanCellProps } from '../../screens/schedule/gridGeometry'
import GroupGridFrame from './GroupGridFrame'

// DndContext and the one grid-surface droppable live in ScheduleScreen (they
// cover sidebar + grid). Drag state is the FSM's and reaches cells as data
// attributes written directly to the DOM — no drag prop is threaded through here.
// The pills, header and row chrome are GroupGridFrame, shared with the manual
// route (ManualBuildView); this component supplies only the generated cells.
export default function ScheduleGroupView({
  groups, days, timeBlocks, selectedGroup, onSelectGroup,
  weatherMode, actMap, fixedEventMap,
  releaseCell,
  geometry,
  eligibleActivitiesFor, onPlace, onCreateNew,
  onExpandSlot,
  onSplitSlot,
  // T107 item 1 / ADR §5 — generated-route parity: same drag-to-extend
  // gesture, routed through the same expandSlot as the manual route.
  onSpanExtendStart,
  selectedSlotKeys,
  pasteMode,
  onCellSelect,
  // lit-cell set for the active concern. highlightMap is Map<slotId, reason>.
  highlightMap,
  highlightColor = 'var(--danger)',
  // T55. Collapsed time-block ids and the toggle; GroupGridFrame applies both.
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
  function renderCell({ day, dayIndex, block, blockIndex, isCollapsed, ariaColIndex, cellKey }) {
    const decision = decideCell(geometry, selectedGroup, day.id, block.id)
    if (decision.kind === 'skip') return null // tail — covered by the head's grid-row span

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
          electiveSetsAll={electiveSetsAll}
          eligibleEvents={eventsAll}
          onPlaceEvent={onPlaceEvent}
          pasteMode={pasteMode}
          onCellSelect={onCellSelect}
          {...placeCell({ blockIndex, columnIndex: dayIndex })}
        />
      )
    }

    const { slot, rowSpan, cellType } = decision
    const act = slot.activity_id ? actMap.get(slot.activity_id) : null
    const fixedEvent = slot.fixed_event_id ? fixedEventMap.get(slot.fixed_event_id) : null

    const actIsLocked = slot.activity_id && act?.is_locked
    const isLocked = Boolean(actIsLocked && !slot.is_released)

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
      onExpandSlot(selectedGroup, day.id, block.id, nextBlock.id)
    } : undefined

    return (
      <SlotCell
        key={day.id}
        rowSpan={rowSpan}
        slot={slot.is_fixed_event ? { ...slot, type: 'fixed_event', groupId: slot.group_id, dayId: slot.day_id, blockId: slot.time_block_id } : { ...slot, type: cellType, groupId: slot.group_id, dayId: slot.day_id, blockId: slot.time_block_id, flags: slot.flags || {} }}
        activity={act}
        fixedEvent={fixedEvent}
        weatherMode={weatherMode}
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
        onRelease={s => releaseCell(s.id)}
        isLocked={isLocked}
        onSelect={!slot.is_fixed_event ? onCellSelect : undefined}
        isDndEnabled={!slot.is_fixed_event && !isLocked}
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
