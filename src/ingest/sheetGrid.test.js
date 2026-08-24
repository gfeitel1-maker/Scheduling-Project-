import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import * as XLSX from 'xlsx'
import { sheetToPage, workbookToPages, groupNameFromFilename, sharedFilenamePrefix } from './sheetGrid'
import { extractEntities } from './extractEntities'

// docs/adr/2026-08-01-ingesting-a-prior-year-schedule.md §6 — Tier 1.
//
// Run against a real camp's export where one exists on this machine. Camp
// Mindy's four spreadsheets are the product owner's own files and are NOT
// committed — they carry a real camp's group names, and the permission given
// was to test with them, not to publish them. So these tests use fixtures of
// the same shape, and the one test that reads the real files skips when they
// are absent.

const MINDY_DIR = path.join(process.env.HOME ?? '', 'Downloads')
const mindyFiles = (() => {
  try {
    return fs.readdirSync(MINDY_DIR).filter((n) => /^Camp Mindy.*\.xlsx$/i.test(n))
  } catch {
    return []
  }
})()

const sheet = (rows) => rows

describe('sheetToPage', () => {
  it('reads the days across the top and the times down the side', () => {
    const page = sheetToPage(sheet([
      ['', 'Monday', 'Tuesday'],
      ['9:00 – 9:30 AM', 'Opening', 'Opening'],
      ['9:30 – 10:10 AM', 'Science', 'Judaic'],
    ]), 'K1')

    expect(page.title).toBe('K1')
    expect(page.columns).toEqual(['Monday', 'Tuesday'])
    expect(page.rows).toEqual([
      { label: '9:00 – 9:30 AM', cells: ['Opening', 'Opening'] },
      { label: '9:30 – 10:10 AM', cells: ['Science', 'Judaic'] },
    ])
  })

  it('drops the footnotes camps put under the table', () => {
    // "*Schedule are subject to change", "**SPLAT -- Staff Planned Leisure
    // Activity Time". These sit in the time column with nothing beside them,
    // so without this they become periods of the camp day.
    const page = sheetToPage(sheet([
      ['', 'Monday'],
      ['9:00 – 9:30 AM', 'Opening'],
      ['*Schedule are subject to change', ''],
      ['**SPLAT -- Staff Planned Leisure Activity Time', ''],
    ]), 'K1')
    expect(page.rows).toHaveLength(1)
  })

  it('ignores the empty columns Excel pads a sheet with', () => {
    const page = sheetToPage(sheet([['', 'Monday', 'Tuesday', '', ''], ['9:00', 'Opening', 'Opening', '', '']]), 'K1')
    expect(page.columns).toEqual(['Monday', 'Tuesday'])
  })

  it('returns nothing for a sheet with no table in it', () => {
    expect(sheetToPage(sheet([]), 'x')).toBeNull()
    expect(sheetToPage(sheet([['just a note']]), 'x')).toBeNull()
  })
})

