// T296 (docs/work/tickets/T296-per-camper-elective-schedule-view.md) — one
// camper's elective week, projected from the run's own assignment rows. Pure:
// no IPC, no React. Both run screens already hold everything this needs
// (useRunState's `rows` and `occurrences` plus the catalogs AssignmentPanel
// threads down), so this adds no read.
//
// WHY THIS IS NOT buildChildScheduleExport. The export's per-camper sheet
// (src/screens/elective/export/exportChildSchedule.js) looks like the same
// projection and is not: it is built from the run's OUTER schedule rows — the
// camper's whole week on the grid, elective and inherited cells alike, span- and
// linked-choice-clustered — and it carries no rank at all. T296's predicate asks
// for the opposite slice: the ELECTIVE placements, each with the thing the
// export cannot say, namely whether the camper was given something they ranked
// or something the solver filled in. Two different sources, two different
// questions. Folding them together would mean bumping that export's
// format_version for a screen, which the ticket's "no new export" non-goal and
// the export's own public contract both forbid.
//
// WHAT `preference_rank` CAN AND CANNOT SAY. A NULL rank is the fallback signal,
// and it is the database's own (electron/ops/commitElectiveRun.js writes
// `a.preference_rank ?? null`): the solver placed this camper somewhere they
// ranked nothing for. A non-null rank alone does NOT say the camper's ranks
// were ordered — `rank_kind` lives on `elective_preferences`, not on the
// assignment row, so a camper whose sheet was read as an unordered set
// ('unordered-set', a tie among equals, never a ranking) still carries a real
// integer rank there. T318 closes this WITHOUT moving the column: `rankKind`
// below is derived at display time from the same assignment-to-preference join
// T297 already built (`buildPreferenceLookup`, exported below), so `rankLabel`
// can refuse to print an ordinal it has no positive evidence for.

// T297 — THE SOLVER'S OWN COORDINATE BINDING, not a second reading of it.
//
// A stored preference names a (day, period) coordinate and gets an occurrence_id
// only at solve time, in memory, per template (ADR 2026-09-27 §13.2 — the binding
// is never written back, because two candidate routes may bind one coordinate
// differently). This projection has to answer the same question the solver does
// ("which of this run's cells does this row apply to"), so it calls the same
// resolver rather than re-implementing the match. An independent copy here could
// fail to recognise a row the solver DOES bind to the cell, and the panel would
// then offer an ADD where the director meant a correction — writing a second row
// beside the one they were fixing.
import { resolvePreferenceCoordinates } from '../assignment/resolvePreferenceCoordinates.js'
// T318 round 2 — `hasOrderingEvidence` moved to src/engine/rankKind.js, a
// dependency-free module also imported by the engine
// (buildElectiveAssignments.js) and the ETL (preferenceSheet.js), so the
// 2-value allow-list is defined once. See rankKind.js's own header.
import { hasOrderingEvidence } from '../../../engine/rankKind.js'

// Module-level so the defaults are a stable reference across renders and a
// useMemo keyed on them can actually hit — the same reason useRunState.js keeps
// its own EMPTY at module level.
const NONE = []

const RANK_LABEL = { 1: 'First choice', 2: 'Second choice', 3: 'Third choice' }

// "Not requested" is also AssignmentPreview's wording for the same condition
// (its NOT_REQUESTED flag copy), matched deliberately so the pre-commit preview
// and the committed run read the same way. It is a MATCHING literal, not an
// enforced one: that map is keyed by flag name and this one by rank, so there is
// no single map both could share without inventing a third shape.
//
// Past third the exact number is stated rather than collapsed to "lower". The
// run-level summary collapses, correctly — a sentence about 200 placements has
// no room for nine rank words — but this is one child's one period, where "which
// one" is the whole question.
//
// T318 (c) — THE RULE THAT MAKES FABRICATION IMPOSSIBLE BY CONSTRUCTION: an
// ordinal is printed only on POSITIVE evidence of ordering, `rankKind` exactly
// 'cell-choice' or 'ordered-fallback'. Every other case — 'unordered-set', a
// null/undefined kind (no join could be made), or anything else — reads as the
// non-ordinal word. Owner-ruled 2026-09-29: absence of evidence that ordering
// happened is not evidence of order, and the costs are not symmetric — the safe
// default costs a blander label on legacy or edited data, the unsafe default is
// the fabrication the owner ruled must not exist.
export const UNORDERED_RANK_LABEL = 'One of their choices'
export function rankLabel(preferenceRank, rankKind) {
  if (preferenceRank == null) return 'Not requested'
  if (hasOrderingEvidence(rankKind)) {
    return RANK_LABEL[preferenceRank] ?? `Choice #${preferenceRank}`
  }
  return UNORDERED_RANK_LABEL
}

