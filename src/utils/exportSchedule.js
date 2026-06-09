import * as XLSX from 'xlsx'

export function exportToExcel({ slots, activities, anchors, groups, days, timeBlocks }) {
  const wb = XLSX.utils.book_new()
  const actLookup = new Map(activities.map(a => [a.id, a.name]))
  const anchorLookup = new Map(anchors.map(a => [a.id, a.name]))

  // One sheet per day
  for (const day of days) {
    const header = ['Time Block', ...groups.map(g => g.name)]
    const dataRows = timeBlocks.map(block => {
      const row = [`${block.name} (${block.start_time?.slice(0,5)}–${block.end_time?.slice(0,5)})`]
      for (const group of groups) {
        const slot = slots.find(s => s.group_id === group.id && s.day_id === day.id && s.time_block_id === block.id)
        if (!slot) { row.push(''); continue }
        if (slot.is_anchor) { row.push(anchorLookup.get(slot.anchor_id) || 'Anchor'); continue }
        if (slot.activity_id) { row.push(actLookup.get(slot.activity_id) || ''); continue }
        row.push('')
      }
      return row
    })
    const ws = XLSX.utils.aoa_to_sheet([header, ...dataRows])
    // Column widths
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
          : (actLookup.get(slot.activity_id) || '')
        masterRows.push([group.name, day.label, block.name, actName])
      }
    }
  }
  const masterWs = XLSX.utils.aoa_to_sheet([masterHeader, ...masterRows])
  masterWs['!cols'] = [{ wch: 16 }, { wch: 12 }, { wch: 22 }, { wch: 20 }]
  XLSX.utils.book_append_sheet(wb, masterWs, 'All Groups')

  XLSX.writeFile(wb, 'camp_schedule.xlsx')
}
