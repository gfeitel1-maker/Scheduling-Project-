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

import { whitespaceInsensitiveName, normalizeName, activityNameKey } from './preview.js'
import { mapWithCollisions } from './mapWithCollisions.js'
import { isMealName } from './eventKeptWhenUnanswered.js'
import { dayNameFromTitle, titleNamesDay } from './extractEntities.js'

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
 * Which existing activity a name in a one-day file means: a live activity whose name is equivalent
 * (activityNameKey), else the activity the director confirmed it as an alias of. Two equivalent live
 * activities are ambiguous, never a guess. SHARED by the plan (here) and the commit (electron/ops/ingest.js).
 * @param {Array<{id: string, name: string}>} activities  the camp's live activities
 * @param {Map<string, string>} [aliases]  normalizeName(source label) -> activity id
 */
export function matchExistingActivity(name, activities, aliases) {
  const k = activityNameKey(name)
  const live = activities.filter((a) => activityNameKey(a.name) === k)
  if (live.length > 1) return { activityId: null, ambiguous: true }
  if (live.length === 1) return { activityId: live[0].id, ambiguous: false }
  return { activityId: aliases?.get(normalizeName(name)) ?? null, ambiguous: false }
}

/**
 * A name in a one-day file is EVENT-LIKE when it is a meal or names one of the camp's fixed events. Such a name
 * resolves to an existing activity (a live one, or the camp event's own), else is minted as a pinned_event
 * marker, never as a catalogue activity. SHARED by the plan and the commit.
 * @param {Array<{name: string, activity_id?: string|null}>} [fixedEvents]  the camp's live fixed events
 * @returns {{activityId: string|null, ambiguous: boolean, eventLike: boolean}}
 */
export function resolveSpecialDayName(name, activities, aliases, fixedEvents) {
  const m = matchExistingActivity(name, activities, aliases)
  const k = activityNameKey(name)
  const fe = (fixedEvents ?? []).find((e) => activityNameKey(e.name) === k)
  const eventLike = isMealName(name) || !!fe
  if (m.activityId || m.ambiguous) return { ...m, eventLike }
  const feActivityLive = fe?.activity_id && activities.some((a) => a.id === fe.activity_id)
  return { activityId: feActivityLive ? fe.activity_id : null, ambiguous: false, eventLike }
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
  const { map: groupByName, ambiguous: ambiguousColumnNames } = mapWithCollisions(groups, (g) => key(g.name), (g) => g.id)

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
  // Two columns that resolve to ONE group derive the same cell ids, so the second would silently overwrite
  // the first while the cell count included both.
  const columnsByGroup = new Map()
  for (const c of columns) if (c.groupId) columnsByGroup.set(c.groupId, [...(columnsByGroup.get(c.groupId) ?? []), c.columnName])
  const duplicateColumns = [...columnsByGroup.values()].filter((names) => names.length > 1).flat()

  const timeBlocks = proposal.timeBlocks.map((name, i) => ({
    name,
    sort_order: i,
    ...readPeriod(name),
  }))

  // The commit resolves each name through the same matchExistingActivity, so what this preview lists as new is
  // exactly what the commit will mint. An ambiguous name resolves to NOTHING rather than to a guess, same as
  // an ambiguous column above.
  const activityRows = proposal.activityNames.map((name) => {
    const m = resolveSpecialDayName(name, activities, live?.aliases, live?.fixedEvents)
    return { name, activityId: m.activityId, ambiguous: m.ambiguous, eventLike: m.eventLike }
  })
  const newActivityNames = activityRows.filter((a) => !a.activityId && !a.ambiguous && !a.eventLike).map((a) => a.name)
  // Meals and the camp's own events are never added to the catalogue. With no activity behind the name yet, the
  // commit mints a pinned_event marker (an event), and the name is listed here instead of in newActivityNames.
  const eventNames = activityRows.filter((a) => a.eventLike && !a.activityId && !a.ambiguous).map((a) => a.name)
  // Which of the camp's EXISTING activities this day will bind to. Matching is
  // whitespace/case-insensitive so a re-import does not double the catalog, but
  // that means a one-off "Ga Ga pit" can silently attach to the camp's real,
  // rule-governed "GaGa Pit" — so the director is shown the reuse, not just the
  // additions (Red Hat, T40 3b review).
  const reusedActivityNames = activityRows.filter((a) => a.activityId).map((a) => a.name)
  const ambiguousActivityNamesList = activityRows.filter((a) => a.ambiguous).map((a) => a.name)

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
  if (duplicateColumns.length > 0) blockedBy.push('duplicate_columns')
  if (ambiguousActivityNamesList.length > 0) blockedBy.push('ambiguous_activities')
  // Blocked because two special days sharing a name is a mess for the director,
  // NOT because the database would stop it. _Prior: this comment read
  // "special_days has UNIQUE(camp_id, name); the write would fail at the DB."
  // Schema v73 relaxed that index (T241), so the write now succeeds and this
  // pre-check is the only thing standing between the director and a second
  // same-named day. It has to keep standing on its own.
  if (nameTaken) blockedBy.push('name_taken')
  if (!String(proposal.name ?? '').trim()) blockedBy.push('no_name')

  return {
    name: proposal.name,
    nameTaken,
    columns,
    unmatchedColumns,
    ambiguousColumns,
    duplicateColumns,
    timeBlocks,
    activities: activityRows,
    newActivityNames,
    eventNames,
    reusedActivityNames,
    ambiguousActivityNames: ambiguousActivityNamesList,
    slots,
    notes,
    blockedBy,
    ready: blockedBy.length === 0,
  }
}

/**
 * F3/F4 slice 4 (ADR "One-day file"). Where a one-day file lands: the weekday printed in the file's name or
 * title (matched to the camp's days), on the week open in the app. Nothing guessed: no weekday -> unplaced
 * with a plain flag, never a forced picker.
 * @returns {{placement: {weekId, dayId}|null, flag: string|null}}
 */
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']

export function resolveSpecialDayPlacement({ texts, days, weeks, weekId }) {
  if (!weeks?.length) return { placement: null, flag: 'This camp has no weeks yet, so the day was not placed.', dayId: '' }
  const week = weeks.find((w) => w.id === weekId) ?? (weeks.length === 1 ? weeks[0] : null)
  const named = new Set()
  for (const t of texts ?? []) {
    for (const d of WEEKDAYS) if (titleNamesDay(t, d)) named.add(d)
  }
  if (named.size > 1) return { placement: null, flag: 'The file names more than one weekday, so the day was not placed.', dayId: '' }
  const printed = named.size ? dayNameFromTitle([...named][0]) : null
  const day = printed ? (days ?? []).find((d) => dayNameFromTitle(d.label) === printed) : null
  if (!day) return { placement: null, flag: 'The file does not say which weekday this is, so the day was not placed.', dayId: '' }
  if (!week) return { placement: null, flag: `Pick a week to place the day on ${day.label}.`, dayId: day.id }
  return { placement: { weekId: week.id, dayId: day.id }, flag: null, dayId: day.id }
}
