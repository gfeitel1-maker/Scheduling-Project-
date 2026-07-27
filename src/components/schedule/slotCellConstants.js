// Shared schedule-cell constants and helpers. These live outside SlotCell.jsx
// so that component file only exports components — keeping Fast Refresh happy
// (react-refresh/only-export-components).

export const ACTIVITY_COLORS = ['#3F6690','#3C8C86','#5F8A5A','#8C6F26','#B26B47','#7C5E86']
export const ANCHOR_COLOR = 'var(--anchor)'

export const FLAG_COLORS = {
  UNFILLABLE: 'var(--danger)',
  UNDERSERVED: 'var(--primary)',
  WEATHER_RISK: 'var(--accent)',
  DISTRIBUTION: 'var(--secondary)',
}

export const REAL_FLAG_NAMES = new Set(Object.keys(FLAG_COLORS))

export function activityColor(idx) { return ACTIVITY_COLORS[idx % ACTIVITY_COLORS.length] }

export const cellTd = { padding: '8px 6px', verticalAlign: 'top', cursor: 'pointer' }
export const emptyTd = { padding: '8px 6px', verticalAlign: 'top' }
