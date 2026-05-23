import React from 'react'

const ACTIVITY_COLORS = ['#00ADBB','#2F7DE1','#00AA59','#A63595','#F0585D','#7DC433']
export const ANCHOR_COLOR = '#A63595'

export const FLAG_COLORS = {
  UNFILLABLE: '#F0585D',
  UNDERSERVED: '#F5A623',
  WEATHER_RISK: '#2F7DE1',
  DISTRIBUTION: '#7DC433',
}

export function activityColor(idx) { return ACTIVITY_COLORS[idx % ACTIVITY_COLORS.length] }

export const cellTd = { padding: '6px 8px', width: 100, minWidth: 80, verticalAlign: 'top', cursor: 'pointer' }
export const emptyTd = { padding: '6px 8px', width: 100, minWidth: 80, background: 'var(--bg)', opacity: 0.3 }

export default function SlotCell({ slot, activity, anchor, actColorIdx, weatherMode, onEdit }) {
  if (!slot) return <td style={emptyTd} />

  if (slot.type === 'anchor') {
    return (
      <td style={{ ...cellTd, background: '#F3E8FA', borderLeft: `3px solid ${ANCHOR_COLOR}` }}>
        <div style={{ fontSize: 11, fontWeight: 600, color: ANCHOR_COLOR, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {anchor?.name || 'Anchor'}
        </div>
      </td>
    )
  }

  if (slot.type === 'unavailable') {
    return <td style={{ ...cellTd, background: 'var(--bg)', opacity: 0.4 }} />
  }

  const flags = slot.flags || {}
  const hasFlags = Object.keys(flags).length > 0
  const isOutdoor = flags.WEATHER_RISK
  const color = activity ? activityColor(actColorIdx) : '#E0E0E0'
  const isWeatherHighlight = weatherMode && isOutdoor

  return (
    <td
      style={{
        ...cellTd,
        background: activity ? `${color}18` : '#F8F8F8',
        borderLeft: activity ? `3px solid ${color}` : '3px solid #E0E0E0',
        outline: isWeatherHighlight ? '2px solid #2F7DE1' : 'none',
        cursor: 'pointer',
        position: 'relative',
      }}
      onClick={() => onEdit(slot)}
      title={activity?.name || 'Empty — click to assign'}
    >
      <div style={{ fontSize: 11, fontWeight: activity ? 600 : 400, color: activity ? color : 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {activity?.name || <span style={{ opacity: 0.5 }}>—</span>}
      </div>
      {hasFlags && (
        <div style={{ display: 'flex', gap: 2, marginTop: 2, flexWrap: 'wrap' }}>
          {Object.keys(flags).map(f => (
            <span key={f} style={{ width: 6, height: 6, borderRadius: '50%', background: FLAG_COLORS[f] || '#ccc', display: 'inline-block' }} title={f} />
          ))}
        </div>
      )}
    </td>
  )
}
