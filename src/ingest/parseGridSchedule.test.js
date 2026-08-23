// docs/work/specs/2026-08-22-event-schedule-import-slices.md Step 1.
import { describe, it, expect } from 'vitest'
import { parseGridSchedule } from './parseGridSchedule'

describe('parseGridSchedule — orientation', () => {
  it('rows-are-time: row labels are time ranges, columns are groups', () => {
    const page = {
      title: 'Sports Day',
      columns: ['Kinders', '1st Grade'],
      rows: [
        { label: '9:30-10:10', cells: ['Swim', 'Watersports'] },
        { label: '10:15-10:55', cells: ['Watersports', 'Swim'] },
      ],
    }
    const result = parseGridSchedule([page])
    expect(result.orientation).toEqual({ axis: 'rows-are-time', confident: true })
    expect(result.timeAxis).toEqual([
      { name: '9:30-10:10', start_time: '09:30', end_time: '10:10', sourceLabel: '9:30-10:10', sourceIndex: 0 },
      { name: '10:15-10:55', start_time: '10:15', end_time: '10:55', sourceLabel: '10:15-10:55', sourceIndex: 1 },
    ])
    expect(result.groupAxis).toEqual([
      { name: 'Kinders', sourceLabel: 'Kinders', sourceIndex: 0 },
      { name: '1st Grade', sourceLabel: '1st Grade', sourceIndex: 1 },
    ])
    expect(result.cells).toEqual(expect.arrayContaining([
      { timeIndex: 0, groupIndex: 0, activityName: 'Swim', locationName: null },
      { timeIndex: 0, groupIndex: 1, activityName: 'Watersports', locationName: null },
      { timeIndex: 1, groupIndex: 0, activityName: 'Watersports', locationName: null },
      { timeIndex: 1, groupIndex: 1, activityName: 'Swim', locationName: null },
    ]))
    expect(result.cells).toHaveLength(4)
  })

  it('columns-are-time: header row is times, row.label is the group', () => {
    const page = {
      title: 'Sports Day',
      columns: ['9:30-10:10', '10:15-10:55'],
      rows: [
        { label: 'Kinders', cells: ['Swim', 'Watersports'] },
        { label: '1st Grade', cells: ['Watersports', 'Swim'] },
      ],
    }
    const result = parseGridSchedule([page])
    expect(result.orientation).toEqual({ axis: 'columns-are-time', confident: true })
    expect(result.timeAxis.map((t) => t.name)).toEqual(['9:30-10:10', '10:15-10:55'])
    expect(result.groupAxis.map((g) => g.name)).toEqual(['Kinders', '1st Grade'])
    expect(result.cells).toEqual(expect.arrayContaining([
      { timeIndex: 0, groupIndex: 0, activityName: 'Swim', locationName: null },
      { timeIndex: 1, groupIndex: 0, activityName: 'Watersports', locationName: null },
      { timeIndex: 0, groupIndex: 1, activityName: 'Watersports', locationName: null },
      { timeIndex: 1, groupIndex: 1, activityName: 'Swim', locationName: null },
    ]))
  })

  it('not confident: neither axis clears the time majority', () => {
    const page = {
      title: 'Roster',
      columns: ['Group A', 'Group B'],
      rows: [
        { label: 'Monday', cells: ['Art', 'Music'] },
        { label: 'Tuesday', cells: ['Music', 'Art'] },
      ],
    }
    const result = parseGridSchedule([page])
    expect(result.orientation).toEqual({ axis: null, confident: false })
    expect(result.timeAxis).toEqual([])
    expect(result.groupAxis).toEqual([])
    expect(result.cells).toEqual([])
  })
})

