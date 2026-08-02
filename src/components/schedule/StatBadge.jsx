import React from 'react'

// A single concern tile above the grid. On the generated route these are the
// "track changes" boxes: clicking one lights up the cells that concern touches
// and opens the review list. `active` is the pressed/selected state — the box
// the director is currently reviewing.
// docs/work/specs/2026-08-01-generated-flag-review.md
export default function StatBadge({ label, value, color, onClick, active = false }) {
  const clickable = onClick && value > 0
  const accent = color || 'var(--border)'
  return (
    <div
      onClick={clickable ? onClick : undefined}
      aria-pressed={clickable ? active : undefined}
      style={{
        // Active box carries the concern colour on its border AND a faint fill,
        // so the one being reviewed reads as pressed at a glance — the same
        // relationship the lit cells have to the calm grid.
        background: active ? `color-mix(in srgb, ${accent} 10%, var(--bg))` : 'var(--bg)',
        border: `1px solid ${active ? accent : (clickable ? accent : 'var(--border)')}`,
        borderRadius: 8, padding: '8px 14px', textAlign: 'center', minWidth: 90,
        cursor: clickable ? 'pointer' : 'default',
        transition: 'border-color 0.15s, background 0.15s',
      }}
      title={clickable ? (active ? 'Reviewing — click to stop' : 'Click to review these') : undefined}
    >
      <div style={{ fontFamily: 'var(--font-condensed)', fontSize: 20, fontWeight: 600, color: color || 'var(--text)' }}>{value}</div>
      {/* T18: no textTransform. The labels are director-facing sentences now
          ("Spread across the week", not "DISTRIBUTION"), and a long label in
          caps is markedly harder to scan than a short one — the uppercase
          treatment was carrying visual weight that the words should carry.
          Letter-spacing goes with it: it exists to make caps legible. */}
      <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 2 }}>
        {label}{clickable ? (active ? ' ▾' : ' ↗') : ''}
      </div>
    </div>
  )
}
