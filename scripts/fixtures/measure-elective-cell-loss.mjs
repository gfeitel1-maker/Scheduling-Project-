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

// --- the generous lossy collapse: best rank per ACTIVITY across cells ------
// Tie-break is `rank` first, then `labelKey.localeCompare` — a MODELING
// CHOICE, not a neutral default: it privileges early-alphabet activities
// among equally-ranked ones, exactly as the superseded draft's collapse did.
// Kept because determinism requires SOME fixed order, and this is the
// simplest one; stated here so it is not mistaken for an objective answer.
const bestRankByCamperActivity = new Map() // "camper|activity" -> rank
for (const p of fixture.preferences) {
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
  list.sort((a, b) => a.rank - b.rank || labelByActivity.get(a.activityId).localeCompare(labelByActivity.get(b.activityId)))
  list.forEach(({ activityId }, i) => {
    collapsedPreferences.push({ camper_id: camperId, labelKey: labelByActivity.get(activityId), rank: i + 1 })
  })
}

// --- run the CURRENT (global-list) engine on the collapsed input -----------
const { assignments } = buildElectiveAssignments({
  campers: fixture.campers.map((c) => ({ id: c.id })),
  occurrences: fixture.occurrences.map((o) => ({ id: o.id })),
  offerings: fixture.offerings.map((o) => ({ occurrence_id: o.occurrence_id, labelKey: o.labelKey, activity_id: o.activity_id, capacity: o.capacity })),
  preferences: collapsedPreferences,
})

const assignedActivityByCell = new Map() // "camper|occurrence" -> activity_id
for (const a of assignments) assignedActivityByCell.set(`${a.camper_id}|${a.occurrence_id}`, a.activity_id)

// --- numerator: engine's placement matches the PER-CELL truth --------------
let numerator = 0
for (const key of universe) {
  const assigned = assignedActivityByCell.get(key)
  if (assigned && rankedActivitiesByCell.get(key).has(assigned)) numerator++
}

const denominator = universe.length
const ratio = denominator > 0 ? numerator / denominator : NaN

process.stdout.write(
  `T251/T265 per-cell elective loss measurement (FLOOR, not worst case — collapse is deliberately generous)\n` +
  `  numerator (engine placement matches per-cell truth): ${numerator}\n` +
  `  denominator (camper-cells with >=1 expressed preference): ${denominator}\n` +
  `  excluded (camper-cells with ZERO expressed preference, counted separately, in neither numerator nor denominator): ${excluded}\n` +
  `  ratio: ${(ratio * 100).toFixed(1)}%\n` +
  `  NOTE: this ratio answers "satisfaction among campers who ranked something in this cell", ` +
  `narrower than "camper satisfaction" in general — see file header (a).\n`
)
