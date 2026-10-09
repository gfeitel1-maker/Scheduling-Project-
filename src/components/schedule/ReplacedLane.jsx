import { replacedLaneRows, replacedLaneNotes, replacedCellLabel } from '../../screens/schedule/replacedLane'

// T350 slice 4 (docs/work/specs/T350-slice4-replaced-day-render.md). A day of
// this week bound to a special day: one vocabulary for every view and both
// routes — a slate header mark, the name as the link, a read-only lane.

// The special day's name IS the link that opens it for editing.
export function LaneOpen({ replacement, onOpenSpecialDay }) {
  return (
    <button type="button" className="lane-open" title={replacement.name} onClick={() => onOpenSpecialDay?.(replacement.specialDayId)}>
      {replacement.name}
      <svg className="lane-open-chevron" aria-hidden="true" width="10" height="10" viewBox="0 0 10 10">
        <path d="M3.5 2 6.5 5 3.5 8" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </button>
  )
}

export function PlacementConflictDot({ replacement }) {
  if (!replacement.conflictTitle) return null
  return <span className="flag flag--placement-conflict" title={replacement.conflictTitle} />
}

export function ReplacedColumnHeader({ label, replacement, ariaColIndex, style, onOpenSpecialDay }) {
  return (
    <div
      role="columnheader"
      className="cell"
      aria-colindex={ariaColIndex}
      data-replaced=""
      data-placement-conflict={replacement.conflictTitle ? '' : undefined}
      style={{ ...style, position: 'relative' }}
    >
      <span>{label}</span>
      <LaneOpen replacement={replacement} onOpenSpecialDay={onOpenSpecialDay} />
      <PlacementConflictDot replacement={replacement} />
    </div>
  )
}

// The dashed "empty" box, labelled with the name: an empty special day has one
// useful action, opening it.
export function EmptyLaneBox({ replacement, onOpenSpecialDay }) {
  return (
    <div className="cell-empty" title={replacement.name} onClick={() => onOpenSpecialDay?.(replacement.specialDayId)}>
      {replacement.name}
    </div>
  )
}

export function ReplacedCellContent({ label, activityId }) {
  if (!label) return null
  return activityId
    ? <span className="replaced-cell"><span className="cell-name">{label}</span></span>
    : <span className="replaced-cell">{label}</span>
}

// One grid item spanning every camp row. `subjectId` is the first cell-key
// segment (the group, or the activity in the drilldown); the `replaced` third
// segment matches no block id, so no drop or paste can ever address it.
// `groupId` null shows no rows (the activity drilldown ignores a replaced day).
export default function ReplacedLane({ replacement, subjectId, groupId, campBlockCount, ariaColIndex, style, actMap, onOpenSpecialDay }) {
  const empty = replacement.blocks.length === 0
  const rows = groupId ? replacedLaneRows({ replacement, groupId, actMap }) : []
  const notes = groupId ? replacedLaneNotes(replacement) : ''
  return (
    <div
      role="gridcell"
      className="cell replaced-lane"
      aria-colindex={ariaColIndex}
      aria-rowspan={campBlockCount}
      aria-readonly="true"
      aria-label={replacement.name}
      data-replaced=""
      data-empty-lane={empty ? '' : undefined}
      data-cell-key={`${subjectId}|${replacement.dayId}|replaced`}
      data-drop-disabled=""
      style={{ ...style, gridRow: '1 / -1', '--lane-rows': String(replacement.blocks.length || 1) }}
    >
      {empty
        ? <EmptyLaneBox replacement={replacement} onOpenSpecialDay={onOpenSpecialDay} />
        : rows.map(r => (
          <div key={r.blockId} className="replaced-lane-row" title={r.blockName}>
            <span className="block-time">{r.time}</span>
            <ReplacedCellContent label={r.label} activityId={r.activityId} />
          </div>
        ))}
      {notes && <div className="replaced-lane-notes">{notes}</div>}
    </div>
  )
}

// Day view: one read-only cell of the special day's own grid.
export function ReplacedDayCell({ replacement, groupId, blockId, ariaColIndex, style, actMap }) {
  return (
    <div
      role="gridcell"
      className="cell replaced-day-cell"
      aria-colindex={ariaColIndex}
      aria-readonly="true"
      data-replaced=""
      data-cell-key={`${groupId}|${replacement.dayId}|replaced`}
      data-drop-disabled=""
      style={style}
    >
      <ReplacedCellContent {...replacedCellLabel({ replacement, groupId, blockId, actMap })} />
    </div>
  )
}
