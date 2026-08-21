import { cellAccessibleName } from './cellLabel'
import './scheduleGrid.css'

// T108 Phase 2 (design §5.1, Designer spec §3) — renders a PULL override
// (applyDayOverrides stamps is_overridden + is_pull, activity_id null).
// Distinct from EmptyCell: NON-DROPPABLE (no useDraggable/onPlace/onCreateNew
// wiring at all — a director must not be able to drop an activity into a
// pulled cell) and NOT clickable to edit (pulls are authored only through
// override-authoring mode's CellInlineEditor "Pull" suggestion, per Designer
// spec §3.3 — a fait accompli here, not a new edit surface).
function PullIcon() {
  // "arrow-out" glyph, same construction as UnfillableIcon/OutdoorIcon in
  // SlotCell.jsx — 12x12 outline SVG, stroke="currentColor".
  return (
    <svg viewBox="0 0 12 12" width={12} height={12} fill="none" style={{ display: 'block' }}>
      <path d="M4.5 2 L2 2 L2 10 L4.5 10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M5 6 L10 6 M10 6 L7.5 3.5 M10 6 L7.5 8.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

export default function PulledCell({
  slot, rowSpan = 1, gridRow, gridColumn, ariaColIndex, cellKey, blockNames, column, collapsed = false,
}) {
  const note = slot?.day_override_note ?? null
  const label = 'Pulled'

  return (
    <div
      role="gridcell"
      className="cell"
      style={{ gridRow, gridColumn }}
      aria-colindex={ariaColIndex}
      aria-rowspan={rowSpan > 1 ? rowSpan : undefined}
      data-cell-key={cellKey}
      data-collapsed={collapsed ? '' : undefined}
      data-overridden="true"
      data-overridden-kind="pull"
      // No data-drop-disabled attribute needed for correctness (there is no
      // draggable/droppable wiring on this element at all — resolveHit skips
      // any coordinate that doesn't map to a droppable), but it's set anyway
      // for consistency with every other non-droppable cell's own marker.
      data-drop-disabled=""
      title={note ? `Pulled — ${note}` : 'Pulled for this day'}
      aria-label={cellAccessibleName({ subject: note ? `Pulled — ${note}` : 'Pulled', blockNames, column })}
    >
      <div className="cell-inner cell-inner--pulled">
        <div className="cell-pulled-label" data-pulled="">
          <PullIcon />
          {label}
        </div>
        {note && <div className="cell-pulled-note">{note}</div>}
      </div>
    </div>
  )
}
