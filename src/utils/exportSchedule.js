import * as XLSX from 'xlsx'
import { aoaToSanitizedSheet } from './exportSanitize.js'
import { timeBlockLabel } from './timeBlockLabel.js'
import { buildScheduleLookups, resolveSlotCell, formatCellLabel } from './scheduleCells.js'
import { replacedCellLabel, replacedDayLabel, replacedLaneNotes } from '../screens/schedule/replacedLane.js'

// Cell-content resolution (fixed event / event / elective / activity, plus the
// "(removed)" fallbacks) lives in scheduleCells.js so this Excel export and the
// JSON export (buildScheduleExport below) share one source and cannot drift.
// A replaced day (T350) prints through replacedLane.js, the presenter the
// schedule screen's lane uses.


export function exportToExcel({ slots, activities, fixedEvents, groups, days, timeBlocks, electiveSets = [], electiveSetActivities = [], events = [], week = null, replacements = new Map() }) {
  const wb = XLSX.utils.book_new()
  const lookups = buildScheduleLookups({ activities, fixedEvents, electiveSets, electiveSetActivities, events })
  const actMap = new Map(activities.map(a => [a.id, a]))

  // One sheet per day
  for (const day of days) {
    const header = ['Time Block', ...groups.map(g => g.name)]
    const replacement = replacements.get(day.id)
    let aoa
    if (replacement) {
      const blockRows = replacement.blocks.map(block => [
        timeBlockLabel(block),
        ...groups.map(g => replacedCellLabel({ replacement, groupId: g.id, blockId: block.id, actMap }).label),
      ])
      const notes = replacedLaneNotes(replacement)
      aoa = [
        [`${replacedDayLabel(week, day)} – ${replacement.name}`],
        header,
        ...(blockRows.length ? blockRows : [['—']]),
        ...(notes ? [['Notes', notes]] : []),
      ]
    } else {
      const dataRows = timeBlocks.map(block => {
        const row = [timeBlockLabel(block)]
        for (const group of groups) {
          const slot = slots.find(s => s.group_id === group.id && s.day_id === day.id && s.time_block_id === block.id)
          row.push(formatCellLabel(resolveSlotCell(slot, lookups)))
        }
        return row
      })
      aoa = [header, ...dataRows]
    }
    const ws = aoaToSanitizedSheet(aoa)
    // Column widths — layered on top of the already-sanitized sheet (ADR §2a).
    ws['!cols'] = [{ wch: 22 }, ...groups.map(() => ({ wch: 16 }))]
    XLSX.utils.book_append_sheet(wb, ws, day.label)
  }

  // Master flat sheet
  const masterHeader = ['Group', 'Day', 'Time Block', 'Activity']
  const masterRows = []
  for (const group of groups) {
    for (const day of days) {
      const replacement = replacements.get(day.id)
      if (replacement) {
        for (const block of replacement.blocks) {
          const { label } = replacedCellLabel({ replacement, groupId: group.id, blockId: block.id, actMap })
          if (label) masterRows.push([group.name, day.label, timeBlockLabel(block), label])
        }
        continue
      }
      for (const block of timeBlocks) {
        const slot = slots.find(s => s.group_id === group.id && s.day_id === day.id && s.time_block_id === block.id)
        if (!slot) continue
        const actName = formatCellLabel(resolveSlotCell(slot, lookups), { fixedEventBracket: true })
        masterRows.push([group.name, day.label, timeBlockLabel(block), actName])
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
