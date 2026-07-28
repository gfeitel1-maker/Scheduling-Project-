// Shared schedule-cell constants and helpers. These live outside SlotCell.jsx
// so that component file only exports components — keeping Fast Refresh happy
// (react-refresh/only-export-components).

export const ACTIVITY_COLORS = ['#3F6690','#3C8C86','#5F8A5A','#8C6F26','#B26B47','#7C5E86']
export const ANCHOR_COLOR = 'var(--anchor)'

// UNFILLABLE is the only kind left in per-slot flags — UNDERSERVED/DISTRIBUTION
// moved to buildSchedule()'s aggregate `findings` array and WEATHER_RISK was
// removed from the engine entirely (see docs/adr/2026-07-28-schedule-flag-findings-reshape.md).
export const FLAG_COLORS = {
  UNFILLABLE: 'var(--danger)',
}

export const REAL_FLAG_NAMES = new Set(Object.keys(FLAG_COLORS))

// Severity is a distinct lookup from FLAG_COLORS (hue) on purpose — kept
// separate so a future 4th kind can't silently inherit visual weight from a
// "similar enough" color. Consumed by both slot flags and findings.
export const FLAG_SEVERITY = {
  UNFILLABLE: 'danger',
  UNDERSERVED: 'caution',
  DISTRIBUTION: 'info',
}

export const SEVERITY_BAR_COLOR = {
  danger: 'var(--danger)',
  caution: 'var(--accent)',
  info: 'var(--secondary)',
}

// Duplicated verbatim from buildSchedule.js:17-24 rather than imported —
// coupling the pure engine module to a UI constants file is the wrong
// direction; this is 6 lines, not an abstraction (karpathy-guidelines).
function djb2(str) {
  let hash = 5381
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) + str.charCodeAt(i)
    hash = hash & hash
  }
  return Math.abs(hash)
}

// Stable across reorders/additions — keyed by the activity's persisted id,
// never by array position. With 6 colors and 15-30 typical activities,
// collisions are unavoidable by pigeonhole; activity name remains the
// identifying signal, color is supplementary (see Architect's ADR §6).
export function activityColor(activityId) {
  return ACTIVITY_COLORS[djb2(String(activityId)) % ACTIVITY_COLORS.length]
}

export const cellTd = { padding: '8px 6px', verticalAlign: 'top', cursor: 'pointer' }
export const emptyTd = { padding: '8px 6px', verticalAlign: 'top' }
