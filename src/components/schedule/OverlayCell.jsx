import { useState } from 'react'
import { cellAccessibleName } from './cellLabel'
import './scheduleGrid.css'

export const OVERLAY_COLOR = 'var(--accent)'
export const OVERLAY_BG = 'color-mix(in srgb, var(--accent) 9%, transparent)'
export const OVERLAY_TEXT = 'color-mix(in srgb, var(--accent) 60%, var(--text))'
export const OVERLAY_BORDER = 'var(--accent)'

export default function OverlayCell({
  label, onRemove, rowSpan = 1, showFillHandle = false, fillHandleDirection = 'vertical', onFillStart,
  // Placement comes from placeCell at the call site (gridPlacement.js).
  gridRow,
  gridColumn,
  ariaColIndex,
  cellKey,
  // T59. Span extent and column, for the accessible name.
  blockNames,
  column,
  collapsed = false,
}) {
  const [showRemoveBtn, setShowRemoveBtn] = useState(false)

  return (
    <div
      role="gridcell"
      className="cell"
      style={{ gridRow, gridColumn }}
      aria-colindex={ariaColIndex}
      aria-label={cellAccessibleName({ subject: label, blockNames, column })}
      aria-rowspan={rowSpan > 1 ? rowSpan : undefined}
      data-cell-key={cellKey}
      // An overlay cell never had a droppable, so pointer-resolved hits must be
      // rejected here the same way (T58, resolveHit).
      data-cell-kind="overlay"
      data-collapsed={collapsed ? '' : undefined}
      onClick={() => setShowRemoveBtn(v => !v)}
    >
      {/* Every static value here — background, border, the remove button's box,
          the fill handle's box — is in scheduleGrid.css rather than inline:
          T55 showed that an inline value silently beats the collapsed rule that
          has to hide or shrink it. */}
      <div className="cell-inner cell-inner--overlay">
        <div className="cell-name cell-name--overlay">{label}</div>

        {showRemoveBtn && (
          <button
            className="overlay-remove"
            onClick={e => { e.stopPropagation(); onRemove() }}
          >
            ✕ Remove
          </button>
        )}

        {showFillHandle && (
          <div
            className="overlay-fill-handle"
            data-direction={fillHandleDirection}
            title="Drag to make this field trip longer"
            onPointerDown={e => {
              e.preventDefault()
              e.stopPropagation()
              onFillStart?.()
            }}
          />
        )}
      </div>
    </div>
  )
}