describe('sheetToPage merged cells (blockSpans)', () => {
  // Row 0 = header, rows 1-3 = the merge's raw range. `!merges` coordinates
  // are 0-indexed raw worksheet rows/columns, inclusive.
  const rowsWithMerge = [
    ['', 'Monday', 'Tuesday'],
    ['9:00', 'Ruach & Shabbat', 'Opening'],
    ['9:30', '', 'Judaic'],
    ['10:00', '', 'Science'],
  ]

  it('is a no-op with no third argument — existing 2-arg call sites are unaffected', () => {
    const page = sheetToPage(sheet(rowsWithMerge), 'K1')
    expect(page.rows.every((r) => !('blockSpans' in r))).toBe(true)
  })

  it('records a vertical merge on its anchor row as blockSpans[col] = block count', () => {
    const merges = [{ s: { r: 1, c: 1 }, e: { r: 3, c: 1 } }] // Monday column, 3 raw rows
    const page = sheetToPage(sheet(rowsWithMerge), 'K1', merges)
    expect(page.rows[0].blockSpans).toEqual([3])
    expect(page.rows[0].cells).toEqual(['Ruach & Shabbat', 'Opening']) // occupancy untouched
    expect(page.rows[1].blockSpans).toBeUndefined()
    expect(page.rows[2].blockSpans).toBeUndefined()
  })

  it('counts blocks that survive filtering, not raw rows — a footnote/blank row inside the range is excluded', () => {
    const rows = [
      ['', 'Monday'],
      ['9:00', 'Ruach & Shabbat'],
      ['*note', ''], // footnote row: label matches FOOTNOTE, no cell content — filtered out
      ['9:30', ''],
    ]
    const merges = [{ s: { r: 1, c: 1 }, e: { r: 3, c: 1 } }] // raw range covers 3 rows, only 2 survive
    const page = sheetToPage(sheet(rows), 'K1', merges)
    expect(page.rows[0].blockSpans).toEqual([2])
  })

  it('leaves a horizontal merge un-reconstructed — out of Slice A scope', () => {
    const rows = [
      ['', 'Monday', 'Tuesday'],
      ['9:00', 'Special Event', ''],
    ]
    const merges = [{ s: { r: 1, c: 1 }, e: { r: 1, c: 2 } }] // same row, spans columns
    const page = sheetToPage(sheet(rows), 'K1', merges)
    expect(page.rows.every((r) => !('blockSpans' in r))).toBe(true)
  })

  it('reconstructs a merge when the sheet data does not start at A1 (offset !ref) — through real sheet_to_json (Red Hat)', () => {
    // A real worksheet whose schedule starts at absolute row 5 (a title/banner
    // above it). `!merges` coordinates are ALWAYS absolute, but sheet_to_json's
    // default output is indexed relative to the used range's start — so without
    // pinning the read to the origin, the anchor's absolute row (6) never
    // matches the range-relative row index and the span is silently dropped.
    const aoa = [
      ['', 'Monday', 'Tuesday'],
      ['9:00', 'Ruach & Shabbat', 'Opening'],
      ['9:30', '', 'Judaic'],
      ['10:00', '', 'Science'],
    ]
    const ws = XLSX.utils.aoa_to_sheet(aoa, { origin: 'A6' })
    ws['!merges'] = [{ s: { r: 6, c: 1 }, e: { r: 8, c: 1 } }] // absolute worksheet coords
    // The exact recipe ImportScreen uses: pin the range to (0,0) so array index
    // === absolute row, blankrows:true, and pass the raw !merges.
    const range = { s: { r: 0, c: 0 }, e: XLSX.utils.decode_range(ws['!ref']).e }
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: true, defval: '', raw: false, range })
    const page = sheetToPage(rows, 'K1', ws['!merges'])
    const anchor = page.rows.find((r) => r.cells?.includes('Ruach & Shabbat'))
    expect(anchor?.blockSpans).toEqual([3])
  })

  it('drops a merge whose anchor row was filtered out, without crashing', () => {
    const rows = [
      ['', 'Monday'],
      ['*note', ''], // anchor row 1 is a footnote, filtered — never becomes a body row
      ['9:00', 'Opening'],
    ]
    const merges = [{ s: { r: 1, c: 1 }, e: { r: 2, c: 1 } }]
    expect(() => sheetToPage(sheet(rows), 'K1', merges)).not.toThrow()
    const page = sheetToPage(sheet(rows), 'K1', merges)
    expect(page.rows.every((r) => !('blockSpans' in r))).toBe(true)
  })
})

describe('workbookToPages', () => {
  const populated = { name: 'Sheet1', rows: [['', 'Monday'], ['9:00', 'Opening']] }

  it('names the page after the FILE when only one sheet has a schedule', () => {
    // Excel ships three sheets and camps use one. Naming that page "Sheet1"
    // would make every group in the camp "Sheet1".
    const pages = workbookToPages([populated, { name: 'Sheet2', rows: [] }, { name: 'Sheet3', rows: [] }], '1A')
    expect(pages).toHaveLength(1)
    expect(pages[0].title).toBe('1A')
  })

  it('names each page after its sheet when several carry a schedule', () => {
    const pages = workbookToPages([
      { name: 'Bunk A', rows: [['', 'Monday'], ['9:00', 'Opening']] },
      { name: 'Bunk B', rows: [['', 'Monday'], ['9:00', 'Swim']] },
    ], 'ignored')
    expect(pages.map((p) => p.title)).toEqual(['Bunk A', 'Bunk B'])
  })

  // T36 — a sheet the detector can't turn into a page is silently skipped
  // (Excel padding, a notes sheet). A genuinely empty sheet (no content at
  // all — every workbook ships two or three of these) is not worth a
  // director's attention; a sheet that HAD content but didn't parse is.
  it('reports a sheet with content that could not be read as a page, on the returned array', () => {
    const pages = workbookToPages([
      populated,
      { name: 'Notes', rows: [['just a note, no header row']] },
      { name: 'Sheet3', rows: [] },
    ], '1A')
    expect(pages).toHaveLength(1)
    expect(pages.residual).toEqual([{ sheet: 'Notes', sample: ['just a note, no header row'] }])
  })

  it('reports nothing for a workbook where every unread sheet is genuinely empty', () => {
    const pages = workbookToPages([populated, { name: 'Sheet2', rows: [] }, { name: 'Sheet3', rows: [] }], '1A')
    expect(pages.residual).toEqual([])
  })
})

