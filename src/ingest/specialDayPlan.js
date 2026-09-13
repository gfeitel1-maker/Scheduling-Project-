// T40 slice 3b — turn a recognised one-day file (src/ingest/specialDayFile.js)
// into a plan a director confirms before anything is written.
//
// PURE. No database, no I/O, no id generation — the caller supplies the camp's
// live groups/activities/special days and owns the writes.
//
// THE RULE SLICE 3a EXISTS FOR STAYS IN FORCE. A special day must not quietly
// enlarge the camp's PERMANENT setup. So nothing here is minted silently:
//
//   - a column that matches no group is REPORTED, never created. A Maccabiah
//     team is a throwaway; putting one in the camp's permanent roster is the
//     same pollution 3a refuses the whole file to avoid.
//   - an activity the camp does not have is listed SEPARATELY, so the director
//     sees exactly what this day would add to the catalog before agreeing.
//
// The plan is therefore not-ready by default and says what is blocking it.

import { whitespaceInsensitiveName } from './preview.js'

const key = (s) => whitespaceInsensitiveName(String(s ?? ''))

// "9:15-9:45" -> both ends. "10:15" -> a start and nothing else: inventing an
// end would fabricate a period length the file never stated.
const RANGE = /^(\d{1,2}\s*[:.]\s*\d{2})\s*[-–—]\s*(\d{1,2}\s*[:.]\s*\d{2})$/
function readPeriod(label) {
  const text = String(label ?? '').trim()
  const m = text.match(RANGE)
  if (m) return { start_time: m[1].trim(), end_time: m[2].trim() }
  return { start_time: text || null, end_time: null }
}

/**
 * @param {object|null} proposal  proposeSpecialDay(...) output
 * @param {{groups: Array, activities: Array, specialDays: Array}} live
 * @returns {object|null} the plan, or null when there is no proposal — a plan
 *          shaped like an empty day would invite a commit that builds nothing.
 */
export function buildSpecialDayPlan(proposal, live) {
  if (!proposal) return null
  const groups = live?.groups ?? []
  const activities = live?.activities ?? []
  const specialDays = live?.specialDays ?? []

  // Red Hat (T40 3b review): a plain Map here is last-write-wins, so two live
  // groups whose names normalize identically ("Bogrim" and "bogrim ") silently
  // bound the column to whichever came last — one group got the whole day and
  // the other silently got nothing, with no way for the director to tell. This
  // camp has hit duplicate-by-normalization names before; collisions are
  // collected and BLOCK the plan rather than being resolved by array order.
  const groupByName = new Map()
  const ambiguousColumnNames = new Set()
  for (const g of groups) {
    const k = key(g.name)
    if (groupByName.has(k)) ambiguousColumnNames.add(k)
    else groupByName.set(k, g.id)
  }
  const activityByName = new Map(activities.map((a) => [key(a.name), a.id]))

  const columns = proposal.columnNames.map((columnName) => ({
    columnName,
    // An ambiguous name resolves to NOTHING rather than to a guess.
    groupId: ambiguousColumnNames.has(key(columnName))
      ? null
      : (groupByName.get(key(columnName)) ?? null),
    ambiguous: ambiguousColumnNames.has(key(columnName)),
  }))
  const unmatchedColumns = columns.filter((c) => !c.groupId && !c.ambiguous).map((c) => c.columnName)
  const ambiguousColumns = columns.filter((c) => c.ambiguous).map((c) => c.columnName)

  const timeBlocks = proposal.timeBlocks.map((name, i) => ({
    name,
    sort_order: i,
    ...readPeriod(name),
  }))

  const activityRows = proposal.activityNames.map((name) => ({
    name,
    activityId: activityByName.get(key(name)) ?? null,
  }))
  const newActivityNames = activityRows.filter((a) => !a.activityId).map((a) => a.name)
  // Which of the camp's EXISTING activities this day will bind to. Matching is
  // whitespace/case-insensitive so a re-import does not double the catalog, but
  // that means a one-off "Ga Ga pit" can silently attach to the camp's real,
  // rule-governed "GaGa Pit" — so the director is shown the reuse, not just the
  // additions (Red Hat, T40 3b review).
  const reusedActivityNames = activityRows.filter((a) => a.activityId).map((a) => a.name)

  const slots = proposal.slots.map((s) => ({
    columnName: s.groupName,
    blockName: s.blockLabel,
    activityName: s.activityName,
  }))

  // special_day_slots has no notes column (electron/db/schema.sql), so a cell
  // reading "Pool - Unit Heads" has nowhere to put "Unit Heads". Losing it
  // would be a silent drop of something the file plainly said, so the DAY
  // records it instead — special_days.notes exists and is the right grain for
  // "here is what the source told us that the grid cannot hold".
  const named = proposal.slots
    .filter((s) => s.note)
    .map((s) => `${s.groupName} ${s.blockLabel}: ${s.activityName} - ${s.note}`)
  const notes = named.length
    ? `From the imported file — cells that named a person:\n${named.join('\n')}`
    : null

  const nameTaken = specialDays.some((d) => key(d.name) === key(proposal.name))

  const blockedBy = []
  // Committing with a column unresolved would silently leave that share of the
  // day unbuilt — the director would see a grid with a missing stripe and no
  // explanation.
  if (unmatchedColumns.length > 0) blockedBy.push('unmatched_columns')
  if (ambiguousColumns.length > 0) blockedBy.push('ambiguous_columns')
  // special_days has UNIQUE(camp_id, name); the write would fail at the DB.
  if (nameTaken) blockedBy.push('name_taken')
  if (!String(proposal.name ?? '').trim()) blockedBy.push('no_name')

  return {
    name: proposal.name,
    nameTaken,
    columns,
    unmatchedColumns,
    ambiguousColumns,
    timeBlocks,
    activities: activityRows,
    newActivityNames,
    reusedActivityNames,
    slots,
    notes,
    blockedBy,
    ready: blockedBy.length === 0,
  }
}
