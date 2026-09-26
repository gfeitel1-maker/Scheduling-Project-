// T197 §5 (docs/adr/2026-09-26-elective-run-outer-inheritance-and-linked-choice-export.md) — XLSX
// workbook, following exportElectiveRun.js's precedent exactly: every sheet is built as an
// array-of-arrays and written through aoaToSanitizedSheet (src/utils/exportSanitize.js). Camper
// names, activity names, and choice labels are all user-controlled strings and must not bypass the
// formula-injection sanitizer. No XLSX.utils.aoa_to_sheet call anywhere in this file outside
// aoaToSanitizedSheet.
//
// Sheets: Child Schedules (one row per camper x span/linked-unit, using the SAME clustering as the
// JSON child-schedule export so the two artifacts cannot disagree), Activity Roster, Exceptions,
// Summary.
import * as XLSX from 'xlsx'
import { aoaToSanitizedSheet } from '../../../utils/exportSanitize.js'
import { buildElectiveRunProjectionExport } from './exportElectiveRunProjection.js'

function childSchedulesRows(childSchedules) {
  const header = ['Camper', 'Group', 'Day', 'Time Block', 'Activity', 'Cell Kind', 'Span Blocks']
  const body = []
  for (const camper of childSchedules.campers) {
    for (const entry of camper.schedule) {
      if (entry.kind === 'linked_choice') {
        for (const member of entry.memberRows) {
          body.push([camper.display_name, camper.group_name, member.dayId, member.timeBlockId, entry.label, 'elective', ''])
        }
      } else {
        body.push([camper.display_name, camper.group_name, entry.day, entry.time_block, entry.activity_name, entry.cell_kind, entry.span_blocks])
      }
    }
  }
  return [header, ...body]
}

function activityRosterRows(activityRosters) {
  const header = ['Day', 'Time Block', 'Activity', 'Camper', 'Group', 'Count', 'Capacity']
  const body = []
  for (const row of activityRosters) {
    for (const member of row.members) {
      body.push([row.day, row.time_block, row.activity_name, member.camper_name, member.group_name, row.count, row.capacity])
    }
  }
  return [header, ...body]
}

function exceptionsRows(exceptions) {
  const header = ['Category', 'Camper', 'Occurrence', 'Detail']
  const body = []
  for (const e of exceptions.unassigned) body.push(['Unassigned', e.camper_name, '', ''])
  for (const e of exceptions.unranked) body.push(['Unranked', e.camper_name, '', ''])
  for (const e of exceptions.unresolved) body.push(['Unresolved', '', e.occurrence_id, ''])
  for (const e of exceptions.capacity) body.push(['Over capacity', '', e.occurrence_id, `${e.filled}/${e.capacity}`])
  body.push(['Stale', '', '', String(exceptions.stale)])
  return [header, ...body]
}

function summaryRows(summary) {
  const header = ['Field', 'Value']
  const body = [
    ['Run', summary.run_name],
    ['Status', summary.run_status],
    ['Generation', summary.solver_generation],
    ['Source hash', summary.source_hash],
    ['Unassigned count', summary.unassigned_count],
    ...Object.entries(summary.counts_by_rank).map(([rank, count]) => [`Rank ${rank}`, count]),
  ]
  return [header, ...body]
}

export function buildElectiveRunWorkbook(input) {
  const projection = buildElectiveRunProjectionExport(input)
  const workbook = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(workbook, aoaToSanitizedSheet(childSchedulesRows(projection.child_schedules)), 'Child Schedules')
  XLSX.utils.book_append_sheet(workbook, aoaToSanitizedSheet(activityRosterRows(projection.activity_rosters)), 'Activity Roster')
  XLSX.utils.book_append_sheet(workbook, aoaToSanitizedSheet(exceptionsRows(projection.exceptions)), 'Exceptions')
  XLSX.utils.book_append_sheet(workbook, aoaToSanitizedSheet(summaryRows(projection.summary)), 'Summary')
  return workbook
}

export function exportElectiveRunWorkbookFile(input, filename = 'elective-run.xlsx') {
  const workbook = buildElectiveRunWorkbook(input)
  XLSX.writeFile(workbook, filename)
}
