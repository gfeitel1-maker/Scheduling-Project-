import { useState } from 'react'
import './scheduleGrid.css'

export const OVERLAY_COLOR = 'var(--accent)'
export const OVERLAY_BG = 'color-mix(in srgb, var(--accent) 9%, transparent)'
export const OVERLAY_TEXT = 'color-mix(in srgb, var(--accent) 60%, var(--text))'
export const OVERLAY_BORDER = 'var(--accent)'

export default function OverlayCell({
  label, onRemove, rowSpan = 1, showFillHandle = false, fillHandleDirection = 'vertical', onFillStart,
  // TRANSITIONAL (T54 -> deleted in T56), see SlotCell: ScheduleDayView is
  // still a <table>, so 'td' must remain the default.
  renderAs = 'td',
  gridRow,
  gridColumn,
  ariaColIndex,
  cellKey,
  collapsed = false,
}) {
  const [showRemoveBtn, setShowRemoveBtn] = useState(false)
  const isGrid = renderAs === 'gridcell'
  const Shell = isGrid ? 'div' : 'td'

  const shellProps = isGrid
    ? {
        role: 'gridcell',
        className: 'cell',
        style: { gridRow, gridColumn },
        'aria-colindex': ariaColIndex,
        'aria-rowspan': rowSpan > 1 ? rowSpan : undefined,
        'data-cell-key': cellKey,
        'data-collapsed': collapsed ? '' : undefined,
      }
    : {
        rowSpan,
        style: { padding: '8px 6px', verticalAlign: 'top', cursor: 'pointer' },
      }

  return (
    <Shell
      {...shellProps}
      onClick={() => setShowRemoveBtn(v => !v)}
    >
      <div
        className={isGrid ? 'cell-inner cell-inner--overlay' : undefined}
        style={{
          background: OVERLAY_BG,
          border: `1.5px solid ${OVERLAY_BORDER}`,
          ...(isGrid ? {} : {
            borderRadius: 8,
            padding: '10px 12px',
            minHeight: 56,
            height: '100%',
            position: 'relative',
            boxSizing: 'border-box',
          }),
        }}
      >
        <div
          className={isGrid ? 'cell-name cell-name--overlay' : undefined}
          style={isGrid ? undefined : {
            fontSize: 12,
            fontWeight: 700,
            color: OVERLAY_TEXT,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {label}
        </div>

        {showRemoveBtn && (
          <button
            className={isGrid ? 'overlay-remove' : undefined}
            onClick={e => { e.stopPropagation(); onRemove() }}
            style={{
              position: 'absolute',
              top: 4,
              right: 4,
              background: 'var(--danger)',
              color: '#fff',
              border: 'none',
              borderRadius: 4,
              fontSize: 10,
              padding: '2px 6px',
              cursor: 'pointer',
              fontWeight: 700,
              fontFamily: 'inherit',
            }}
          >
            ✕ Remove
          </button>
        )}

        {showFillHandle && (
          <div
            className={isGrid ? 'overlay-fill-handle' : undefined}
            title="Drag to make this field trip longer"
            onPointerDown={e => {
              e.preventDefault()
              e.stopPropagation()
              onFillStart?.()
            }}
            style={{
              position: 'absolute',
              bottom: -5,
              right: fillHandleDirection === 'both' ? -5 : '50%',
              transform: fillHandleDirection === 'both' ? 'none' : 'translateX(50%)',
              width: 12,
              height: 12,
              background: OVERLAY_COLOR,
              border: '2px solid white',
              borderRadius: 2,
              cursor: fillHandleDirection === 'both' ? 'se-resize' : 's-resize',
              zIndex: 10,
              userSelect: 'none',
            }}
          />
        )}
      </div>
    </Shell>
  )
}