describe('parseGridSchedule — time-range parsing', () => {
  it('parses "9:30-10:10" into name/start_time/end_time', () => {
    const page = { title: 't', columns: ['G'], rows: [{ label: '9:30-10:10', cells: ['Swim'] }] }
    const result = parseGridSchedule([page])
    expect(result.timeAxis[0]).toMatchObject({ start_time: '09:30', end_time: '10:10' })
  })

  it('a non-range label still becomes a timeAxis entry, never dropped', () => {
    // A single time-labelled row plus one non-range row does not clear the
    // 0.6 majority (1/2) — pad with a second time row to keep confidence.
    const page2 = {
      title: 't',
      columns: ['G'],
      rows: [
        { label: '9:30-10:10', cells: ['Swim'] },
        { label: '10:15-10:55', cells: ['Music'] },
        { label: 'Morning Block', cells: ['Dance'] },
      ],
    }
    const result2 = parseGridSchedule([page2])
    expect(result2.orientation.confident).toBe(true)
    const morning = result2.timeAxis.find((t) => t.name === 'Morning Block')
    expect(morning).toMatchObject({ name: 'Morning Block', start_time: null, end_time: null })
  })
})

describe('parseGridSchedule — cell text cleaning', () => {
  it('reuses cleanCellValue for time-leakage/noise in a cell', () => {
    const page = {
      title: 't',
      columns: ['G'],
      rows: [
        { label: '9:30-10:10', cells: ['Instructional Swim 11:45-12:10-'] },
        { label: '10:15-10:55', cells: ['Music'] },
      ],
    }
    const result = parseGridSchedule([page])
    const cell = result.cells.find((c) => c.timeIndex === 0)
    expect(cell.activityName).toBe('Instructional Swim')
  })
})

describe('parseGridSchedule — location key', () => {
  it('fills locationName from a "WHERE TO GO" section by majority vote', () => {
    const page = {
      title: 'Sports Day',
      columns: ['Kinders', '1st Grade'],
      rows: [
        { label: '9:30-10:10', cells: ['Watersports', 'Swim'] },
        { label: '10:15-10:55', cells: ['Watersports', 'Zumba'] },
        { label: 'WHERE TO GO', cells: [] },
        { label: 'Watersports = Field', cells: [] },
        { label: 'Zumba = Dance Studio', cells: [] },
      ],
    }
    const result = parseGridSchedule([page])
    expect(result.orientation.confident).toBe(true)
    const watersports = result.cells.filter((c) => c.activityName === 'Watersports')
    expect(watersports.every((c) => c.locationName === 'Field')).toBe(true)
    const zumba = result.cells.find((c) => c.activityName === 'Zumba')
    expect(zumba.locationName === 'Dance Studio' || zumba.locationName === null).toBe(true)
    expect(result.locationKey).toMatchObject({ watersports: 'Field' })
  })

  it('an activity with no key entry gets locationName: null, not unmapped', () => {
    const page = {
      title: 't',
      columns: ['G'],
      rows: [
        { label: '9:30-10:10', cells: ['Swim'] },
        { label: '10:15-10:55', cells: ['Zumba'] },
        { label: 'WHERE TO GO', cells: [] },
        { label: 'Zumba = Dance Studio', cells: [] },
      ],
    }
    const result = parseGridSchedule([page])
    const swim = result.cells.find((c) => c.activityName === 'Swim')
    expect(swim.locationName).toBeNull()
    expect(result.unmapped).toEqual([])
  })
})

describe('parseGridSchedule — empty/degenerate input', () => {
  it('parseGridSchedule([]) returns the empty-but-well-formed shape', () => {
    const result = parseGridSchedule([])
    expect(result).toEqual({
      orientation: { axis: null, confident: false },
      timeAxis: [],
      groupAxis: [],
      cells: [],
      locationKey: null,
      unmapped: [],
    })
  })

  it('a page with no columns/rows returns the empty shape, never throws', () => {
    const result = parseGridSchedule([{ title: 'x', columns: [], rows: [] }])
    expect(result.orientation.confident).toBe(false)
    expect(result.timeAxis).toEqual([])
    expect(result.groupAxis).toEqual([])
    expect(result.cells).toEqual([])
  })
})