// sort_order is the camp's authored week order; the catalog's own position is the
// fallback for a row that has none. An occurrence pointing at a day or block the
// camp no longer has sorts last rather than silently first, so a dangling row
// never displaces a real one. A finite sentinel rather than Infinity, so that
// comparing two unknowns subtracts to 0 instead of NaN.
const LAST = Number.MAX_SAFE_INTEGER
function orderIndex(catalog) {
  const index = new Map()
  catalog.forEach((row, i) => {
    index.set(row.id, typeof row.sort_order === 'number' ? row.sort_order : i)
  })
  return (id) => index.get(id) ?? LAST
}

// board item 9b round 3 — one tier per camper, derived from their OWN
// assignment rows. FIRST ROW WINS when a camper's rows somehow span two
// DIFFERENT tiers' occurrences (should not occur — buildAttendance scopes a
// camper to one tier's occurrences — but array order is a deterministic,
// documented answer rather than leaving it to Map insertion order by
// accident). Returns null (not {}) when nothing could be derived, so an
// empty/absent `rows` reproduces the exact tier-blind resolver call every
// caller made before this parameter existed.
function deriveTierIdByCamperId(rows, occurrences) {
  if (!rows || rows.length === 0) return null
  const occurrenceById = new Map(occurrences.map((o) => [o.id, o]))
  const tierIdByCamperId = {}
  for (const row of rows) {
    if (row.camper_id == null || row.camper_id in tierIdByCamperId) continue
    const tierId = occurrenceById.get(row.occurrence_id)?.tier_id ?? null
    if (tierId != null) tierIdByCamperId[row.camper_id] = tierId
  }
  return Object.keys(tierIdByCamperId).length > 0 ? tierIdByCamperId : null
}

/**
 * A lookup from one placement (a row with camper_id/choice_id/occurrence_id) to
 * `{ id, rankKind }` for the preference row behind it, or null.
 *
 * T297 — an edit CORRECTS a statement the camper made, so the affordance has to
 * know which row that is. An assignment names an activity and a preference names
 * a choice, so `choice_id` is the only link between them.
 *
 * T318 — exported (was the private `preferenceIndex`) so runStateCopy.js's
 * satisfactionSummary and exportRunSummary.js's rank buckets can ask the same
 * question rankLabel asks: not just "which preference", but "did it carry
 * positive evidence of ordering". `rankKind` is `rank_kind` off that preference
 * row, verbatim — the caller decides what a kind other than
 * 'cell-choice'/'ordered-fallback' means.
 *
 * Null is a real answer: a placement the camper ranked nothing for (the bronze
 * "not requested" row) genuinely has no statement to correct, so the edit there
 * is an ADD.
 *
 * board item 9b round 3 — `rows` (optional) is the run's own assignment rows.
 * A coordinate-only preference at a cell more than one TIER shares resolves
 * to an occurrence only when the resolver knows which tier it is for
 * (resolvePreferenceCoordinates' `tierIdByCamperId`); without it the resolver
 * falls back to whichever occurrence is first at that cell, which is wrong for
 * every camper outside that one tier and makes this join miss. Every caller
 * already holds its run's assignment rows, and a camper is only ever placed in
 * an occurrence of their own tier (buildAttendance scopes them), so the tier
 * the solver actually used is recoverable from `row.occurrence_id ->
 * occurrence.tier_id` — no roster re-derivation, no new catalog read. Omitted,
 * this behaves exactly as before (tier-blind), so no existing caller changes.
 */
export function buildPreferenceLookup({ preferences, occurrences, days, timeBlocks, rows = NONE }) {
  const tierIdByCamperId = deriveTierIdByCamperId(rows, occurrences)
  // Bound ONCE for the whole week, against this run's occurrences. After that
  // there are two tiers, which is exactly what the engine's `rankAt` has: a row
  // scoped to the occurrence, else a whole-run fallback.
  const bound = resolvePreferenceCoordinates({ preferences, occurrences, days, timeBlocks, tierIdByCamperId }).preferences
  const keyOf = (camperId, choiceId, occurrenceId) => (
    `${camperId}\u0000${choiceId}\u0000${occurrenceId ?? ''}`
  )
  // A Map, not a filter per entry: the first version rescanned every preference
  // in the run for every placement in the week, re-paid on each lock and move
  // because applyRow rebuilds `rows` and invalidates the memo. A run holds a few
  // thousand preference rows.
  const byKey = new Map()
  for (const p of bound) {
    if (p.choice_id == null) continue
    const k = keyOf(p.camper_id, p.choice_id, p.occurrence_id)
    // FIRST wins, so a later duplicate cannot displace the row already found.
    if (!byKey.has(k)) byKey.set(k, { id: p.id, rankKind: p.rank_kind ?? null })
  }
  return (row) => {
    if (row.choice_id == null) return null
    return byKey.get(keyOf(row.camper_id, row.choice_id, row.occurrence_id))
      ?? byKey.get(keyOf(row.camper_id, row.choice_id, null))
      ?? null
  }
}

