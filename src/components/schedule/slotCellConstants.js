// Shared schedule-cell constants and helpers. These live outside SlotCell.jsx
// so that component file only exports components — keeping Fast Refresh happy
// (react-refresh/only-export-components).

export const ACTIVITY_COLORS = ['#3F6690','#3C8C86','#5F8A5A','#8C6F26','#B26B47','#7C5E86']
export const ANCHOR_COLOR = 'var(--anchor)'

// Per-slot flags are UNFILLABLE (generated route) and OVERLAP (manual route).
// UNDERSERVED/DISTRIBUTION are aggregate findings, not slot states, and
// WEATHER_RISK was removed from the engine entirely
// (docs/adr/2026-07-28-schedule-flag-findings-reshape.md).
//
// OVERLAP is bronze (caution), not red: on the manual route a clash is a
// consequence the director chose to accept and can resolve, not a failure.
// Red stays reserved so it stays loud (DESIGN_STANDARD.md §4).
export const FLAG_COLORS = {
  UNFILLABLE: 'var(--danger)',
  OVERLAP: 'var(--accent)',
}

export const REAL_FLAG_NAMES = new Set(Object.keys(FLAG_COLORS))

// Severity is a distinct lookup from FLAG_COLORS (hue) on purpose — kept
// separate so a future 4th kind can't silently inherit visual weight from a
// "similar enough" color. Consumed by both slot flags and findings.
export const FLAG_SEVERITY = {
  UNFILLABLE: 'danger',
  OVERLAP: 'caution',
  UNDERSERVED: 'caution',
  DISTRIBUTION: 'info',
}

export const SEVERITY_BAR_COLOR = {
  danger: 'var(--danger)',
  caution: 'var(--accent)',
  info: 'var(--secondary)',
}

// What the grid legend documents.
//
// Previously the legend was rendered straight from FLAG_COLORS, so it explained
// exactly one of the four treatments a director can actually see on the grid:
// UNFILLABLE. The bronze "locked" bar, the slate fixed-event bar, and the grey
// unavailable fill all appeared with nothing on screen saying what they meant.
// DESIGN_STANDARD.md §4 requires anchor to be documented separately from the
// activity key; it was not.
//
// Two rules this encodes, both deliberate:
//
// 1. `shape` is not decoration. A flag is a problem to act on (dot); locked and
//    fixed are structural chrome (left bar, matching cellStructuralBar); an
//    unavailable slot is an absence (filled block). Locked and fixed differ from
//    each other by hue alone, which is why the legend naming them matters — it is
//    the non-colour channel for that distinction.
// 2. `label` is director language, not the enum key. A camp director does not
//    read SCREAMING_SNAKE (CONSTITUTION.md Art. V). `flagKey` keeps the tie to
//    the engine's vocabulary for the entries that have one.
//
// UNDERSERVED and DISTRIBUTION are deliberately absent: they are aggregate
// findings, not per-slot states, and are surfaced in the stat tiles instead
// (ADR 2026-07-28-schedule-flag-findings-reshape).
const OVERLAP_ENTRY = {
  flagKey: 'OVERLAP',
  label: 'Overlapping',
  shape: 'dot',
  color: FLAG_COLORS.OVERLAP,
  description: 'More groups booked in than this activity holds',
}

const UNFILLABLE_ENTRY = {
  flagKey: 'UNFILLABLE',
  label: 'Unfillable',
  shape: 'dot',
  color: FLAG_COLORS.UNFILLABLE,
  description: 'No eligible activity could be placed here',
}

export const LEGEND_ENTRIES = [
  UNFILLABLE_ENTRY,
  OVERLAP_ENTRY,
  {
    flagKey: null,
    label: 'Locked',
    shape: 'bar',
    color: 'var(--accent)',
    description: 'Held in place — regenerating will not move it',
  },
  {
    flagKey: null,
    label: 'Fixed event',
    shape: 'bar',
    color: ANCHOR_COLOR,
    description: 'Same slot every day — meals, tefillah, flagpole',
  },
  {
    flagKey: null,
    label: 'Unavailable',
    shape: 'block',
    color: 'color-mix(in srgb, var(--text) 5%, var(--bg))',
    description: 'This group is not scheduled during this block',
  },
]

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

// The two routes share a flag VOCABULARY, not an identical flag SET: a word
// used on both means the same thing on both, but 'Unfillable' does not exist
// on the manual route at all — an empty cell there is simply not filled yet —
// and 'Overlapping' does not exist on the generated route, where the engine
// refuses a clashing placement rather than making one.
export function legendEntriesFor(route) {
  const omit = route === 'manual' ? 'UNFILLABLE' : 'OVERLAP'
  return LEGEND_ENTRIES.filter(e => e.flagKey !== omit)
}
