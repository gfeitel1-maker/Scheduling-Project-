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
// T52 — six rungs of ONE navy hue, dark to light, spanning the brand's own two
// ends: --primary-dark (#0F2A47) down toward --bg (#F4F3EF). Owner decision,
// 2026-09-12.
//
// Colour here means HOW OFTEN AN ACTIVITY RUNS (see assignActivityColors).
// That pairing is the whole reason a ramp is allowed: dark-to-light is an
// ORDER, and readers infer order whether or not one is intended. Assigned
// arbitrarily a ramp would be WORSE than six distinct hues, because it implies
// a relationship that isn't there. If frequency ever stops driving the
// assignment, this palette must go back to distinct hues or go away entirely.
//
// The rungs are spread as widely as the page tolerates (lightness 16..86) and
// that width is load-bearing, not aesthetic. Measured against the four checks
// in slotCellConstants.test.js:
//
// TWO constraints had to hold at once, and the second is easy to miss:
//
//   (A) the four separation checks below, floor 15
//   (B) every rung must still READ as a 6px dot on the cream page — colour
//       here renders as `.identity-dot` (scheduleGrid.css:217), never as a
//       cell fill. A pale rung that looks fine as a swatch DISAPPEARS at 6px.
//
// Those pull in opposite directions: (A) wants the widest possible lightness
// spread, (B) forbids the light end of it. The first ramp tried here ran
// #102842..#D2DBE5 and satisfied (A) at 16 — but its palest rung sat at
// 1.35:1 against the surface, i.e. invisible, and the next at 2:1.
//
// Compressing the range and letting saturation carry some of the work
// satisfies both, and is better on (A) too:
//
//                      normal  deuteranopia  protanopia  greyscale   min dot
//   six distinct hues      34            20          18        17      2.5:1
//   wide pale ramp         63            16          16        59      1.35:1  <- (B) fails
//   THIS ramp             ~33           ~33         ~33       ~33      4.01:1
//
// Margin note for whoever edits these: the binding constraint is (B). Lighten
// the top rungs to make the grid prettier and the dots stop being visible
// before any test here complains — slotCellConstants.test.js checks (A) only.
export const ACTIVITY_COLORS = ['#121E2B','#203144','#2F455C','#405872','#526B86','#667F99']

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
  // T105 §5 — a concurrent-edit notice (this device's own recent write to
  // this cell no longer matches what it now holds), derived/render-time/
  // locally-dismissible, never persisted. Reuses WEEK_CLOSED's slate rather
  // than adding a new token.
  CONTENT_RACE: 'var(--secondary)',
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
  CONTENT_RACE: 'caution',
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

// T105 §5, route-agnostic like WEEK_CLOSED (a concurrent edit is equally
// possible on either route) — legend.test.js's "documents every per-slot flag
// the engine can emit" holds CONTENT_RACE to the same bar as OVERLAP: it is
// derived (never persisted), but it IS a real per-slot treatment a director
// can see, so it belongs in the legend exactly like OVERLAP does.
const CONTENT_RACE_ENTRY = {
  flagKey: 'CONTENT_RACE',
  label: 'Changed elsewhere',
  shape: 'dot',
  color: FLAG_COLORS.CONTENT_RACE,
  description: 'Replaced by a concurrent edit on another device',
}

export const LEGEND_ENTRIES = [
  UNFILLABLE_ENTRY,
  OVERLAP_ENTRY,
  WEEK_CLOSED_ENTRY,
  CONTENT_RACE_ENTRY,
  // T108 Phase 2 (Designer spec §2.6) — a director-authored diff, not an
  // engine-emitted flag, so flagKey is null (like Locked/Recurring event below).
  // Never filtered out by legendEntriesFor: an override can appear on either
  // route (design §5.4).
  {
    flagKey: null,
    label: 'Overridden today',
    shape: 'frame',
    color: 'var(--secondary)',
    description: 'Changed for this day only — the rest of the week is unaffected',
  },
  {
    flagKey: null,
    label: 'Locked',
    shape: 'bar',
    color: 'var(--accent)',
    description: 'Held in place — regenerating will not move it',
  },
  {
    flagKey: null,
    label: 'Recurring event',
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

// Colour by frequency: how many times a week the activity runs.
//
// A FIXED scale, not a ranking over the camp's current activities. That
// distinction matters operationally — under a ranking, adding one new activity
// could recolour everything already on the grid, and a director would watch
// their schedule change colour for no reason they caused. Here, 3-per-week is
// the same blue in every camp, forever.
//
// min_per_week is the goal the engine schedules against (schema.sql:405).
// Unset means nobody has said, which reads as the palest rung alongside
// "runs least often" — the honest reading of an absent value here, since the
// grid cannot show a frequency the camp has never recorded.
const FREQUENCY_RUNGS = 6

export function frequencyRung(minPerWeek) {
  const n = Number(minPerWeek)
  if (!Number.isFinite(n) || n <= 0) return FREQUENCY_RUNGS - 1
  // 5+ -> 0 (darkest), 4 -> 1, 3 -> 2, 2 -> 3, 1 -> 4
  return Math.max(0, FREQUENCY_RUNGS - 1 - Math.min(Math.round(n), FREQUENCY_RUNGS - 1))
}

export function assignActivityColors(activities) {
  const out = new Map()
  // Sorted by id so the returned Map is canonical: the same activities produce
  // an identical map whatever order the caller happened to hold them in.
  // Colour never depended on position, but a caller that diffs or serialises
  // this map would otherwise see spurious changes from list order alone.
  const rows = (activities || [])
    .filter((a) => a && a.id)
    .sort((x, y) => String(x.id).localeCompare(String(y.id)))
  for (const a of rows) {
    out.set(a.id, ACTIVITY_COLORS[frequencyRung(a.min_per_week)])
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

// Falls back to the palest rung when no assignment has been registered.
//
// Deliberately NOT the old hash fallback: under a frequency ramp a hashed
// colour would assert a frequency the caller never supplied, and asserting a
// wrong fact is worse than asserting the weakest one. The palest rung is the
// same thing an unset min_per_week renders as — "least often, or nobody has
// said" — so an unregistered caller degrades to the honest value.
export function activityColor(activityId) {
  const assigned = assignedColors.get(activityId)
  if (assigned) return assigned
  return ACTIVITY_COLORS[FREQUENCY_RUNGS - 1]
}

// The two routes share a flag VOCABULARY, not an identical flag SET: a word
// used on both means the same thing on both, but 'Unfillable' does not exist
// on the manual route at all — an empty cell there is simply not filled yet —
// and 'Overlapping' does not exist on the generated route, where the engine
// refuses a clashing placement rather than making one.
export function legendEntriesFor(route) {
  // WEEK_CLOSED derives on BOTH routes (a closed-week placement is equally wrong
  // on either), so it stays in both legends. Only UNFILLABLE (generated) and
  // OVERLAP (manual) are route-specific.
  const omit = route === 'manual' ? ['UNFILLABLE'] : ['OVERLAP']
  return LEGEND_ENTRIES.filter(e => !omit.includes(e.flagKey))
}
