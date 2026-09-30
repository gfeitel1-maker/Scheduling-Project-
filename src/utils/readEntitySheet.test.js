// T315 — EVERY per-entity importer reads the tab that holds ITS entity.
//
// The four setup importers each ran `sheet_to_json(wb.Sheets[wb.SheetNames[0]])`, so a director whose
// table sat on any tab but the first got one of two outcomes. Measured on a workbook in this app's own
// export order (Programs, Age Divisions, Groups, Days, Time Blocks, Activities):
//
//   * Days and Anchors read `Programs`, found none of their fields, and imported NOTHING;
//   * Groups and Activities read `name` off `Programs` and would have imported the camp's PROGRAM as a
//     group and as an activity — a plausible-looking row nobody created. That is the worse half, and
//     it is silence with wrong data in it rather than a refusal.
//
// These assert on the ROWS the importer receives, which is the seam the four screens share. The
// per-screen wiring is covered where it can only be covered — driving the rendered screens, in each
// screen's own suite.
import { describe, it, expect } from 'vitest'
import * as XLSX from 'xlsx'

import { readEntitySheet, IMPORT_LIMITS } from './exportSanitize.js'

/** A workbook in the app's own export order, so the fixture is the real hazard rather than a made-up one. */
function exportOrderWorkbook() {
  const wb = XLSX.utils.book_new()
  const add = (name, rows) => XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), name)
  add('Programs', [{ name: 'Main Camp' }])
  add('Age Divisions', [{ name: 'Juniors' }])
  add('Groups', [{ name: 'Bunk 1', tier_name: 'Juniors', availability: 'all' }])
  add('Days', [{ label: 'Monday', day_of_week: 1, sort_order: 1 }])
  add('Time Blocks', [{ name: 'First Period', start_time: '09:00', end_time: '10:00' }])
  add('Activities', [{ name: 'Archery', eligible_tiers: 'Juniors' }])
  add('Anchors', [{ name: 'Lunch', day_label: 'all', time_block_name: 'First Period' }])
  add('Locations', [{ name: 'Main Field', capacity: 40, kind: 'field' }])
  return XLSX.write(wb, { type: 'array', bookType: 'xlsx' })
}

const book = (tabs) => {
  const wb = XLSX.utils.book_new()
  for (const [name, rows] of tabs) XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), name)
  return XLSX.write(wb, { type: 'array', bookType: 'xlsx' })
}

// Exactly what each screen passes, so this table IS the contract rather than a paraphrase of it.
const DOORS = [
  { screen: 'DaysScreen', sheetName: 'Days', requiredColumns: ['label'], field: 'label', expect: 'Monday' },
  { screen: 'GroupsScreen', sheetName: 'Groups', requiredColumns: ['name', 'tier_name'], field: 'name', expect: 'Bunk 1' },
  { screen: 'ActivitiesScreen', sheetName: 'Activities', requiredColumns: ['name'], field: 'name', expect: 'Archery' },
  { screen: 'AnchorsScreen', sheetName: 'Anchors', requiredColumns: ['name', 'day_label'], field: 'name', expect: 'Lunch' },
  // The two doors an earlier count of this defect missed. Both key on `name`, so both had the WORSE
  // failure rather than the mild one: the camp's `Programs` tab arriving as an age division and as a
  // time block. Six doors, not four — recorded here because a short count is how the fifth and sixth
  // get forgotten.
  { screen: 'TiersScreen', sheetName: 'Age Divisions', requiredColumns: ['name'], field: 'name', expect: 'Juniors' },
  { screen: 'TimeBlocksScreen', sheetName: 'Time Blocks', requiredColumns: ['name', 'start_time'], field: 'name', expect: 'First Period' },
  // The SEVENTH door (T317). LocationsScreen got to this rule first and spelled it by hand —
  // `SheetNames.includes('Locations') ? 'Locations' : SheetNames[0]` — which was right about the
  // app's own exports and left two gaps: no column fallback, and a case-SENSITIVE name match.
  { screen: 'LocationsScreen', sheetName: 'Locations', requiredColumns: ['name', 'capacity'], field: 'name', expect: 'Main Field' },
]

describe('readEntitySheet — each door finds its own tab', () => {
  const bytes = exportOrderWorkbook()

  for (const door of DOORS) {
    it(`${door.screen}: reads the ${door.sheetName} tab, not the first`, () => {
      const { sheet, rows } = readEntitySheet(bytes, {
        type: 'array',
        sheetName: door.sheetName,
        requiredColumns: door.requiredColumns,
      })
      expect(sheet).toBe(door.sheetName)
      expect(rows.map((r) => r[door.field])).toEqual([door.expect])
      // The specific old failure, stated directly: the camp's PROGRAM must not arrive as this entity.
      expect(rows.map((r) => r[door.field])).not.toContain('Main Camp')
    })
  }

  it('names the tabs it did not read, so a director can see which one produced these rows', () => {
    const { sheet, otherSheets } = readEntitySheet(bytes, { type: 'array', sheetName: 'Days', requiredColumns: ['label'] })
    expect(sheet).toBe('Days')
    expect(otherSheets).toContain('Programs')
    expect(otherSheets).not.toContain('Days')
  })
})

