// Can this camp build a week yet, and if not, what is missing?
//
// docs/work/specs/2026-07-31-sidebar-and-setup-readiness-handoff.md §4.
//
// This exists because the app held four disagreeing answers to that question.
// CampSetup tracked five areas and told the director "the engine needs all
// five" — a sentence that was false twice over, counting Fixed Events (which is
// optional) and omitting Days and Programs (which are not). ScheduleScreen
// checked a different four inline. The sidebar listed nine. Two more surfaces
// implied two more sets.
//
// One function, one required set, every surface reading from it. Marks and
// progress copy are only worth showing if they are right.
//
// Membership below is derived from src/engine/buildSchedule.js, not from what
// any screen happened to display.

// The five that gate building a week.
//
// `screen` is the navigation key (App.jsx's SCREENS map), `label` is camp
// language, and `message` is what a director reads. Ordered as setup is
// approached, so a list of gaps reads as a sequence rather than a jumble.
//
// Programs are deliberately absent.
//
// Every camp gets one called "Main" automatically (src/utils/ensureCohort.js,
// run from App.jsx on first sight of a camp), and both real databases have
// exactly that one row. It is a structural necessity — tiers, time_blocks,
// anchor_activities and day_override_templates all carry a cohort_id — and not
// a decision a director has ever had to make.
//
// Product owner, 2026-08-01: "hide programs from the sidebar and auto-create
// main." So it is no longer a step, no longer a gap, and no longer a question
// a first-run director is asked. The screen and the schema are untouched; a
// camp that genuinely runs two sessions on different time grids is still
// possible, and reinstating the row is a one-line change.
export const REQUIRED_AREAS = [
  {
    key: 'tiers',
    label: 'Units',
    screen: 'tiers',
    // buildSchedule takes `tiers: _tiers` and never reads it, but eligibility
    // reads group.tier_id — so with no units, nothing is eligible anywhere.
    message: 'Add your age divisions, so groups can be told apart.',
  },
  {
    key: 'groups',
    label: 'Groups',
    screen: 'groups',
    message: 'Add the bunks that need a schedule.',
  },
  {
    key: 'days',
    label: 'Days',
    screen: 'days',
    message: 'Say which days of the week camp runs.',
  },
  {
    key: 'timeblocks',
    label: 'Time Blocks',
    screen: 'timeblocks',
    message: 'Add the periods that make up a camp day.',
  },
  {
    key: 'activities',
    label: 'Activities',
    screen: 'activities',
    // A week builds without activities, and every cell comes back unfillable.
    message: 'Add what groups can do, or every period comes back empty.',
  },
]

// Present in the sidebar and on the setup screen, but never a gap. A camp with
// no fixed events and no day overrides is finished, not unfinished — and
// flagging it otherwise teaches directors to ignore the flag that matters.
export const OPTIONAL_AREAS = [
  { key: 'anchors', label: 'Fixed Events', screen: 'anchors' },
  { key: 'dayoverrides', label: 'Day Overrides', screen: 'dayoverrides' },
]

// Maps each required area to the collection the caller supplies.
const COLLECTION_FOR = {
  cohorts: 'cohorts',
  tiers: 'tiers',
  groups: 'groups',
  days: 'days',
  timeblocks: 'timeBlocks',
  activities: 'activities',
}

/**
 * Which required areas have no data yet.
 *
 * Returns `[]` when the camp can build a week. Each gap is
 * `{ key, screen, label, message }` — `screen` so a caller can navigate
 * straight there, `message` so every surface says the same sentence.
 *
 * A missing collection counts as empty rather than as present. Callers load
 * these asynchronously, and treating `undefined` as satisfied would flash
 * "ready" mid-load, which is the more damaging way to be wrong.
 */
export function getSetupGaps(collections) {
  const source = collections ?? {}
  return REQUIRED_AREAS.filter((area) => {
    const rows = source[COLLECTION_FOR[area.key]]
    return !Array.isArray(rows) || rows.length === 0
  })
}

/**
 * One sentence describing where setup stands, for a director rather than a
 * progress bar. The bar it replaces reported a fraction of the wrong set.
 */
export function describeSetupGaps(gaps) {
  if (gaps.length === 0) return 'Ready to build a week.'
  const names = gaps.map((g) => g.label)
  const list = names.length === 1
    ? names[0]
    : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
  return gaps.length === 1
    ? `One thing still needed before you can build a week: ${list}.`
    : `${gaps.length} things still needed before you can build a week: ${list}.`
}

// ── The six-state readiness layer (ADR 2026-08-08-s5-readiness-six-state-model)
//
// A strictly additive layer over the untouched binary core above. It never
// re-derives what blocks a week: Missing is *defined as* membership in
// getSetupGaps, so red still means exactly "blocks building a week" and the two
// layers can never disagree. Everything above this line is byte-for-byte the
// blocking-truth core the generation gate and sidebar already trust.

