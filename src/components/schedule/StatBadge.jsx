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
      {/* T18: no textTransform. The labels are director-facing sentences now
          ("Spread across the week", not "DISTRIBUTION"), and a long label in
          caps is markedly harder to scan than a short one — the uppercase
          treatment was carrying visual weight that the words should carry.
          Letter-spacing goes with it: it exists to make caps legible. */}
      <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 2 }}>
        {label}{clickable ? ' ↗' : ''}
      </div>
    </div>
  )
}