describe('readEntitySheet — the selection order, each step earning its place', () => {
  it('1. the sheet NAME wins, case- and space-insensitively', () => {
    const bytes = book([['Other', [{ label: 'Wrong' }]], ['  days  ', [{ label: 'Monday' }]]])
    const { rows } = readEntitySheet(bytes, { type: 'array', sheetName: 'Days', requiredColumns: ['label'] })
    expect(rows.map((r) => r.label)).toEqual(['Monday'])
  })

  it('2. the required COLUMNS decide when no tab carries the name — a third-party file', () => {
    const bytes = book([['Sheet1', [{ note: 'cover page' }]], ['Sheet2', [{ label: 'Monday' }]]])
    const { sheet, rows } = readEntitySheet(bytes, { type: 'array', sheetName: 'Days', requiredColumns: ['label'] })
    expect(sheet).toBe('Sheet2')
    expect(rows.map((r) => r.label)).toEqual(['Monday'])
  })

  it('ALL required columns are needed, not any of them', () => {
    // `name` alone matches four of this app's own sheets, so a partial match must not win.
    const bytes = book([
      ['Programs', [{ name: 'Main Camp' }]],
      ['Whatever', [{ name: 'Bunk 1', tier_name: 'Juniors' }]],
    ])
    const { sheet } = readEntitySheet(bytes, { type: 'array', sheetName: 'Groups', requiredColumns: ['name', 'tier_name'] })
    expect(sheet).toBe('Whatever')
  })

  it('3. falls back to the FIRST sheet, so a single-sheet third-party file is unchanged', () => {
    // THE NO-REGRESSION CASE, and the reason this is not a rewrite of every importer's contract: a
    // file whose headers this app does not recognise still reaches the screen's own warnings, exactly
    // as it did when the screens took sheet 1 unconditionally.
    const bytes = book([['Sheet1', [{ Day: 'Monday', Order: 1 }]]])
    const { sheet, rows, otherSheets } = readEntitySheet(bytes, {
      type: 'array', sheetName: 'Days', requiredColumns: ['label'],
    })
    expect(sheet).toBe('Sheet1')
    expect(rows).toEqual([{ Day: 'Monday', Order: 1 }])
    expect(otherSheets).toEqual([])
  })

  it('the first MATCH wins when several tabs qualify — accept-and-report, never a merge', () => {
    const bytes = book([['A', [{ label: 'First' }]], ['B', [{ label: 'Second' }]]])
    const { sheet, rows, otherSheets } = readEntitySheet(bytes, { type: 'array', requiredColumns: ['label'] })
    expect(sheet).toBe('A')
    expect(rows.map((r) => r.label)).toEqual(['First'])
    // Nothing is concatenated: the second tab is reported, not appended.
    expect(otherSheets).toEqual(['B'])
  })
})

describe('readEntitySheet — the caps still apply', () => {
  it('STILL enforces the byte cap, before the parser runs', () => {
    const oversize = new Uint8Array(IMPORT_LIMITS.maxBytes + 1)
    expect(() => readEntitySheet(oversize, { type: 'array' })).toThrow(/too large/i)
  })

  it('STILL enforces the per-sheet row cap', () => {
    const rows = Array.from({ length: IMPORT_LIMITS.maxRowsPerSheet + 1 }, (_, i) => ({ label: `d${i}` }))
    expect(() => readEntitySheet(book([['Days', rows]]), { type: 'array' })).toThrow(/too many rows/i)
  })

  it('unescapes cells, so an escaped export round-trips clean', () => {
    const bytes = book([['Days', [{ label: "'=SUM(A1)" }]]])
    expect(readEntitySheet(bytes, { type: 'array', sheetName: 'Days' }).rows[0].label).toBe('=SUM(A1)')
  })
})

describe('the two gaps the hand-rolled locations rule left (T317)', () => {
  it('matches the sheet name case- and space-insensitively', () => {
    // `SheetNames.includes('Locations')` missed these and fell back to tab 1, where the rows belong
    // to somebody else's entity.
    for (const name of ['locations', 'LOCATIONS', ' Locations ']) {
      const bytes = book([['Cover', [{ note: 'read me' }]], [name, [{ name: 'Main Field', capacity: 40 }]]])
      const { rows } = readEntitySheet(bytes, {
        type: 'array', sheetName: 'Locations', requiredColumns: ['name', 'capacity'],
      })
      expect(rows.map((r) => r.name), `sheet named ${JSON.stringify(name)}`).toEqual(['Main Field'])
    }
  })

  it('finds the table by COLUMNS when no tab is called Locations', () => {
    const bytes = book([['Cover', [{ note: 'read me' }]], ['Sheet2', [{ name: 'Main Field', capacity: 40 }]]])
    const { sheet } = readEntitySheet(bytes, {
      type: 'array', sheetName: 'Locations', requiredColumns: ['name', 'capacity'],
    })
    expect(sheet).toBe('Sheet2')
  })

  it('NON-VACUITY: a tab with `name` but no `capacity` is NOT taken for a locations table', () => {
    // Otherwise the column fallback would match the Programs tab, which is the failure T315 fixed.
    const bytes = book([['Programs', [{ name: 'Main Camp' }]], ['Places', [{ name: 'Main Field', capacity: 40 }]]])
    const { sheet } = readEntitySheet(bytes, {
      type: 'array', sheetName: 'Locations', requiredColumns: ['name', 'capacity'],
    })
    expect(sheet).toBe('Places')
  })
})
