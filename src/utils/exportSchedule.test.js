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

// Events overlay placement Slice 1 (docs/adr/2026-08-22-events-overlay-
// placement.md §3) — exportSchedule.js gets an event_id branch parallel to
// the existing elective_set_id branch.
describe('exportToExcel — events overlay branch', () => {
  it('renders an event cell as its event name, not blank', () => {
    const slots = [{ group_id: 'g1', day_id: 'd1', time_block_id: 'b1', event_id: 'ev-1', activity_id: null, elective_set_id: null }]
    const events = [{ id: 'ev-1', name: 'Color War' }]
    const wb = capturedWorkbook({ slots, activities, anchors, groups, days, timeBlocks, events })

    const dayRows = sheetRows(wb, 'Monday')
    expect(dayRows[1][1]).toBe('Color War')

    const masterRows = sheetRows(wb, 'All Groups')
    expect(masterRows[1][3]).toBe('Color War')
  })

  it('a dangling event_id (event deleted) renders "Event (removed)"', () => {
    const slots = [{ group_id: 'g1', day_id: 'd1', time_block_id: 'b1', event_id: 'ev-gone', activity_id: null, elective_set_id: null }]
    const wb = capturedWorkbook({ slots, activities, anchors, groups, days, timeBlocks, events: [] })

    const dayRows = sheetRows(wb, 'Monday')
    expect(dayRows[1][1]).toBe('Event (removed)')
    const masterRows = sheetRows(wb, 'All Groups')
    expect(masterRows[1][3]).toBe('Event (removed)')
  })
})

// T248 leftover (docs/work/tickets/T248-child-schedule-export.md:51-52) —
// the group export's own span-unawareness. A multi-period activity on the
// grid is NOT one slot with a span_blocks count: span_blocks lives on
// activities/fixed_events, never on template_slots (electron/db/localDb.js:273,
// 346-348). Instead it is an is_span_head CHAIN — a head row plus one real
// template_slots row PER COVERED PERIOD, every row sharing the same
// activity_id, tails marked is_span_head === false (src/screens/schedule/
// useSlotMutations.js's collectSpanTails, lines 49-65). The shape below is
// what exportToExcel actually receives at runtime, not the raw SQLite
// integer: useScheduleData.js normalizes every row through normalizeSlots()
// (src/utils/normalizeSlots.js:27-30,74-78) before ScheduleScreen.jsx hands
// the bundle to exportToExcel (src/screens/ScheduleScreen.jsx:888), and
// normalizeSlots's toSlotBool turns the nullable INTEGER column into
// true/false/null/undefined — never 0/1. So the head row here carries
// is_span_head: true and the tail carries is_span_head: false, matching what
// a reloaded merged slot looks like in the renderer.
describe('exportToExcel — multi-period span (T248 leftover)', () => {
  const spanDays = [{ id: 'd1', label: 'Monday' }]
  const spanBlocks = [
    { id: 'b1', name: 'Period 1', start_time: '09:00:00', end_time: '10:00:00' },
    { id: 'b2', name: 'Period 2', start_time: '10:00:00', end_time: '11:00:00' },
  ]
  const spanGroups = [{ id: 'g1', name: 'Bunk 1' }]
  const spanActivities = [{ id: 'act-1', name: 'Swimming' }]

  it('includes every covered period of a span in the day sheet and the master sheet, and nothing spurious', () => {
    const slots = [
      { group_id: 'g1', day_id: 'd1', time_block_id: 'b1', activity_id: 'act-1', elective_set_id: null, is_span_head: true },
      { group_id: 'g1', day_id: 'd1', time_block_id: 'b2', activity_id: 'act-1', elective_set_id: null, is_span_head: false },
    ]
    const wb = capturedWorkbook({ slots, activities: spanActivities, anchors, groups: spanGroups, days: spanDays, timeBlocks: spanBlocks })

    const dayRows = sheetRows(wb, 'Monday')
    // header + one row per time block — assert the whole population, not just the row we expect.
    expect(dayRows).toEqual([
      ['Time Block', 'Bunk 1'],
      ['Period 1 (09:00–10:00)', 'Swimming'],
      ['Period 2 (10:00–11:00)', 'Swimming'],
    ])

    const masterRows = sheetRows(wb, 'All Groups')
    expect(masterRows).toEqual([
      ['Group', 'Day', 'Time Block', 'Activity'],
      ['Bunk 1', 'Monday', 'Period 1', 'Swimming'],
      ['Bunk 1', 'Monday', 'Period 2', 'Swimming'],
    ])
  })
})
