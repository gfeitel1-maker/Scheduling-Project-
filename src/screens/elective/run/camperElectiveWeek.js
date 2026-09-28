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
// ranked nothing for. What it does NOT carry is `rank_kind` — whether the
// camper's ranks were ordered at all — because v79 put that column on
// elective_preferences, not on the assignment row. So "Second choice" below
// means "the rank recorded was 2", which for a camper whose sheet was read as an
// unordered set is a position they never actually expressed. Closing that needs
// rank_kind carried onto the assignment row; it is named here rather than
// papered over.

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
export function rankLabel(preferenceRank) {
  if (preferenceRank == null) return 'Not requested'
  return RANK_LABEL[preferenceRank] ?? `Choice #${preferenceRank}`
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

export function buildCamperElectiveWeek({
  camperId,
  rows = NONE,
  occurrences = NONE,
  activities = NONE,
  days = NONE,
  timeBlocks = NONE,
} = {}) {
  const occurrenceById = new Map(occurrences.map((o) => [o.id, o]))
  const activityNameById = new Map(activities.map((a) => [a.id, a.name]))
  // days_of_operation carries its name in `label` (electron/db/localDb.js's DDL);
  // `name` is accepted too because some callers pass catalogs shaped that way,
  // which is the same both-ways read AssignmentPreview.jsx does. NOTE: the
  // sibling occurrenceLabel in runStateCopy.js reads `.name` ONLY and so prints
  // a day id where this prints "Monday" — a pre-existing bug reported rather
  // than fixed here, since it is T250's rendered surface and has its own tests.
  const dayNameById = new Map(days.map((d) => [d.id, d.label ?? d.name ?? null]))
  const blockNameById = new Map(timeBlocks.map((t) => [t.id, t.name ?? null]))
  const dayOrder = orderIndex(days)
  const blockOrder = orderIndex(timeBlocks)

  const mine = rows.filter((r) => r.camper_id === camperId)
  const occurrenceOf = (row) => occurrenceById.get(row.occurrence_id)

  const entries = mine
    .slice()
    .sort((a, b) => (
      dayOrder(occurrenceOf(a)?.day_id) - dayOrder(occurrenceOf(b)?.day_id)
      || blockOrder(occurrenceOf(a)?.time_block_id) - blockOrder(occurrenceOf(b)?.time_block_id)
    ))
    .map((row) => {
      const occurrence = occurrenceOf(row)
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