export function buildCamperElectiveWeek({
  camperId,
  rows = NONE,
  occurrences = NONE,
  activities = NONE,
  days = NONE,
  timeBlocks = NONE,
  // T297. Defaulted, so every T296 caller that passes no preferences keeps
  // producing exactly the week it produced before, with preferenceId null.
  preferences = NONE,
} = {}) {
  const occurrenceById = new Map(occurrences.map((o) => [o.id, o]))
  const activityNameById = new Map(activities.map((a) => [a.id, a.name]))
  // days_of_operation carries its name in `label` (electron/db/schema.sql);
  // `name` is accepted too because some callers pass catalogs shaped that way,
  // which is the same both-ways read AssignmentPreview.jsx does. T318 fixed the
  // sibling occurrenceLabel in runStateCopy.js to read the same way, so the two
  // no longer disagree on the same catalog.
  const dayNameById = new Map(days.map((d) => [d.id, d.label ?? d.name ?? null]))
  const blockNameById = new Map(timeBlocks.map((t) => [t.id, t.name ?? null]))
  const dayOrder = orderIndex(days)
  const blockOrder = orderIndex(timeBlocks)

  const mine = rows.filter((r) => r.camper_id === camperId)
  const occurrenceOf = (row) => occurrenceById.get(row.occurrence_id)
  const preferenceFor = buildPreferenceLookup({ preferences, occurrences, days, timeBlocks, rows })

  const entries = mine
    .slice()
    .sort((a, b) => (
      dayOrder(occurrenceOf(a)?.day_id) - dayOrder(occurrenceOf(b)?.day_id)
      || blockOrder(occurrenceOf(a)?.time_block_id) - blockOrder(occurrenceOf(b)?.time_block_id)
    ))
    .map((row) => {
      const occurrence = occurrenceOf(row)
      const bound = preferenceFor(row)
      return {
        assignmentId: row.id,
        occurrenceId: row.occurrence_id,
        dayName: dayNameById.get(occurrence?.day_id) ?? null,
        blockName: blockNameById.get(occurrence?.time_block_id) ?? null,
        // Degrade to the id rather than to blank: a director reading a week with
        // an empty cell in it cannot tell a deleted activity from a bug.
        activityName: activityNameById.get(row.activity_id) ?? row.activity_id,
        rank: row.preference_rank ?? null,
        isFallback: row.preference_rank == null,
        // T297 — the choice this placement came from, which is the CURRENT value
        // an edit control shows, and the statement an edit would correct. See
        // buildPreferenceLookup.
        choiceId: row.choice_id ?? null,
        preferenceId: bound?.id ?? null,
        // T318 (c) — the joined preference's rank_kind, or null when nothing
        // joined. rankLabel uses this to decide whether `rank` is an ordinal
        // worth printing.
        rankKind: bound?.rankKind ?? null,
      }
    })

  return {
    camperId,
    camperName: mine[0]?.camper_name ?? null,
    entries,
  }
}

// The pickable roster: every camper this run actually placed, which is not the
// camp's `campers` table — a camper with no placement in this run has no week to
// show, and offering their name would open an empty panel.
export function listRunCampers(rows = NONE) {
  const byCamper = new Map()
  for (const row of rows) {
    if (!byCamper.has(row.camper_id)) {
      byCamper.set(row.camper_id, {
        camperId: row.camper_id,
        camperName: row.camper_name ?? row.camper_id,
        placementCount: 0,
        fallbackCount: 0,
      })
    }
    const entry = byCamper.get(row.camper_id)
    entry.placementCount += 1
    if (row.preference_rank == null) entry.fallbackCount += 1
  }
  return [...byCamper.values()].sort((a, b) => String(a.camperName).localeCompare(String(b.camperName)))
}
