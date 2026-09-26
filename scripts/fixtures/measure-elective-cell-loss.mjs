// Measures how much per-cell preference information today's engine
// (src/engine/buildElectiveAssignments.js) loses because it still takes one
// GLOBAL ranked list per camper, not a per-cell one
// (docs/adr/2026-09-26-per-cell-elective-preferences.md). A manually-run
// measurement for a human decision — NOT a committed vitest gate, because a
// number that informs a decision is not a regression threshold.
//
// Run from the repo root:  node scripts/fixtures/measure-elective-cell-loss.mjs
//
// THE MEASUREMENT, DEFINED EXACTLY (do not redefine it — see the governing ADR
// and the task brief this script was written against):
//   - Universe = every (camper_id, occurrence_id) pair where that camper has
//     >=1 preference expressed in that cell, per the per-cell fixture truth.
//   - Denominator = the size of that universe.
//   - Numerator = pairs in that universe where the engine's placement — run on
//     preferences passed through the GENEROUS lossy collapse below — assigns
//     an activity the camper actually ranked IN THAT SPECIFIC CELL, per the
//     un-collapsed per-cell truth.
//   - The check is against the PER-CELL TRUTH, never the collapsed list's own
//     ranking (checking the adapter against itself would be circular).
//   - Camper-cells with ZERO expressed preference contribute to NEITHER
//     numerator nor denominator, and are counted and printed separately.
//   - Because the collapse is the most generous available, any measured loss
//     is a FLOOR, not a worst case.
//
// STANDING REVIEW LENS — two known non-coincidences, written down rather than
// left for the reader to assume away:
//   (a) The ratio printed answers "satisfaction among campers who ranked
//       something in this cell" — narrower than "camper satisfaction" in
//       general, because zero-preference cells are excluded entirely rather
//       than counted as failures or successes.
//   (b) The seat-supply precondition below catches total-capacity shortfall
//       ONLY. It does NOT catch a bad distribution across offerings within a
//       cell — adequate total seats concentrated in one unpopular offering can
//       still starve a popular one and look like an engine defect while being
//       a fixture defect. Not checked here; stated so nobody mistakes a clean
//       precondition pass for "the fixture's capacity is well-shaped".
import { buildElectiveAssignments } from '../../src/engine/buildElectiveAssignments.js'
import { loadT251Fixture } from '../../test/fixtures/elective/loadT251Fixture.js'

const fixture = loadT251Fixture()

// --- seat-supply precondition, loud and un-skippable, before the engine runs
// SYSTEM predicate: every camper attending a cell can, in principle, get a
// seat somewhere in that cell — without this, any scarcity the measurement
// reports could be a generator defect (the 24%-empty-camper-periods incident)
// rather than a real engine finding. CHECK predicate, narrower: total capacity
// in the cell >= attendee count. It does NOT check the DISTRIBUTION of that
// capacity across offerings (see the file header, item (b)) — a check this
// script does not attempt.
function assertSeatSupply(occurrences, offerings, camperCount) {
  const byOccurrence = new Map()
  for (const o of offerings) {
    if (!byOccurrence.has(o.occurrence_id)) byOccurrence.set(o.occurrence_id, [])
    byOccurrence.get(o.occurrence_id).push(o)
  }
  for (const occ of occurrences) {
    const here = byOccurrence.get(occ.id) ?? []
    const total = here.reduce((sum, o) => sum + o.capacity, 0)
    if (total < camperCount) {
      throw new Error(
        `seat-supply precondition failed for occurrence ${occ.id}: ` +
        `${camperCount} campers attend, only ${total} seats offered (shortfall ${camperCount - total}). ` +
        `Offerings: ${here.map((o) => `${o.labelKey}(${o.capacity})`).join(', ') || '(none)'}`
      )
    }
  }
}

assertSeatSupply(fixture.occurrences, fixture.offerings, fixture.campers.length)

// --- per-cell truth: (camper, occurrence, activity) pairs actually ranked ---
const activityByChoiceOccurrence = new Map() // "choice_id|occurrence_id" -> activity_id
for (const co of fixture.choiceOfferings) {
  activityByChoiceOccurrence.set(`${co.choice_id}|${co.occurrence_id}`, co.activity_id)
}
const labelByActivity = new Map()
for (const o of fixture.offerings) labelByActivity.set(o.activity_id, o.labelKey)

// (camper_id, occurrence_id) -> Set(activity_id ranked in that specific cell)
const rankedActivitiesByCell = new Map()
for (const p of fixture.preferences) {
  const activityId = activityByChoiceOccurrence.get(`${p.choice_id}|${p.occurrence_id}`)
  if (!activityId) continue // preference names a choice not offered in this occurrence — cannot happen from this generator, skipped rather than asserted here
  const key = `${p.camper_id}|${p.occurrence_id}`
  if (!rankedActivitiesByCell.has(key)) rankedActivitiesByCell.set(key, new Set())
  rankedActivitiesByCell.get(key).add(activityId)
}

// --- universe and exclusion count -------------------------------------------
const universe = [...rankedActivitiesByCell.keys()] // already exactly "camper-cells with >=1 preference"
let excluded = 0
for (const c of fixture.campers) {
  for (const occ of fixture.occurrences) {
    if (!rankedActivitiesByCell.has(`${c.id}|${occ.id}`)) excluded++
  }
}

