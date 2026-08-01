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

// The six that gate building a week.
//
// `screen` is the navigation key (App.jsx's SCREENS map), `label` is camp
// language, and `message` is what a director reads. Ordered as setup is
// approached, so a list of gaps reads as a sequence rather than a jumble.
export const REQUIRED_AREAS = [
  {
    key: 'cohorts',
    label: 'Programs',
    screen: 'cohorts',
    // Not read by buildSchedule at all. Required anyway: three setup screens
    // gate data entry on an active program, so without one the director cannot
    // enter the rest.
    message: 'Add at least one program before setting up the rest of the camp.',
  },
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
