import * as XLSX from 'xlsx'
import { aoaToSanitizedSheet } from './exportSanitize.js'
import { buildScheduleLookups, resolveSlotCell, formatCellLabel } from './scheduleCells.js'

// Cell-content resolution (anchor / event / elective / activity, plus the
// "(removed)" fallbacks) lives in scheduleCells.js so this Excel export and the
// JSON export (buildScheduleExport below) share one source and cannot drift.

export function exportToExcel({ slots, activities, anchors, groups, days, timeBlocks, electiveSets = [], electiveSetActivities = [], events = [] }) {
  const wb = XLSX.utils.book_new()
  const lookups = buildScheduleLookups({ activities, anchors, electiveSets, electiveSetActivities, events })

  // One sheet per day
  for (const day of days) {
    const header = ['Time Block', ...groups.map(g => g.name)]
    const dataRows = timeBlocks.map(block => {
      const row = [`${block.name} (${block.start_time?.slice(0,5)}–${block.end_time?.slice(0,5)})`]
      for (const group of groups) {
        const slot = slots.find(s => s.group_id === group.id && s.day_id === day.id && s.time_block_id === block.id)
        row.push(formatCellLabel(resolveSlotCell(slot, lookups)))
      }
      return row
    })
    const ws = aoaToSanitizedSheet([header, ...dataRows])
    // Column widths — layered on top of the already-sanitized sheet (ADR §2a).
    ws['!cols'] = [{ wch: 22 }, ...groups.map(() => ({ wch: 16 }))]
    XLSX.utils.book_append_sheet(wb, ws, day.label)
  }

  // Master flat sheet
  const masterHeader = ['Group', 'Day', 'Time Block', 'Activity']
  const masterRows = []
  for (const group of groups) {
    for (const day of days) {
      for (const block of timeBlocks) {
        const slot = slots.find(s => s.group_id === group.id && s.day_id === day.id && s.time_block_id === block.id)
        if (!slot) continue
        const actName = formatCellLabel(resolveSlotCell(slot, lookups), { anchorBracket: true })
        masterRows.push([group.name, day.label, block.name, actName])
      }
    }
  }
  const masterWs = aoaToSanitizedSheet([masterHeader, ...masterRows])
  masterWs['!cols'] = [{ wch: 16 }, { wch: 12 }, { wch: 22 }, { wch: 20 }]
  XLSX.utils.book_append_sheet(wb, masterWs, 'All Groups')

  XLSX.writeFile(wb, 'camp_schedule.xlsx')
}

// The versioned JSON export (buildScheduleExport) lives in exportScheduleJson.js
// — xlsx-free so the MCP server can import it without loading this module.