// Forward-looking categories: real areas the app will grow into but that carry
// no collection binding today. They can NEVER reach Missing — the Missing arm
// of the state machine is gated on kind==='required', and neither is in
// REQUIRED_AREAS, which never grows. They rest at Optional ("not started").
export const FORWARD_AREAS = [
  { key: 'location', label: 'Locations', screen: 'camp' },
  { key: 'staffing', label: 'Staffing', screen: null },
]

// The single category spine the layer iterates: required (setup order), then
// optional, then forward. Each descriptor carries its kind so the state machine
// can gate Missing structurally.
export const ALL_CATEGORIES = [
  ...REQUIRED_AREAS.map((a) => ({ ...a, kind: 'required' })),
  ...OPTIONAL_AREAS.map((a) => ({ ...a, kind: 'optional' })),
  ...FORWARD_AREAS.map((a) => ({ ...a, kind: 'forward' })),
]

// Which supplied collection tells an optional area it has rows. Required areas
// go through getSetupGaps (COLLECTION_FOR) and are never re-inspected here.
const OPTIONAL_COLLECTION = {
  anchors: 'anchors',
  dayoverrides: 'dayOverrides',
}

/**
 * The six-state readiness of every category, layered over getSetupGaps.
 *
 * `signals` is an OPTIONAL in-memory argument the caller supplies from a live
 * reconciliation session (not read from persisted collections — that data does
 * not exist yet; see the ADR). Shape, all fields optional:
 *
 *   { attention: { [key]: number },   // review items the caller knows about
 *     inProgress: { [key]: true },    // a plan is staged, not yet committed
 *     notApplicable: { [key]: true } } // camp declares the category N/A
 *
 * With no signals it degrades to today's binary truth in the richer glyph
 * vocabulary: required areas are Ready or Missing, optional/forward are Ready or
 * Optional — it never invents a state it cannot substantiate.
 *
 * Returns an array of `{ key, label, screen, kind, state, message? }` in the
 * stable spine order. `state` is one of: 'ready' | 'needs-attention' |
 * 'missing' | 'optional' | 'not-applicable' | 'in-progress'.
 */
export function getReadiness(collections, signals) {
  const source = collections ?? {}
  const s = signals ?? {}
  const attention = s.attention ?? {}
  const inProgress = s.inProgress ?? {}
  const notApplicable = s.notApplicable ?? {}

  // Missing is computed once, from the blocking core, and treated as its sole
  // definition — the load-bearing identity that keeps red honest.
  const gapKeys = new Set(getSetupGaps(source).map((g) => g.key))

  return ALL_CATEGORIES.map((cat) => {
    const state = readinessState(cat, source, gapKeys, { attention, inProgress, notApplicable })
    return { key: cat.key, label: cat.label, screen: cat.screen, kind: cat.kind, state, message: cat.message }
  })
}

function readinessState(cat, source, gapKeys, { attention, inProgress, notApplicable }) {
  if (notApplicable[cat.key]) return 'not-applicable'
  if (inProgress[cat.key]) return 'in-progress'

  if (cat.kind === 'required') {
    if (gapKeys.has(cat.key)) return 'missing'
    return attention[cat.key] > 0 ? 'needs-attention' : 'ready'
  }

  if (cat.kind === 'optional') {
    const rows = source[OPTIONAL_COLLECTION[cat.key]]
    const hasRows = Array.isArray(rows) && rows.length > 0
    if (!hasRows) return 'optional'
    return attention[cat.key] > 0 ? 'needs-attention' : 'ready'
  }

  // forward — no collection binding; rests at Optional ("not started") unless a
  // session declared it Not-applicable (handled above). Structurally unable to
  // reach Missing.
  return 'optional'
}

/**
 * The honest two-line summary for the hub: blocking truth first, quiet
 * attention count second. No percentage, no progress bar.
 *
 * `blocking` is describeSetupGaps over the Missing categories — identical to
 * describeSetupGaps(getSetupGaps(...)) because Missing IS getSetupGaps
 * membership. `attention` is a quiet second line, or null when nothing needs a
 * look (a rendered "0 items" invites a director to inspect something that is
 * fine).
 */
export function describeReadiness(readiness) {
  const rows = readiness ?? []
  const missing = rows.filter((r) => r.state === 'missing')
  const attentionCount = rows.filter(
    (r) => r.state === 'needs-attention' || r.state === 'in-progress',
  ).length

  return {
    blocking: describeSetupGaps(missing),
    attention: attentionCount === 0
      ? null
      : attentionCount === 1
        ? '1 item could use your attention.'
        : `${attentionCount} items could use your attention.`,
  }
}
