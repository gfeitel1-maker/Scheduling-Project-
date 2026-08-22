import { useState } from 'react'
import { cellAccessibleName } from './cellLabel'
import CellInlineEditor from './CellInlineEditor'
import './scheduleGrid.css'

// T112. Shared empty-cell component — replaces three near-identical static
// copies (ManualBuildView.EmptyDropCell, ScheduleGroupView.EmptyCell,
// ScheduleDayView.EmptyCell). An empty cell is the `currentActivityName ===
// null` case SlotCell's filled branch already handles; this component gives
// it the same local `editing` state + CellInlineEditor mount, so clicking (or
// Enter on a focused) empty cell opens the editor at the point of intent
// instead of requiring a drag-in-then-right-click detour.
//
// No per-cell droppable: T58 moved hit resolution to the grid surface, and
// the drop-target paint to `.cell[data-drag-over]` in scheduleGrid.css.
// `data-cell-key` is what makes this cell findable from pointer coordinates —
// unchanged by adding a click handler, since there is no ref to fight over
// (design doc §0/§4).
export default function EmptyCell({
  groupId, dayId, blockId, gridRow, gridColumn, ariaColIndex, collapsed, blockNames, column,
  // Commit-path props — same shape SlotCell's filled branch already receives.
  // electiveSetsAll/electiveMembersBySet are SlotCell's RENDER lookups for an
  // EXISTING elective's label; an empty cell has no existing content to
  // label (currentActivityName is always null below), so they are not part
  // of this component's prop surface.
  eligibleActivities = [], onPlace, onCreateNew, onCreateElective,
  // Stamp mode (field-trip overlay tool, generated route only) wins over
  // opening the editor — mirrors SlotCell's onCellClick-before-setEditing
  // gating. ManualBuildView never passes this (no stamp mode there).
  onCellClick,
  // Paste mode wins over opening the editor but loses to stamp mode — the
  // three-way precedence is stamp > paste > edit (design addendum decision
  // 4). onCellSelect is only invoked when pasteMode is true; an empty cell
  // has nothing to select outside of paste mode (design §2 decision 1).
  pasteMode = false, onCellSelect,
}) {
  const [editing, setEditing] = useState(false)

  const slot = { groupId, dayId, blockId }
  const cellKey = `${groupId}|${dayId}|${blockId}`

  function activate(e) {
    if (onCellClick) { onCellClick(slot); return true }
    if (pasteMode && onCellSelect) { onCellSelect(slot, e); return true }
    return false
  }

  function handleClick(e) {
    if (activate(e)) return
    setEditing(true)
  }

  // Mirrors SlotCell.handleEnterKeyDown: same stamp-mode precedence, no paste
  // check (paste, like multi-select, has no keyboard entry point today).
  function handleEnterKeyDown(e) {
    if (editing) return
    e.preventDefault()
    if (onCellClick) { onCellClick(slot); return }
    setEditing(true)
  }

  return (
    <div
      role="gridcell"
      className="cell"
      data-empty=""
      data-cell-key={cellKey}
      data-collapsed={collapsed ? '' : undefined}
      aria-colindex={ariaColIndex}
      // T59. An open cell announces as open, never as a blank cell.
      aria-label={cellAccessibleName({ subject: 'Open', blockNames, column })}
      style={{ gridRow, gridColumn }}
      onClick={handleClick}
      onKeyDown={e => { if (e.key === 'Enter') handleEnterKeyDown(e) }}
    >
      {editing ? (
        <CellInlineEditor
          eligibleActivities={eligibleActivities}
          currentActivityName={null}
          onPlace={(activityId) => { setEditing(false); onPlace?.(slot, activityId) }}
          onCreateNew={(name) => { setEditing(false); onCreateNew?.(slot, name) }}
          onCreateElective={onCreateElective ? (setName, memberNames) => { setEditing(false); onCreateElective(slot, setName, memberNames) } : undefined}
          onCancel={() => setEditing(false)}
        />
      ) : (
        // "Open" is deliberately visible text, not a blank box — matches
        // scheduleGrid.css's "visible, not invisible" empty-cell philosophy
        // (design addendum decision 5: a conscious, consistent choice across
        // all three views, not a merge artifact). Reads as "open time" (W7 voice).
        <div className="cell-empty">Open</div>
      )}
    </div>
  )
}