describe('the group name comes from the filename', () => {
  it('strips what every file has in common, keeping what differs', () => {
    const names = [
      'Camp Mindy Schedule 2025 - 1A.xlsx',
      'Camp Mindy Schedule 2025 - 2-3A.xlsx',
      'Camp Mindy Schedule 2025 - K1.xlsx',
    ]
    const prefix = sharedFilenamePrefix(names)
    expect(names.map((n) => groupNameFromFilename(n, prefix))).toEqual(['1A', '2-3A', 'K1'])
  })

  it('keeps a group name that begins with the same character as another', () => {
    // The shared prefix is trimmed back to a word boundary, so "2-3A" does not
    // lose its "2" to a prefix that happened to end mid-word.
    const names = ['Sched - 2-3A.xlsx', 'Sched - 2-4B.xlsx']
    const prefix = sharedFilenamePrefix(names)
    expect(names.map((n) => groupNameFromFilename(n, prefix))).toEqual(['2-3A', '2-4B'])
  })

  it('strips nothing from a lone file, because there is nothing to compare', () => {
    expect(sharedFilenamePrefix(['Camp Mindy Schedule 2025 - 1A.xlsx'])).toBe('')
  })
})

describe('several files are one camp', () => {
  it('merges the files into one proposal rather than one per file', () => {
    const pages = [
      ...workbookToPages([{ name: 'Sheet1', rows: [['', 'Monday', 'Tuesday'], ['9:00', 'Swim', 'Drama']] }], '1A'),
      ...workbookToPages([{ name: 'Sheet1', rows: [['', 'Monday', 'Tuesday'], ['9:00', 'Swim', 'Archery']] }], 'K1'),
    ]
    const { entities } = extractEntities({ pages })

    expect(entities.groups).toEqual(['1A', 'K1'])
    // Monday and Tuesday appear in both files and are one day each.
    expect(entities.days_of_operation).toEqual(['Monday', 'Tuesday'])
    expect(entities.activities.sort()).toEqual(['Archery', 'Drama', 'Swim'])
  })
})

describe.skipIf(mindyFiles.length === 0)('a real camp export (not committed — see the note above)', () => {
  it('reads four spreadsheets as one camp', () => {
    const prefix = sharedFilenamePrefix(mindyFiles)
    const pages = []
    for (const file of mindyFiles) {
      const wb = XLSX.readFile(path.join(MINDY_DIR, file))
      const sheets = wb.SheetNames.map((name) => ({
        name,
        rows: XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, blankrows: false, defval: '' }),
      }))
      pages.push(...workbookToPages(sheets, groupNameFromFilename(file, prefix)))
    }
    const { entities, orientation } = extractEntities({ pages })

    expect(orientation).toEqual({ columns: 'days', pages: 'groups', confident: true })
    expect(entities.groups).toContain('1A')
    expect(entities.groups).toContain('2-3A')     // not "3A"
    expect(entities.days_of_operation).toEqual(['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'])
    // Real activities the camp writes with a doubled word or a slash.
    expect(entities.activities).toContain('Change/Ga Ga')
    expect(entities.activities).toContain('Change/SPLAT')
    expect(entities.activities).toContain('Gardening with 1F')
    // A footnote must not have become a period.
    for (const b of entities.time_blocks) expect(b).not.toMatch(/^\*/)
  })
})

describe('Excel stores a time as a number', () => {
  it('reads a fraction of a day as the time it means', () => {
    // 9:15am is 0.3854166666666667. Left alone it becomes the name of a
    // period. Callers pass raw:false so Excel formats it, but a cell with no
    // format still arrives as a number.
    const page = sheetToPage(sheet([
      ['', 'Monday'],
      [0.3854166666666667, 'Opening'],
      [0.5104166666666666, 'Lunch'],
    ]), 'Team A')
    expect(page.rows.map((r) => r.label)).toEqual(['9:15', '12:15'])
  })

  it('leaves an ordinary number alone', () => {
    const page = sheetToPage(sheet([['', 'Monday'], ['2', 'Opening']]), 'x')
    expect(page.rows[0].label).toBe('2')
  })
})
