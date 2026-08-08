import React, { useEffect, useState } from 'react'

// Loading state for the schedule screen, shaped to the real post-load layout
// (controls bar, badge row, grid frame) so the swap from skeleton to content
// is a substitution rather than a teleport. DESIGN_STANDARD §5b.
// docs/work/specs/DESIGN-SPEC-schedule-screen-20260807.md (SPEC 3)

const skeletonBlock = {
  background: 'color-mix(in srgb, var(--text) 6%, var(--surface))',
  borderRadius: 6,
  backgroundImage: 'linear-gradient(90deg, transparent 0%, color-mix(in srgb, var(--text) 4%, transparent) 50%, transparent 100%)',
  backgroundSize: '55% 100%',
  backgroundRepeat: 'no-repeat',
  animation: 'shoresh-skeleton-shimmer 1200ms linear infinite',
}

const visuallyHidden = {
  position: 'absolute',
  width: 1,
  height: 1,
  clipPath: 'inset(50%)',
  overflow: 'hidden',
}

export default function ScheduleSkeleton() {
  const [entered, setEntered] = useState(false)
  useEffect(() => {
    const id = requestAnimationFrame(() => setEntered(true))
    return () => cancelAnimationFrame(id)
  }, [])

  const fadeStyle = {
    opacity: entered ? 1 : 0,
    transition: 'opacity var(--motion-fast) var(--ease-out)',
  }

  return (
    <div style={{ maxWidth: '100%', ...fadeStyle }} role="status" aria-live="polite" aria-busy="true">
      <span style={visuallyHidden}>Loading schedule…</span>

      {/* Band 1 — controls bar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
        {[140, 180, 96, 120, 88].map((w, i) => (
          <div key={i} className="shoresh-skeleton-block" style={{ ...skeletonBlock, width: w, height: 32, borderRadius: 6 }} />
        ))}
      </div>

      {/* Band 2 — badge row */}
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 20 }}>
        {[0, 1, 2, 3].map(i => (
          <div key={i} className="shoresh-skeleton-block" style={{ ...skeletonBlock, width: 104, height: 56, borderRadius: 8 }} />
        ))}
      </div>

      {/* Band 3 — grid frame */}
      <div className="shoresh-skeleton-block" style={{ ...skeletonBlock, height: 420, width: '100%', borderRadius: 6 }} />
    </div>
  )
}
