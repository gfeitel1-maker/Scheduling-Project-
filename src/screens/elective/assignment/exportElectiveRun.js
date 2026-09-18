// T229 CORRECTION 3 -- neither exportWorkbook.js (the S4a enrichment
// round-trip, fixed SHEET_LAYOUT/shoresh_id/META_SHEET) nor
// exportScheduleJson.js's buildScheduleExport (keyed group x day x
// time_block, one activity per cell) can express a (camper, occurrence)
// roster. This is the smallest honest reading of "reuse those two utilities":
// Excel goes through the SAME sanitizer every export in this repo uses
// (aoaToSanitizedSheet), and JSON follows exportScheduleJson's own
// format_version convention -- not a third general export path, just the one
// path an elective run needs.
import * as XLSX from 'xlsx'
import { aoaToSanitizedSheet } from '../../../utils/exportSanitize.js'

const FLAG_LABELS = {
  NOT_TOP_CHOICE: (rank) => `Not top choice (got #${rank})`,
  NOT_REQUESTED: () => 'Not requested',
}

function flagText(flags = [], rank) {
  return flags.map((f) => (FLAG_LABELS[f] ? FLAG_LABELS[f](rank) : f)).join('; ')
}

function lookups({ campers = [], activities = [], occurrences = [], days = [], timeBlocks = [] } = {}) {
  const camperById = new Map(campers.map((c) => [c.id, c]))
  const activityById = new Map(activities.map((a) => [a.id, a]))
  const occurrenceById = new Map(occurrences.map((o) => [o.id, o]))
  const dayById = new Map(days.map((d) => [d.id, d]))
  const timeBlockById = new Map(timeBlocks.map((t) => [t.id, t]))
  return { camperById, activityById, occurrenceById, dayById, timeBlockById }
}

function rowsFor(assignments, tables) {
  const { camperById, activityById, occurrenceById, dayById, timeBlockById } = tables
  return assignments.map((a) => {
    const occurrence = occurrenceById.get(a.occurrence_id)
    return {
      camper_id: a.camper_id,
      camper_name: camperById.get(a.camper_id)?.display_name ?? a.camper_id,
      activity_id: a.activity_id,
      activity_name: activityById.get(a.activity_id)?.name ?? a.activity_id,
      day: occurrence ? ((dayById.get(occurrence.day_id)?.label ?? dayById.get(occurrence.day_id)?.name) ?? occurrence.day_id) : null,
      time_block: occurrence ? (timeBlockById.get(occurrence.time_block_id)?.name ?? occurrence.time_block_id) : null,
      preference_rank: a.preference_rank ?? null,
      flags: a.flags ?? [],
    }
  })
}

// A public contract -- bump format_version on any shape change, mirroring
// exportScheduleJson.js's own rule.
export function buildElectiveRunExport({
  assignments = [], campers = [], activities = [], occurrences = [], days = [], timeBlocks = [], runName = null,
} = {}) {
  const tables = lookups({ campers, activities, occurrences, days, timeBlocks })
  return {
    format_version: 1,
    run_name: runName,
    assignments: rowsFor(assignments, tables),
  }
}

export function buildElectiveRunRoster({
  assignments = [], campers = [], activities = [], occurrences = [], days = [], timeBlocks = [],
} = {}) {
  const tables = lookups({ campers, activities, occurrences, days, timeBlocks })
  const rows = rowsFor(assignments, tables)
  const header = ['Camper', 'Day', 'Time Block', 'Activity', 'Preference Rank', 'Flags']
  const body = rows.map((r) => [
    r.camper_name, r.day, r.time_block, r.activity_name, r.preference_rank, flagText(r.flags, r.preference_rank),
  ])
  return [header, ...body]
}

export function exportElectiveRunExcel(input, filename = 'elective-assignments.xlsx') {
  const rows = buildElectiveRunRoster(input)
  const sheet = aoaToSanitizedSheet(rows)
  const workbook = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(workbook, sheet, 'Assignments')
  XLSX.writeFile(workbook, filename)
}
