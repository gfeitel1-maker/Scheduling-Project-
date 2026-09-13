import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { parseTextGrid } from './textGrid'
import { looksLikeSpecialDayFile, proposeSpecialDay } from './specialDayFile'

// T40 slice 3 — recognise a ONE-DAY special schedule (a Maccabiah, a colour
// war, a trip day) instead of forcing it through the weekly grid.
//
// Measured 2026-09-13 on the ticket's own sample, today's behaviour:
//   days_of_operation: []        - structurally impossible for a weekly file
//   time_blocks:       1         - all five periods collapsed into one
//   activities:        12        - six of them junk ("Sylvia Values",
//                                  "Unit Heads", "Laura Gym", "Lunch Lunch")
// and it passes T146's shape gate, because it genuinely has a time axis.
//
// The signal is the ticket's own point 4: one page, times down the side, and
// NO day name anywhere — not in the columns, not in the title. A weekly file
// always names its days somewhere; that is what makes it weekly.

const SAMPLES = path.join(process.cwd(), 'docs/work/specs/samples')
const real = (f) => parseTextGrid(fs.readFileSync(path.join(SAMPLES, f), 'utf8')).pages

// The shape a spreadsheet yields (workbookToPages): one row per sheet row,
// the first column as the label. This is the ticket's sample verbatim.
const maccabiah = [{
  title: '"Among Us" Maccabiah Schedule 2022',
  columns: ['Lil Chai', 'Chaverim', 'Shalom', 'Giborim'],
  rows: [
    { label: '9:15', cells: ['Opening', 'Opening', 'Opening', 'Opening'] },
    { label: '9:45', cells: ['Team Meeting', 'Team Meeting', 'Team Meeting', 'Team Meeting'] },
    { label: '10:15', cells: ['Pool - Unit Heads', 'Stem - Sylvia', 'Values - Laura', 'Gym - Tomer'] },
    { label: '11:00', cells: ['Gym - Tomer', 'Pool - Unit Heads', 'Stem - Sylvia', 'Values - Laura'] },
    { label: '11:45', cells: ['Lunch', 'Lunch', 'Lunch', 'Lunch'] },
  ],
}]

describe('looksLikeSpecialDayFile', () => {
  it('recognises the one-day grid from the ticket', () => {
    expect(looksLikeSpecialDayFile(maccabiah)).toBe(true)
  })

  it('does NOT claim campA, campB or campC', () => {
    // A false positive routes a camp's real weekly schedule into a throwaway
    // single day — far worse than missing a Maccabiah, which merely leaves
    // today's behaviour in place.
    for (const f of ['campA-bunk-schedules.txt', 'campB-by-day.txt', 'campC-daysheet-synthetic.txt']) {
      expect(looksLikeSpecialDayFile(real(f))).toBe(false)
    }
  })

  it('does not claim a grid whose columns are days', () => {
    expect(looksLikeSpecialDayFile([{
      title: 'Bunk 1', columns: ['Monday', 'Tuesday'],
      rows: [{ label: '9:15', cells: ['Swim', 'Art'] }, { label: '10:00', cells: ['Art', 'Swim'] }],
    }])).toBe(false)
  })

  it('does not claim a grid whose TITLE names a day', () => {
    // campB's shape: one page per day, the day in the title. Exactly one page
    // of it would otherwise look single-day, because it IS one day — but it is
    // one day OF A WEEK, which the weekly path already handles.
    expect(looksLikeSpecialDayFile([{
      title: 'Monday', columns: ['Bunk 1', 'Bunk 2'],
      rows: [{ label: '9:15', cells: ['Swim', 'Art'] }, { label: '10:00', cells: ['Art', 'Swim'] }],
    }])).toBe(false)
  })

  it('does not claim a multi-page file', () => {
    const two = [...maccabiah, { ...maccabiah[0], title: 'Sheet 2' }]
    expect(looksLikeSpecialDayFile(two)).toBe(false)
  })

  it('does not claim a grid with no time axis', () => {
    expect(looksLikeSpecialDayFile([{
      title: 'Legend', columns: ['Meaning'],
      rows: [{ label: 'L', cells: ['Lake'] }, { label: 'M', cells: ['Mess Hall'] }],
    }])).toBe(false)
  })

  it('never throws on degenerate input', () => {
    expect(looksLikeSpecialDayFile(null)).toBe(false)
    expect(looksLikeSpecialDayFile([])).toBe(false)
    expect(looksLikeSpecialDayFile([{ title: 'x' }])).toBe(false)
  })
})

describe('proposeSpecialDay', () => {
  const p = proposeSpecialDay(maccabiah)

  it('names the day from its own title, not the camp', () => {
    expect(p.name).toBe('"Among Us" Maccabiah Schedule 2022')
  })

  it('keeps every period, in the order the file has them', () => {
    expect(p.timeBlocks).toEqual(['9:15', '9:45', '10:15', '11:00', '11:45'])
  })

  it('reads the columns as the groups the day is built for', () => {
    expect(p.columnNames).toEqual(['Lil Chai', 'Chaverim', 'Shalom', 'Giborim'])
  })

  it('splits "Pool - Unit Heads" into an activity and a note, minting neither a location nor a person', () => {
    // The weekly path treats " - " as activity-location and would mint "Unit
    // Heads" as a LOCATION. Here it is a staff name. The owner ruled
    // person-per-cell out of scope, so the remainder is carried as a note on
    // the slot rather than invented as an entity or silently dropped.
    const cell = p.slots.find(s => s.groupName === 'Lil Chai' && s.blockLabel === '10:15')
    expect(cell.activityName).toBe('Pool')
    expect(cell.note).toBe('Unit Heads')
  })

  it('leaves a plain cell noteless', () => {
    const cell = p.slots.find(s => s.groupName === 'Lil Chai' && s.blockLabel === '11:45')
    expect(cell.activityName).toBe('Lunch')
    expect(cell.note).toBeNull()
  })

  it('proposes only the activities the day actually uses, with no staff names among them', () => {
    expect(p.activityNames).toEqual(['Gym', 'Lunch', 'Opening', 'Pool', 'Stem', 'Team Meeting', 'Values'])
  })

  it('skips empty cells rather than proposing blank slots', () => {
    const sparse = proposeSpecialDay([{
      title: 'Colour War', columns: ['Red', 'Blue'],
      rows: [{ label: '9:00', cells: ['Tug of War', ''] }, { label: '10:00', cells: ['', '   '] }],
    }])
    expect(sparse.slots).toHaveLength(1)
    expect(sparse.slots[0]).toMatchObject({ groupName: 'Red', blockLabel: '9:00', activityName: 'Tug of War' })
  })

  it('is deterministic — the same file proposes the same day twice', () => {
    expect(proposeSpecialDay(maccabiah)).toEqual(proposeSpecialDay(maccabiah))
  })

  it('returns null for a file it does not recognise, rather than a half-proposal', () => {
    expect(proposeSpecialDay(real('campA-bunk-schedules.txt'))).toBeNull()
    expect(proposeSpecialDay(null)).toBeNull()
  })
})
