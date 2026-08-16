// Shared schedule-cell constants and helpers. These live outside SlotCell.jsx
// so that component file only exports components — keeping Fast Refresh happy
// (react-refresh/only-export-components).

// T18. Six hues on six rungs of a lightness ladder — hue carries identity for
// most people, lightness carries it for everyone else.
//
// The previous set was chosen for hue alone, and three of its six collapsed
// into one colour for anyone with red-green colour blindness (~6% of men).
// Measured as the smallest distance between any two entries:
//
//                     normal  deuteranopia  protanopia  greyscale
//   was                   39             6           5          2
//   now                   34            20          17         17
//
// Slightly less separation for normal vision, several times more for everyone
// else — and the greyscale figure is the one that matters most in practice,
// because camps print schedules. At 2, a printed dot was indistinguishable
// from any other.
//
// This is a token-value change and the aesthetic call is the director's; the
// constraint that must survive any reshuffle is the one in
// slotCellConstants.test.js, not these exact values.
export const ACTIVITY_COLORS = ['#305C7B','#3D7D84','#4B8C60','#B6A050','#B68B6B','#BE6BC7']
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
  // Slate, distinct from OVERLAP's bronze so the two manual-route dots are told
  // apart by hue, not position alone. Still out of the reserved red. The exact
  // token is the director's aesthetic call (like OVERLAP's); see
  // docs/work/specs/2026-08-16-manual-route-week-exclusions-design.md §5.
  WEEK_CLOSED: 'var(--secondary)',
}

// Severity is a distinct lookup from FLAG_COLORS (hue) on purpose — kept
// separate so a future 4th kind can't silently inherit visual weight from a
// "similar enough" color. Consumed by both slot flags and findings.
export const FLAG_SEVERITY = {
  UNFILLABLE: 'danger',
  OVERLAP: 'caution',
  WEEK_CLOSED: 'caution',
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

// Manual route only, like OVERLAP: the activity or its group is marked not to
// run this week (week availability). A soft marker — the placement is kept.
const WEEK_CLOSED_ENTRY = {
  flagKey: 'WEEK_CLOSED',
  label: 'Closed this week',
  shape: 'dot',
  color: FLAG_COLORS.WEEK_CLOSED,
  description: 'This activity or group is marked not to run this week',
}

export const LEGEND_ENTRIES = [
  UNFILLABLE_ENTRY,
  OVERLAP_ENTRY,
  WEEK_CLOSED_ENTRY,
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

// Which colour each activity gets.
//
// The hash alone was not enough. djb2 % 6 is a preference, not an assignment,
// and on a real camp it collided badly: with only FOUR activities
// (basketball, flag football, soccer, swim) three of them landed on the same
// entry, so the dot distinguished exactly one activity out of four. Colour
// exists to tell activities apart at a glance; that failed at the smallest
// scale anyone would ever run.
//
// So the hash still chooses, and a collision walks to the next free entry.
// Order is by sorted id, not array position, so the result does not depend on
// how the caller happened to order the list.
//
// The cost, stated plainly: absolute per-activity stability is gone. Adding a
// fifth activity can shift a later one's colour, where the pure hash never
// would. That trade was made deliberately — a stable colour identical to two
// other activities is not doing the job the colour exists for.
//
// Past six activities collisions are unavoidable by pigeonhole, and the
// assignment degrades to the old behaviour: everyone keeps their preferred
// entry. The activity NAME remains the identifying signal; colour is
// supplementary (DESIGN_STANDARD §3).
export function assignActivityColors(activities) {
  const ids = (activities || []).map((a) => a && a.id).filter(Boolean).sort()
  const out = new Map()
  const used = new Set()
  for (const id of ids) {
    const want = djb2(String(id)) % ACTIVITY_COLORS.length
    let i = want
    // Only resolve while a free entry exists; once the palette is exhausted
    // every activity simply keeps its preference.
    if (used.size < ACTIVITY_COLORS.length) {
      let steps = 0
      while (used.has(i) && steps < ACTIVITY_COLORS.length) {
        i = (i + 1) % ACTIVITY_COLORS.length
        steps += 1
      }
    }
    used.add(i)
    out.set(id, ACTIVITY_COLORS[i])
  }
  return out
}

// The resolved assignment for the camp currently on screen.
//
// Module-level state, deliberately, and the reason is worth recording: six
// separate components call activityColor(id) — the grid cell, both palettes,
// the edit modal, the activity view, the displaced chips — and most of them
// hold one activity, not the list. Threading a map through all of them would
// mean prop changes in every one, and any component that missed the prop would
// silently fall back to the raw hash and disagree with the grid. That
// divergence is precisely the defect T17 was filed about. One registry means
// every surface agrees by construction.
const assignedColors = new Map()

export function setActivityPalette(activities) {
  const next = assignActivityColors(activities)
  assignedColors.clear()
  for (const [id, colour] of next) assignedColors.set(id, colour)
}

// Falls back to the bare hash when no assignment has been registered, so any
// caller outside the schedule screen still gets a sensible, stable colour.
export function activityColor(activityId) {
  const assigned = assignedColors.get(activityId)
  if (assigned) return assigned
  return ACTIVITY_COLORS[djb2(String(activityId)) % ACTIVITY_COLORS.length]
}

// The two routes share a flag VOCABULARY, not an identical flag SET: a word
// used on both means the same thing on both, but 'Unfillable' does not exist
// on the manual route at all — an empty cell there is simply not filled yet —
// and 'Overlapping' does not exist on the generated route, where the engine
// refuses a clashing placement rather than making one.
export function legendEntriesFor(route) {
  // WEEK_CLOSED, like OVERLAP, is a manual-route-only marker; both are omitted
  // from the generated route's legend.
  const omit = route === 'manual' ? ['UNFILLABLE'] : ['OVERLAP', 'WEEK_CLOSED']
  return LEGEND_ENTRIES.filter(e => !omit.includes(e.flagKey))
}
