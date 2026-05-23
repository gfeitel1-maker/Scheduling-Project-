import React from 'react'

export default function StatBadge({ label, value, color, onClick }) {
  const clickable = onClick && value > 0
  return (
    <div
      onClick={clickable ? onClick : undefined}
      style={{
        background: 'var(--bg)', border: `1px solid ${clickable ? color || 'var(--border)' : 'var(--border)'}`,
        borderRadius: 8, padding: '8px 14px', textAlign: 'center', minWidth: 90,
        cursor: clickable ? 'pointer' : 'default',
        transition: 'border-color 0.15s',
      }}
      title={clickable ? `Click to see details` : undefined}
    >
      <div style={{ fontFamily: 'var(--font-condensed)', fontSize: 20, fontWeight: 600, color: color || 'var(--text)' }}>{value}</div>
      <div style={{ fontSize: 11, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em', marginTop: 2 }}>
        {label}{clickable ? ' ↗' : ''}
      </div>
    </div>
  )
}
