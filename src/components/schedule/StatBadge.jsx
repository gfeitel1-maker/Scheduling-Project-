import React from 'react'
import { ChevronIcon } from '../icons'

// A single concern tile above the grid. On the generated route these are the
// "track changes" boxes: clicking one lights up the cells that concern touches
// and opens the review list. `active` is the pressed/selected state — the box
// the director is currently reviewing.
// docs/work/specs/2026-08-01-generated-flag-review.md
export default function StatBadge({ label, value, color, onClick, active = false }) {
  const clickable = onClick && value > 0
  const accent = color || 'var(--border)'
  return (
    <button
      type="button"
      onClick={clickable ? onClick : undefined}
      disabled={!clickable}
      aria-pressed={clickable ? active : undefined}
      className={clickable ? 'press-98' : undefined}
      style={{
        // Active box carries the concern colour on its border AND a faint fill,
        // so the one being reviewed reads as pressed at a glance — the same
        // relationship the lit cells have to the calm grid.
        background: active ? `color-mix(in srgb, ${accent} 10%, var(--bg))` : 'var(--bg)',
        border: `1px solid ${active ? accent : (clickable ? accent : 'var(--border)')}`,
        borderRadius: 8, padding: '8px 14px', textAlign: 'center', minWidth: 90,
        cursor: clickable ? 'pointer' : 'default',
        font: 'inherit',
        color: 'inherit',
        display: 'block',
        width: 'auto',
        transition: 'border-color var(--motion-fast) var(--ease-out), background var(--motion-fast) var(--ease-out)',
      }}
      title={clickable ? (active ? 'Reviewing — click to stop' : 'Click to review these') : undefined}
    >
      <div style={{ fontFamily: 'var(--font-condensed)', fontSize: 20, fontWeight: 600, color: color || 'var(--text)' }}>{value}</div>
      {/* T18: no textTransform. The labels are director-facing sentences now
          ("Spread across the week", not "DISTRIBUTION"), and a long label in
          caps is markedly harder to scan than a short one — the uppercase
          treatment was carrying visual weight that the words should carry.
          Letter-spacing goes with it: it exists to make caps legible. */}
      {/* The affordance is the app's ordinary disclosure chevron, rotating to
          show state — because that is what this tile does: it opens a review
          list. It previously rendered `↗` when idle and `▾` when active, two
          unrelated metaphors (external-link, dropdown) standing in for one
          on/off state, neither of which said "reviewing".

          Rendered inline rather than in a flex row so a long label ("Spread
          across the week") still wraps normally and the chevron stays with the
          last line. */}
      <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 2 }}>
        {label}
        {clickable && (
          <ChevronIcon
            expanded={active}
            style={{ display: 'inline-block', marginLeft: 4, verticalAlign: 'middle' }}
          />
        )}
      </div>
    </button>
  )
}
