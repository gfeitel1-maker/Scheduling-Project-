import React from 'react'
import { useDraggable, useDroppable } from '@dnd-kit/core'

const ACTIVITY_COLORS = ['#00ADBB','#2F7DE1','#00AA59','#A63595','#F0585D','#7DC433']
export const ANCHOR_COLOR = '#A63595'

export const FLAG_COLORS = {
  UNFILLABLE: '#F0585D',
  UNDERSERVED: '#F5A623',
  WEATHER_RISK: '#2F7DE1',
  DISTRIBUTION: '#7DC433',
}

export function activityColor(idx) { return ACTIVITY_COLORS[idx % ACTIVITY_COLORS.length] }

export const cellTd = { padding: '8px 6px', verticalAlign: 'top', cursor: 'pointer' }
export const emptyTd = { padding: '8px 6px', verticalAlign: 'top' }

export default function SlotCell({ slot, activity, anchor, actColorIdx, weatherMode, onEdit, isDndEnabled }) {
  const id = slot ? `${slot.groupId}|${slot.dayId}|${slot.blockId}` : 'empty'
  const canDrag = isDndEnabled && slot?.type === 'activity'

  const { attributes, listeners, setNodeRef: setDragRef, isDragging } = useDraggable({
    id,
    disabled: !canDrag,
    data: { slot },
  })
  const { setNodeRef: setDropRef, isOver } = useDroppable({
    id: `drop-${id}`,
    disabled: !isDndEnabled,
    data: { slot },
  })

  const setRef = el => { setDragRef(el); setDropRef(el) }

  if (!slot) return <td style={emptyTd} />

  if (slot.type === 'anchor') {
    return (
      <td ref={setRef} style={cellTd} onClick={() => onEdit(slot)}>
        <div style={{
          background: '#F3E8FA',
          border: '1.5px solid #A6359566',
          borderRadius: 8,
          padding: '10px 12px',
          minHeight: 56,
          display: 'flex',
          alignItems: 'center',
        }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: ANCHOR_COLOR, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {anchor?.name || 'Anchor'}
          </div>
        </div>
      </td>
    )
  }

  if (slot.type === 'unavailable') {
    return (
      <td ref={setRef} style={emptyTd}>
        <div style={{ background: 'var(--bg)', border: '1.5px dashed #D8C8B8', borderRadius: 8, minHeight: 56, opacity: 0.5 }} />
      </td>
    )
  }

  const flags = slot.flags || {}
  const hasFlags = Object.keys(flags).length > 0
  const isOutdoor = flags.WEATHER_RISK
  const color = activity ? activityColor(actColorIdx) : null
  const isWeatherHighlight = weatherMode && isOutdoor

  const innerStyle = activity
    ? {
        background: `${color}1E`,
        border: isWeatherHighlight ? `2px solid #2F7DE1` : `1.5px solid ${color}55`,
        borderRadius: 8,
        padding: '10px 12px',
        minHeight: 56,
        opacity: isDragging ? 0.4 : 1,
        outline: isOver && isDndEnabled ? '2px solid var(--primary)' : 'none',
        outlineOffset: -2,
      }
    : {
        background: 'var(--bg)',
        border: '1.5px dashed #D8C8B8',
        borderRadius: 8,
        padding: '10px 12px',
        minHeight: 56,
      }

  return (
    <td
      ref={setRef}
      style={{
        ...cellTd,
        cursor: canDrag ? (isDragging ? 'grabbing' : 'grab') : 'pointer',
      }}
      onClick={() => onEdit(slot)}
      title={activity?.name || 'Empty — click to assign'}
      {...(canDrag ? { ...listeners, ...attributes } : {})}
    >
      <div style={innerStyle}>
        <div style={{
          fontSize: 12,
          fontWeight: activity ? 700 : 500,
          color: activity ? color : '#B0A090',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}>
          {activity?.name || <span style={{ fontSize: 11 }}>Unassigned</span>}
        </div>
        {hasFlags && (
          <div style={{ display: 'flex', gap: 2, marginTop: 4, flexWrap: 'wrap' }}>
            {Object.keys(flags).map(f => (
              <span key={f} style={{ width: 6, height: 6, borderRadius: '50%', background: FLAG_COLORS[f] || '#ccc', display: 'inline-block' }} title={f} />
            ))}
          </div>
        )}
      </div>
    </td>
  )
}