// Plain codepoint comparison, not `.localeCompare()` — default ICU collation
// can differ between macOS and Linux CI, and this measurement's whole value is
// reproducing the same number on any machine.
function cmp(a, b) { return a < b ? -1 : a > b ? 1 : 0 }

// --- the generous lossy collapse: best rank per ACTIVITY across cells ------
// Tie-break is `rank` first, then `labelKey` codepoint order — a MODELING
// CHOICE, not a neutral default: it privileges early-alphabet activities
// among equally-ranked ones, exactly as the superseded draft's collapse did.
// Kept because determinism requires SOME fixed order, and this is the
// simplest one; stated here so it is not mistaken for an objective answer.
function collapseToGlobalList(preferences) {
  const bestRankByCamperActivity = new Map() // "camper|activity" -> rank
  for (const p of preferences) {
    const activityId = activityByChoiceOccurrence.get(`${p.choice_id}|${p.occurrence_id}`)
    if (!activityId) continue
    const key = `${p.camper_id}|${activityId}`
    const existing = bestRankByCamperActivity.get(key)
    if (existing === undefined || p.rank < existing) bestRankByCamperActivity.set(key, p.rank)
  }
  const byCamper = new Map()
  for (const [key, rank] of bestRankByCamperActivity) {
    const [camperId, activityId] = key.split('|')
    if (!byCamper.has(camperId)) byCamper.set(camperId, [])
    byCamper.get(camperId).push({ activityId, rank })
  }
  const collapsedPreferences = []
  for (const [camperId, list] of byCamper) {
    list.sort((a, b) => a.rank - b.rank || cmp(labelByActivity.get(a.activityId), labelByActivity.get(b.activityId)))
    list.forEach(({ activityId }, i) => {
      collapsedPreferences.push({ camper_id: camperId, labelKey: labelByActivity.get(activityId), rank: i + 1 })
    })
  }
  return collapsedPreferences
}

// --- run the CURRENT (global-list) engine on the collapsed input, at a given
// offering-capacity scale, and report the ratio at that scale --------------
// `scale` multiplies every offering's capacity (rounded up so a scaled
// capacity never drops below 1 seat where the unscaled one was positive).
// Held constant across every scale in the sweep: preferences, the engine, and
// the collapse. The ONLY thing that varies is how many seats exist.
function measureAtScale(scale) {
  const scaledOfferings = fixture.offerings.map((o) => ({
    occurrence_id: o.occurrence_id,
    labelKey: o.labelKey,
    activity_id: o.activity_id,
    capacity: Math.max(1, Math.ceil(o.capacity * scale)),
  }))
  const { assignments } = buildElectiveAssignments({
    campers: fixture.campers.map((c) => ({ id: c.id })),
    occurrences: fixture.occurrences.map((o) => ({ id: o.id })),
    offerings: scaledOfferings,
    preferences: collapseToGlobalList(fixture.preferences),
  })
  const assignedActivityByCell = new Map() // "camper|occurrence" -> activity_id
  for (const a of assignments) assignedActivityByCell.set(`${a.camper_id}|${a.occurrence_id}`, a.activity_id)
  let numerator = 0
  for (const key of universe) {
    const assigned = assignedActivityByCell.get(key)
    if (assigned && rankedActivitiesByCell.get(key).has(assigned)) numerator++
  }
  const denominator = universe.length
  return { numerator, denominator, ratio: denominator > 0 ? numerator / denominator : NaN }
}

const headline = measureAtScale(1.0)

process.stdout.write(
  `T251/T265 per-cell elective loss measurement (FLOOR, not worst case — collapse is deliberately generous)\n` +
  `  numerator (engine placement matches per-cell truth): ${headline.numerator}\n` +
  `  denominator (camper-cells with >=1 expressed preference): ${headline.denominator}\n` +
  `  excluded (camper-cells with ZERO expressed preference, counted separately, in neither numerator nor denominator): ${excluded}\n` +
  `  ratio: ${(headline.ratio * 100).toFixed(1)}%\n` +
  `  NOTE: this ratio answers "satisfaction among campers who ranked something in this cell", ` +
  `narrower than "camper satisfaction" in general — see file header (a).\n\n` +
  `  *** CAPACITY WARNING — READ BEFORE QUOTING THE RATIO ABOVE ***\n` +
  `  Every offering capacity in this fixture (CATALOG in make-elective-cell-fixture.mjs) is a\n` +
  `  SYNTHETIC, UNSOURCED number this workstream invented to give the fixture *some* seat count.\n` +
  `  It is NOT drawn from the real 2024 camp artifact this fixture's grid shape was modeled on.\n` +
  `  The headline ratio is highly sensitive to that invented number, holding preferences, the\n` +
  `  engine and the collapse fixed and varying ONLY the capacity scale:\n\n` +
  `  scale  numerator  denominator  ratio\n` +
  [1.0, 0.6, 0.4, 0.3, 0.2].map((scale) => {
    const m = measureAtScale(scale)
    return `  ${scale.toFixed(1)}    ${String(m.numerator).padEnd(9)}  ${String(m.denominator).padEnd(11)}  ${(m.ratio * 100).toFixed(1)}%`
  }).join('\n') + '\n\n' +
  `  The real artifact's seat-to-camper ratio is an OPEN QUESTION with the product owner — this\n` +
  `  script does not answer it, and no scale above should be read as "the realistic one". Do not\n` +
  `  quote the headline ratio without this curve beside it.\n`
)