describe('parseGridSchedule — real Sports Day fixture (Step 0)', () => {
  // Ground truth from the real file (scratchpad "Sports day.xlsx", read via
  // XLSX + sheetToPage): rows are time ranges ("9:30-10:10"), columns are
  // grade bands ("Kinders", "1st Grade", ...), plus two metadata rows
  // ("Friday", "Mifkad") with empty labels and a "WHERE TO GO" location-key
  // section as trailing rows of the SAME sheet — exactly what
  // parseGridSchedule's splitKeySection handles.
  it('parses the real file shape end to end', () => {
    const page = {
      title: 'Sports day',
      columns: ['Kinders', '1st Grade', '2nd Grade', '3rd/4th Grade', '5th/6th Grade', '', '', '', 'Sailing'],
      rows: [
        { label: '', cells: ['Friday', 'Friday', 'Friday', 'Friday', 'Friday', '', '', '', 'Friday'] },
        { label: '', cells: ['Mifkad', 'Mifkad', 'Mifkad', 'Mifkad', 'Mifkad', '', '', '', 'Mifkad'] },
        { label: '9:30-10:10', cells: ['Swim', 'Watersports', 'Gymnastics', 'Zumba', 'Group Time', '', '', '', 'Sailing'] },
        { label: '10:15-10:55', cells: ['Water Sports', 'Swim', 'Zumba', 'Gymnastics', 'Obstacle Course', '', '', '', 'Sailing'] },
        { label: '11:00-11:40', cells: ['Obstacle Course', 'Gymnastics', 'Swim', 'Watersports', 'Zumba', '', '', '', 'Sailing'] },
        { label: '11:45-12:25', cells: ['Zumba', 'Obstacle Course', 'Water Sports', 'Swim', 'Gymnastics', '', '', '', 'Sailing'] },
        { label: '12:30-1:45', cells: ['Lunch', 'Lunch', 'Lunch', 'Lunch', 'Lunch', '', '', '', 'Lunch'] },
        { label: '2:00-2:30', cells: ['Staff Dodgeball', 'Dodgeball', 'Dodgeball', 'Dodgeball', 'Dodgeball', '', '', '', 'Gynmastics'] },
        { label: '2:30-2:45', cells: ['7th inning stretch', 'Stretch', 'Stretch', 'Stretch', 'Stretch', '', '', '', ''] },
        { label: '2:45-3:15', cells: ['Staff Knockout', 'Knockout', 'Knockout', 'Knockout', 'Knockout', '', '', '', 'Swim'] },
        { label: '3:15-3:30', cells: ['Dance Party', 'Dance', 'Dance', 'Dance', 'Dance', '', '', '', ''] },
        { label: '', cells: ['Mifkad', 'Mifkad', 'Mifkad', 'Mifkad', 'Mifkad', '', '', '', 'Mifkad'] },
        { label: 'WHERE TO GO', cells: [] },
        { label: 'Watersports  = Field', cells: [] },
        { label: 'Obstacle Course = Gym Side B', cells: [] },
        { label: 'Gymnastics = Gym Side A', cells: [] },
        { label: 'Zumba = Dance Studio', cells: [] },
      ],
    }

    const result = parseGridSchedule([page])

    expect(result.orientation).toEqual({ axis: 'rows-are-time', confident: true })
    // 9 real timed periods; the two empty-labelled metadata rows (Friday,
    // Mifkad x2) are dropped, not turned into nameless periods.
    expect(result.timeAxis).toHaveLength(9)
    expect(result.timeAxis[0]).toMatchObject({ name: '9:30-10:10', start_time: '09:30', end_time: '10:10' })
    // The blank padding columns between "5th/6th Grade" and "Sailing" are
    // dropped from groupAxis; six real columns remain.
    expect(result.groupAxis.map((g) => g.name)).toEqual([
      'Kinders', '1st Grade', '2nd Grade', '3rd/4th Grade', '5th/6th Grade', 'Sailing',
    ])
    const swimCell = result.cells.find((c) => c.timeIndex === 0 && c.groupIndex === 0)
    expect(swimCell.activityName).toBe('Swim')
    const watersportsCells = result.cells.filter((c) => c.activityName === 'Watersports' || c.activityName === 'Water Sports')
    expect(watersportsCells.length).toBeGreaterThan(0)
    expect(result.locationKey).toMatchObject({
      'obstacle course': 'Gym Side B',
      gymnastics: 'Gym Side A',
      zumba: 'Dance Studio',
    })
  })
})
