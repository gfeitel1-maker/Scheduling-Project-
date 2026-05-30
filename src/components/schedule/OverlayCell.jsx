import { useState } from 'react'

export const OVERLAY_COLOR = '#f59e0b'
export const OVERLAY_BG = '#f59e0b18'
export const OVERLAY_TEXT = '#d97706'
export const OVERLAY_BORDER = '#f59e0b'

export default function OverlayCell({ label, onRemove, rowSpan = 1, showFillHandle = false, fillHandleDirection = 'vertical', onFillStart }) {
  const [showRemoveBtn, setShowRemoveBtn] = useState(false)

  return (
    <td
      rowSpan={rowSpan}
      style={{ padding: '8px 6px', verticalAlign: 'top', cursor: 'pointer' }}
      onClick={() => setShowRemoveBtn(v => !v)}
    >
      <div style={{
        background: OVERLAY_BG,
        border: `1.5px solid ${OVERLAY_BORDER}`,
        borderRadius: 8,
        padding: '10px 12px',
        minHeight: 56,
        height: '100%',
        position: 'relative',
        boxSizing: 'border-box',
      }}>
        <div style={{
          fontSize: 12,
          fontWeight: 700,
          color: OVERLAY_TEXT,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}>
          {label}
        </div>

        {showRemoveBtn && (
          <button
            onClick={e => { e.stopPropagation(); onRemove() }}
            style={{
              position: 'absolute',
              top: 4,
              right: 4,
              background: '#DC2626',
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
            title="Drag to extend overlay"
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
    </td>
  )
}
