import React from 'react'

// Indeterminate progress bar for schedule generation. DESIGN_STANDARD §5b:
// a 2px bar in var(--primary) pinned to the top of the affected panel.
// docs/work/specs/DESIGN-SPEC-schedule-screen-20260807.md (SPEC 4)

const track = {
  position: 'absolute',
  top: 0,
  left: 0,
  right: 0,
  height: 2,
  overflow: 'hidden',
  background: 'color-mix(in srgb, var(--primary) 12%, transparent)',
  borderRadius: 1,
  zIndex: 3,
  pointerEvents: 'none',
}

const fill = {
  height: '100%',
  width: '30%',
  background: 'var(--primary)',
  borderRadius: 1,
  animation: 'shoresh-indeterminate 1100ms linear infinite',
}

export default function IndeterminateBar() {
  return (
    <div style={track} role="progressbar" aria-label="Generating schedule">
      <div className="shoresh-indeterminate-fill" style={fill} />
    </div>
  )
}
