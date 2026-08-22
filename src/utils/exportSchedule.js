import * as XLSX from 'xlsx'
import { aoaToSanitizedSheet } from './exportSanitize.js'

// T105 §6 — an elective cell exports as its set (member list), not blank.
// Dangling-reference fallback label matches §4's render fallback exactly
// (Red Hat fold-in C: cosmetic consistency between render and export).
const ELECTIVE_REMOVED_LABEL = 'Elective (removed)'
// Events overlay placement Slice 1 (docs/adr/2026-08-22-events-overlay-
// placement.md §3) — dangling-reference fallback matches SlotCell's render
// fallback, mirroring ELECTIVE_REMOVED_LABEL above.
const EVENT_REMOVED_LABEL = 'Event (removed)'

function electiveCellLabel(slot, electiveSetLookup, electiveMembersBySet, actLookup) {
  const set = electiveSetLookup.get(slot.elective_set_id)
  if (!set) return ELECTIVE_REMOVED_LABEL
  const memberNames = (electiveMembersBySet.get(slot.elective_set_id) || [])
    .map(activityId => actLookup.get(activityId))
    .filter(Boolean)
  return memberNames.length ? `${set.name} (${memberNames.join(', ')})` : set.name
}

function eventCellLabel(slot, eventLookup) {
  const event = eventLookup.get(slot.event_id)
  return event ? event.name : EVENT_REMOVED_LABEL
}

export function exportToExcel({ slots, activities, anchors, groups, days, timeBlocks, electiveSets = [], electiveSetActivities = [], events = [] }) {
  const wb = XLSX.utils.book_new()
  const actLookup = new Map(activities.map(a => [a.id, a.name]))
  const anchorLookup = new Map(anchors.map(a => [a.id, a.name]))
  const electiveSetLookup = new Map(electiveSets.map(s => [s.id, s]))
  const eventLookup = new Map(events.map(e => [e.id, e]))
  const electiveMembersBySet = new Map()
  for (const m of electiveSetActivities) {
    if (!electiveMembersBySet.has(m.elective_set_id)) electiveMembersBySet.set(m.elective_set_id, [])
    electiveMembersBySet.get(m.elective_set_id).push(m.activity_id)
  }

  // One sheet per day
  for (const day of days) {
    const header = ['Time Block', ...groups.map(g => g.name)]
    const dataRows = timeBlocks.map(block => {
      const row = [`${block.name} (${block.start_time?.slice(0,5)}–${block.end_time?.slice(0,5)})`]
      for (const group of groups) {
        const slot = slots.find(s => s.group_id === group.id && s.day_id === day.id && s.time_block_id === block.id)
        if (!slot) { row.push(''); continue }
        if (slot.is_anchor) { row.push(anchorLookup.get(slot.anchor_id) || 'Anchor'); continue }
        if (slot.event_id) { row.push(eventCellLabel(slot, eventLookup)); continue }
        if (slot.elective_set_id) { row.push(electiveCellLabel(slot, electiveSetLookup, electiveMembersBySet, actLookup)); continue }
        if (slot.activity_id) { row.push(actLookup.get(slot.activity_id) || ''); continue }
        row.push('')
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
        const actName = slot.is_anchor
          ? `[Anchor] ${anchorLookup.get(slot.anchor_id) || ''}`
          : slot.event_id
            ? eventCellLabel(slot, eventLookup)
            : slot.elective_set_id
              ? electiveCellLabel(slot, electiveSetLookup, electiveMembersBySet, actLookup)
              : (actLookup.get(slot.activity_id) || '')
        masterRows.push([group.name, day.label, block.name, actName])
      }
    }
  }
  const masterWs = aoaToSanitizedSheet([masterHeader, ...masterRows])
  masterWs['!cols'] = [{ wch: 16 }, { wch: 12 }, { wch: 22 }, { wch: 20 }]
  XLSX.utils.book_append_sheet(wb, masterWs, 'All Groups')

  XLSX.writeFile(wb, 'camp_schedule.xlsx')
}
