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

// Per-slot flags are UNFILLABLE (generated route only) and OVERLAP (both
// routes since T159).
// UNDERSERVED/DISTRIBUTION are aggregate findings, not slot states, and
// WEATHER_RISK was removed from the engine entirely
// (docs/adr/2026-07-28-schedule-flag-findings-reshape.md).
//
// The three caution flags share bronze, the one caution hue
// (DESIGN_STANDARD.md §4): a clash, a closed-week placement and a concurrent
// edit all mean "look at this cell". They stay apart by corner, and the cell's
// tooltip names the reason. Red stays reserved for UNFILLABLE so it stays loud.
export const FLAG_COLORS = {
  UNFILLABLE: 'var(--danger)',
  OVERLAP: 'var(--accent)',
  WEEK_CLOSED: 'var(--accent)',
  // T105 §5 — a concurrent-edit notice, derived/render-time/locally-
  // dismissible, never persisted.
  CONTENT_RACE: 'var(--accent)',
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
//    read SCREAMING_SNAKE (CONSTITUTION.md Art. V). `flagKeys` keeps the tie to
//    the engine's vocabulary for the entries that have one.
//
// UNDERSERVED and DISTRIBUTION are deliberately absent: they are aggregate
// findings, not per-slot states, and are surfaced in the stat tiles instead
// (ADR 2026-07-28-schedule-flag-findings-reshape).
const UNFILLABLE_ENTRY = {
  flagKeys: ['UNFILLABLE'],
  label: 'Unfillable',
  shape: 'dot',
  color: FLAG_COLORS.UNFILLABLE,
  description: 'Unfillable',
}

// One entry for the three caution dots (both routes): over capacity, off this
// week, changed on another device.
const CAUTION_ENTRY = {
  flagKeys: ['OVERLAP', 'WEEK_CLOSED', 'CONTENT_RACE'],
  label: 'Check this cell',
  shape: 'dot',
  color: 'var(--accent)',
  description: 'Over capacity, off this week, or changed on another device',
}

export const LEGEND_ENTRIES = [
  UNFILLABLE_ENTRY,
  CAUTION_ENTRY,
  // T108 Phase 2 (Designer spec §2.6) — a director-authored diff, not an
  // engine-emitted flag, so flagKeys is empty (like Locked/Recurring event below).
  // Never filtered out by legendEntriesFor: an override can appear on either
  // route (design §5.4).
  {
    flagKeys: [],
    label: 'Overridden today',
    shape: 'frame',
    color: 'var(--secondary)',
    description: 'This day only',
  },
  {
    flagKeys: [],
    label: 'Locked',
    shape: 'bar',
    color: 'var(--accent)',
    description: 'Locked',
  },
  {
    flagKeys: [],
    label: 'Recurring event',
    shape: 'bar',
    color: ANCHOR_COLOR,
    description: 'Every day',
  },
  {
    flagKeys: [],
    label: 'Unavailable',
    shape: 'block',
    color: 'color-mix(in srgb, var(--text) 5%, var(--bg))',
    description: 'Not scheduled',
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
// on the manual route at all — an empty cell there is simply not filled yet.
//
// 'Overlapping' USED to be the mirror of that, absent from the generated route
// because the engine refuses a clashing placement rather than making one. That
// is still true of generation and is no longer true of the route (T159): two
// directors editing offline can each move a group into the same place, and the
// merged result is a clash nobody generated. The marker follows the state.
export function legendEntriesFor(route) {
  // WEEK_CLOSED and, since T159, OVERLAP both derive on BOTH routes — a
  // closed-week placement and an over-capacity one are equally wrong on either,
  // and a merge can now produce the second without anyone having generated it.
  // UNFILLABLE is the only route-specific entry left: it cannot occur on the
  // manual route, where an empty cell is simply not filled yet.
  if (route !== 'manual') return LEGEND_ENTRIES
  return LEGEND_ENTRIES.filter(e => !e.flagKeys.includes('UNFILLABLE'))
}
