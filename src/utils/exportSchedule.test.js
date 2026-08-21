import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as XLSX from 'xlsx'
import { exportToExcel } from './exportSchedule.js'

// exportToExcel's only side effect is XLSX.writeFile — mocked (ESM named
// exports can't be vi.spyOn'd in place) to capture the workbook it built, the
// same way the app's own export button would trigger a download.
vi.mock('xlsx', async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, writeFile: vi.fn() }
})

beforeEach(() => { XLSX.writeFile.mockClear() })

function capturedWorkbook(args) {
  exportToExcel(args)
  return XLSX.writeFile.mock.calls[0][0]
}

function sheetRows(wb, sheetName) {
  return XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, defval: '' })
}

const groups = [{ id: 'g1', name: 'Bunk 1' }]
const days = [{ id: 'd1', label: 'Monday' }]
const timeBlocks = [{ id: 'b1', name: 'Period 1', start_time: '09:00:00', end_time: '10:00:00' }]
const activities = [{ id: 'act-1', name: 'Swimming' }, { id: 'act-2', name: 'Kayaking' }]
const anchors = []

describe('exportToExcel — T105 §6 elective branch', () => {
  it('renders an elective cell as its set name + member list, not blank', () => {
    const slots = [{ group_id: 'g1', day_id: 'd1', time_block_id: 'b1', elective_set_id: 'set-1', activity_id: null }]
    const electiveSets = [{ id: 'set-1', name: 'Afternoon Chugim' }]
    const electiveSetActivities = [
      { elective_set_id: 'set-1', activity_id: 'act-1' },
      { elective_set_id: 'set-1', activity_id: 'act-2' },
    ]
    const wb = capturedWorkbook({ slots, activities, anchors, groups, days, timeBlocks, electiveSets, electiveSetActivities })

    const dayRows = sheetRows(wb, 'Monday')
    // header row, then the one data row: [timeBlockLabel, groupCellValue]
    expect(dayRows[1][1]).toBe('Afternoon Chugim (Swimming, Kayaking)')

    const masterRows = sheetRows(wb, 'All Groups')
    expect(masterRows[1][3]).toBe('Afternoon Chugim (Swimming, Kayaking)')
  })

  it('a dangling elective_set_id (set deleted) renders "Elective (removed)" — aligned with SlotCell\'s render fallback (Red Hat fold-in C)', () => {
    const slots = [{ group_id: 'g1', day_id: 'd1', time_block_id: 'b1', elective_set_id: 'set-gone', activity_id: null }]
    const wb = capturedWorkbook({ slots, activities, anchors, groups, days, timeBlocks, electiveSets: [], electiveSetActivities: [] })

    const dayRows = sheetRows(wb, 'Monday')
    expect(dayRows[1][1]).toBe('Elective (removed)')
    const masterRows = sheetRows(wb, 'All Groups')
    expect(masterRows[1][3]).toBe('Elective (removed)')
  })

  it('an ordinary activity cell is unaffected by the elective branch', () => {
    const slots = [{ group_id: 'g1', day_id: 'd1', time_block_id: 'b1', activity_id: 'act-1', elective_set_id: null }]
    const wb = capturedWorkbook({ slots, activities, anchors, groups, days, timeBlocks })
    const dayRows = sheetRows(wb, 'Monday')
    expect(dayRows[1][1]).toBe('Swimming')
  })
})
