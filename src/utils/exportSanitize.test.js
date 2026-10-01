import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import * as XLSX from 'xlsx'
import {
  sanitizeCell,
  aoaToSanitizedSheet,
  unescapeCell,
  unescapeRow,
  IMPORT_LIMITS,
  assertImportFileSize,
  assertWorkbookComplexity,
  readWorkbookSafely,
  readWorkbookRows,
} from './exportSanitize.js'

const TRIGGERS = ['=', '+', '-', '@', '\t', '\r', '\n']

// Read a cell's stored string value back out of a built worksheet.
const cellValue = (ws, addr) => ws[addr]?.v

describe('sanitizeCell', () => {
  it('prefixes an apostrophe on every trigger char at cell start', () => {
    for (const t of TRIGGERS) {
      expect(sanitizeCell(`${t}SUM(A1)`)).toBe(`'${t}SUM(A1)`)
    }
  })

  it('escapes classic formula payloads', () => {
    expect(sanitizeCell('=HYPERLINK("http://evil","x")')).toBe('\'=HYPERLINK("http://evil","x")')
    expect(sanitizeCell('=1+1')).toBe("'=1+1")
    expect(sanitizeCell('+A1')).toBe("'+A1")
    expect(sanitizeCell('-2+3')).toBe("'-2+3")
    expect(sanitizeCell('@SUM')).toBe("'@SUM")
  })

  it('leaves ordinary strings untouched', () => {
    expect(sanitizeCell('Swim')).toBe('Swim')
    expect(sanitizeCell('Archery')).toBe('Archery')
    expect(sanitizeCell("O'Brien")).toBe("O'Brien")
    expect(sanitizeCell('Yeladim 1')).toBe('Yeladim 1')
    // A trigger char NOT at the start is fine.
    expect(sanitizeCell('1+1')).toBe('1+1')
    expect(sanitizeCell('a-b')).toBe('a-b')
  })

  it('leaves non-strings (numbers, negatives) untouched', () => {
    expect(sanitizeCell(3)).toBe(3)
    expect(sanitizeCell(-5)).toBe(-5)
    expect(sanitizeCell(0)).toBe(0)
    expect(sanitizeCell(null)).toBe(null)
    expect(sanitizeCell(undefined)).toBe(undefined)
    expect(sanitizeCell(true)).toBe(true)
  })
})

describe('aoaToSanitizedSheet', () => {
  it('escapes every string trigger cell in the written sheet', () => {
    const ws = aoaToSanitizedSheet([
      ['name', 'value'],
      ['=cmd', '@evil'],
      ['-danger', '+plus'],
      ['\ttab', 'Swim'],
    ])
    expect(cellValue(ws, 'A2')).toBe("'=cmd")
    expect(cellValue(ws, 'B2')).toBe("'@evil")
    expect(cellValue(ws, 'A3')).toBe("'-danger")
    expect(cellValue(ws, 'B3')).toBe("'+plus")
    expect(cellValue(ws, 'A4')).toBe("'\ttab")
    expect(cellValue(ws, 'B4')).toBe('Swim')
  })

  it('writes normal strings and numbers unchanged', () => {
    const ws = aoaToSanitizedSheet([
      ['Archery', "O'Brien"],
      [3, -5],
    ])
    expect(cellValue(ws, 'A1')).toBe('Archery')
    expect(cellValue(ws, 'B1')).toBe("O'Brien")
    expect(cellValue(ws, 'A2')).toBe(3)
    expect(cellValue(ws, 'B2')).toBe(-5)
    // Number cells stay numeric, never a string branch.
    expect(ws['A2'].t).toBe('n')
    expect(ws['B2'].t).toBe('n')
  })

  it('a poisoned name reopens as inert text, not a live formula', () => {
    const ws = aoaToSanitizedSheet([['=HYPERLINK("http://x")']])
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'S')
    const roundtrip = XLSX.read(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }), { type: 'array' })
    const cell = roundtrip.Sheets.S['A1']
    // Stored as a literal string cell, no formula (.f) attached.
    expect(cell.t).toBe('s')
    expect(cell.f).toBeUndefined()
    expect(cell.v).toBe('\'=HYPERLINK("http://x")')
  })
})

describe('unescapeCell — conditional strip', () => {
  it('reverses our escape for every trigger case', () => {
    for (const t of TRIGGERS) {
      expect(unescapeCell(sanitizeCell(`${t}payload`))).toBe(`${t}payload`)
    }
  })

  it('round-trips escaped payloads losslessly', () => {
    for (const original of ['=SUM(A1)', '+A1', '-2+3', '@SUM', '=HYPERLINK("x")']) {
      expect(unescapeCell(sanitizeCell(original))).toBe(original)
    }
  })

  it('never strips a legit leading-apostrophe value', () => {
    expect(unescapeCell("'Round the Campfire")).toBe("'Round the Campfire")
    expect(unescapeCell("'Twas the night")).toBe("'Twas the night")
    expect(unescapeCell("'hello")).toBe("'hello")
  })

  it('leaves an Excel quotePrefix value (no literal apostrophe) unchanged', () => {
    expect(unescapeCell('=SUM(A1)')).toBe('=SUM(A1)')
  })

  it('leaves ordinary strings and non-strings untouched', () => {
    expect(unescapeCell('Swim')).toBe('Swim')
    expect(unescapeCell("O'Brien")).toBe("O'Brien")
    expect(unescapeCell(3)).toBe(3)
    expect(unescapeCell(null)).toBe(null)
  })

  it('is fully reversible: sanitize→unescape is identity for every legit value', () => {
    const values = ['Swim', "O'Brien", "'Round the Campfire", '=SUM', '+A1', '-2', '@x', 'Yeladim 1', '1+1']
    for (const v of values) {
      expect(unescapeCell(sanitizeCell(v))).toBe(v)
    }
  })
})

describe('unescapeRow', () => {
  it('unescapes every string cell of an array-of-arrays row', () => {
    expect(unescapeRow(["'=SUM(A1)", 'Swim', 3])).toEqual(['=SUM(A1)', 'Swim', 3])
  })

  it('unescapes every value of a sheet_to_json object row', () => {
    expect(unescapeRow({ name: "'@evil", location: 'Pool', max: 2 }))
      .toEqual({ name: '@evil', location: 'Pool', max: 2 })
  })

  it('leaves a legit leading apostrophe in a row untouched', () => {
    expect(unescapeRow({ name: "'Round the Campfire" }))
      .toEqual({ name: "'Round the Campfire" })
  })
})

describe('import caps — fail closed (F4)', () => {
  it('rejects an over-size file before parsing', () => {
    expect(() => assertImportFileSize(IMPORT_LIMITS.maxBytes + 1)).toThrow(/too large/i)
  })

  it('accepts a normal-size file', () => {
    expect(() => assertImportFileSize(50 * 1024)).not.toThrow()
  })

  it('rejects a workbook with too many sheets', () => {
    const names = Array.from({ length: IMPORT_LIMITS.maxSheets + 1 }, (_, i) => `S${i}`)
    const wb = { SheetNames: names, Sheets: Object.fromEntries(names.map((n) => [n, { '!ref': 'A1:A1' }])) }
    expect(() => assertWorkbookComplexity(wb)).toThrow(/too many sheets/i)
  })

  it('rejects a sheet with too many rows (decompressed-bomb shape)', () => {
    const wb = { SheetNames: ['S'], Sheets: { S: { '!ref': `A1:A${IMPORT_LIMITS.maxRowsPerSheet + 1}` } } }
    expect(() => assertWorkbookComplexity(wb)).toThrow(/too many rows/i)
  })

  it('accepts a normal camp workbook', () => {
    const wb = { SheetNames: ['Day 1', 'All Groups'], Sheets: { 'Day 1': { '!ref': 'A1:H40' }, 'All Groups': { '!ref': 'A1:D200' } } }
    expect(() => assertWorkbookComplexity(wb)).not.toThrow()
  })
})

describe('readWorkbookSafely — single import-read boundary (F4)', () => {
  // Build a tiny, valid xlsx byte array for the happy-path / complexity cases.
  const makeWorkbookBytes = (sheetCount = 1) => {
    const wb = XLSX.utils.book_new()
    for (let i = 0; i < sheetCount; i++) {
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['name'], ['Swim']]), `S${i}`)
    }
    return XLSX.write(wb, { type: 'array', bookType: 'xlsx' })
  }

  it('rejects an over-size file (explicit byteLength) BEFORE parsing', () => {
    // Pass valid bytes but an over-cap byteLength: the size gate must fire first,
    // so the value the caller measured (file.size) is what bounds the read.
    expect(() =>
      readWorkbookSafely(makeWorkbookBytes(), { type: 'array', byteLength: IMPORT_LIMITS.maxBytes + 1 })
    ).toThrow(/too large/i)
  })

  it('rejects an over-size file when byteLength is DERIVED from the data', () => {
    // No explicit byteLength: it falls back to the data's own length. An oversize
    // buffer is rejected before XLSX.read even though the bytes are not valid xlsx
    // (proving the size gate runs first, not the parser).
    const oversize = new Uint8Array(IMPORT_LIMITS.maxBytes + 1)
    expect(() => readWorkbookSafely(oversize, { type: 'array' })).toThrow(/too large/i)
  })

  it('rejects an over-complex workbook (too many sheets) after parse, before walk', () => {
    const bytes = makeWorkbookBytes(IMPORT_LIMITS.maxSheets + 1)
    expect(() => readWorkbookSafely(bytes, { type: 'array', byteLength: bytes.byteLength }))
      .toThrow(/too many sheets/i)
  })

  it('returns the parsed workbook for a normal file', () => {
    const bytes = makeWorkbookBytes(1)
    const wb = readWorkbookSafely(bytes, { type: 'array', byteLength: bytes.byteLength })
    expect(wb.SheetNames).toEqual(['S0'])
    expect(XLSX.utils.sheet_to_json(wb.Sheets.S0, { defval: '' })).toEqual([{ name: 'Swim' }])
  })
})

// Structural gate (ADR §4 / §2a): no export path may build a sheet from user
// data with raw aoa_to_sheet, and no export module may assign .v directly on a
// hand-built cell object (that bypasses the escape). All user-data sheets go
// through aoaToSanitizedSheet.
describe('grep gate — export paths route through the sanitizer', () => {
  const root = join(process.cwd(), 'src')
  const EXPORT_FILES = [
    'utils/exportSchedule.js',
    'screens/GroupsScreen.jsx',
    'screens/ActivitiesScreen.jsx',
    'screens/FixedEventsScreen.jsx',
    'screens/DaysScreen.jsx',
    'screens/TiersScreen.jsx',
    'screens/TimeBlocksScreen.jsx',
  ]

  it('no export file calls raw XLSX.utils.aoa_to_sheet', () => {
    for (const rel of EXPORT_FILES) {
      const src = readFileSync(join(root, rel), 'utf8')
      expect(src, `${rel} still calls raw aoa_to_sheet`).not.toMatch(/aoa_to_sheet/)
    }
  })

  it('no export file assigns .v directly on a cell object', () => {
    for (const rel of EXPORT_FILES) {
      const src = readFileSync(join(root, rel), 'utf8')
      expect(src, `${rel} assigns a cell .v directly`).not.toMatch(/\]\s*=\s*\{[^}]*\bv:/)
      expect(src, `${rel} assigns .v =`).not.toMatch(/\.\s*v\s*=/)
    }
  })

  it('every export file that builds a sheet uses aoaToSanitizedSheet', () => {
    for (const rel of EXPORT_FILES) {
      const src = readFileSync(join(root, rel), 'utf8')
      expect(src, `${rel} does not use aoaToSanitizedSheet`).toMatch(/aoaToSanitizedSheet/)
    }
  })
})

// Structural gate (Finding 2): every file that reads an UPLOADED workbook must
// route through readWorkbookSafely — the single boundary that applies the F4
// exhaustion caps (assertImportFileSize + assertWorkbookComplexity). No import
// read path may call raw XLSX.read directly, or it would parse an attacker-
// authorable file with no size/sheet/row bound (xlsx@0.18.5 has open proto-
// pollution + ReDoS advisories). The seven per-entity setup importers and the
// primary ingest paths are held to the same rule.
describe('grep gate — import read paths route through readWorkbookSafely', () => {
  // Paths relative to the repo root (some live outside src/).
  const repoRoot = process.cwd()
  const IMPORT_READ_FILES = [
    'src/screens/ActivitiesScreen.jsx',
    'src/screens/TimeBlocksScreen.jsx',
    'src/screens/TiersScreen.jsx',
    'src/screens/LocationsScreen.jsx',
    'src/screens/DaysScreen.jsx',
    'src/screens/GroupsScreen.jsx',
    'src/screens/FixedEventsScreen.jsx',
    'src/screens/ImportScreen.jsx',
    'src/screens/elective/ElectiveSetDetail.jsx',
    'src/screens/event/EventGridEditor.jsx',
    'scripts/ingestCli.js',
  ]

  it('no import file calls raw XLSX.read (bypassing the size/complexity caps)', () => {
    for (const rel of IMPORT_READ_FILES) {
      const src = readFileSync(join(repoRoot, rel), 'utf8')
      expect(src, `${rel} still calls raw XLSX.read — route it through readWorkbookSafely`)
        .not.toMatch(/XLSX\.read\s*\(/)
    }
  })

  // WIDENED IN T315, and the purpose is unchanged: no import path may reach a parser without the
  // F4 caps. What changed is that `readEntitySheet` and `readWorkbookRows` now exist as the row
  // boundary ABOVE `readWorkbookSafely`, applying the caps and `unescapeRow` themselves — so a
  // screen that routes through one of them no longer names either, and a check that demanded the
  // literal name would have pushed callers back to hand-rolling the read. That is the failure mode
  // this gate exists to prevent, so the rule names the boundary FUNCTIONS rather than one of them.
  const READ_BOUNDARY = /readWorkbookSafely|readEntitySheet|readWorkbookRows/
  const CELL_UNESCAPE = /unescapeRow|readEntitySheet|readWorkbookRows/

  it('every import file reads workbooks through a capped boundary', () => {
    for (const rel of IMPORT_READ_FILES) {
      const src = readFileSync(join(repoRoot, rel), 'utf8')
      expect(src, `${rel} does not route through a capped read boundary`).toMatch(READ_BOUNDARY)
    }
  })

  it('every import file still applies unescapeRow to imported cells', () => {
    for (const rel of IMPORT_READ_FILES) {
      const src = readFileSync(join(repoRoot, rel), 'utf8')
      expect(src, `${rel} dropped unescapeRow`).toMatch(CELL_UNESCAPE)
    }
  })

  it('NON-VACUITY: the widened rule still rejects a file that reads a workbook by hand', () => {
    // The two checks above pass on a substring, so prove they can still FAIL. A module that parses a
    // workbook without going through any boundary matches neither pattern.
    const byHand = "const wb = XLSX.read(bytes, { type: 'array' })\nconst rows = XLSX.utils.sheet_to_json(wb.Sheets.S)"
    expect(byHand).not.toMatch(READ_BOUNDARY)
    expect(byHand).not.toMatch(CELL_UNESCAPE)
    expect(byHand).toMatch(/XLSX\.read\s*\(/)
  })
})

// T313 — the ROW boundary, one layer above the read boundary. These matter because
// the elective import panel's own CSV branch was removed in favour of this: if the
// caps stopped applying here, they would have stopped applying to that door, and the
// hand-rolled row-count guard it used to carry is gone.
describe('readWorkbookRows — one reader for every door (T313)', () => {
  const bytesOf = (text) => {
    const buf = Buffer.from(text, 'utf8')
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
  }

  it('reads EVERY sheet as row arrays, not just the first', () => {
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['name'], ['Swim']]), 'One')
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['name'], ['Archery']]), 'Two')
    const bytes = XLSX.write(wb, { type: 'array', bookType: 'xlsx' })

    const sheets = readWorkbookRows(bytes, { type: 'array', byteLength: bytes.byteLength })
    expect(sheets.map((s) => s.name)).toEqual(['One', 'Two'])
    expect(sheets[0].rows).toEqual([['name'], ['Swim']])
    expect(sheets[1].rows).toEqual([['name'], ['Archery']])
  })

  it('parses a QUOTED CSV cell as one cell — the hand-split it replaced could not', () => {
    // The defect this function exists to end: a comma inside a quoted cell is
    // ordinary in a spreadsheet export and load-bearing in a preference sheet, and a
    // `split(/\t|,/)` reader cut it in two, shifting every later cell in the row.
    const sheets = readWorkbookRows(bytesOf('Period,Monday,Tuesday\nPeriod 1,"Archery, Ceramics",Swim\n'), {
      type: 'array',
    })
    expect(sheets[0].rows[1]).toEqual(['Period 1', 'Archery, Ceramics', 'Swim'])
  })

  it('reads TSV from the same buffer, so the removed delimited branch lost nothing', () => {
    const sheets = readWorkbookRows(bytesOf('Period\tMonday\nPeriod 1\tArchery\n'), { type: 'array' })
    expect(sheets[0].rows).toEqual([['Period', 'Monday'], ['Period 1', 'Archery']])
  })

  it('does NOT trim cells — trimming here would be a second rule', () => {
    // `cell()` in src/ingest/preferenceSheet.js trims every value it reads and the
    // layout detectors trim every header, so a trim here would change nothing except
    // the submission key a provisional camper is identified by.
    const sheets = readWorkbookRows(bytesOf('Period, Monday \nPeriod 1, Archery \n'), { type: 'array' })
    expect(sheets[0].rows[0]).toEqual(['Period', ' Monday '])
  })

  it('still applies unescapeRow, so an escaped export round-trips clean', () => {
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["'=SUM(A1)"]]), 'S')
    const bytes = XLSX.write(wb, { type: 'array', bookType: 'xlsx' })
    expect(readWorkbookRows(bytes, { type: 'array' })[0].rows[0]).toEqual(['=SUM(A1)'])
  })

  it('STILL applies the size cap, before the parser runs', () => {
    const oversize = new Uint8Array(IMPORT_LIMITS.maxBytes + 1)
    expect(() => readWorkbookRows(oversize, { type: 'array' })).toThrow(/too large/i)
  })

  it('STILL applies the per-sheet row cap — the guard the panel used to hand-roll', () => {
    const csv = `h\n${'x\n'.repeat(IMPORT_LIMITS.maxRowsPerSheet + 1)}`
    expect(() => readWorkbookRows(bytesOf(csv), { type: 'array' })).toThrow(/too many rows/i)
  })
})

// Structural gate (T313). The two camper-preference import doors read an UPLOADED
// workbook and must do it through `readWorkbookRows`, not a hand-rolled delimited
// reader. This is a guard on the CLASS, not on the instance that was fixed: the panel
// had a `split(/\t|,/)` branch that mis-read seven of the 32 corpus probes and forked
// a child's identity between the two doors, and nothing structural stopped it or
// would stop it coming back. The existing readWorkbookSafely gate above cannot cover
// these files, because reading through readWorkbookRows means they no longer name it.
describe('grep gate — the preference import doors share ONE row reader (T313)', () => {
  const repoRoot = process.cwd()
  const PREFERENCE_READ_FILES = [
    'src/screens/elective/assignment/AssignmentPanel.jsx',
    'scripts/preferenceSheetCli.js',
    // The panel's own test USED to replicate the panel's hand-split, which is exactly
    // why it could not see the reader being wrong. It is held to the same rule.
    'test/panelImportPath.test.js',
  ]

  it('each door reads workbooks via readWorkbookRows', () => {
    for (const rel of PREFERENCE_READ_FILES) {
      const src = readFileSync(join(repoRoot, rel), 'utf8')
      expect(src, `${rel} does not use readWorkbookRows`).toMatch(/readWorkbookRows/)
    }
  })

  it('no door calls raw XLSX.read, bypassing the caps', () => {
    for (const rel of PREFERENCE_READ_FILES) {
      const src = readFileSync(join(repoRoot, rel), 'utf8')
      expect(src, `${rel} calls raw XLSX.read — route it through readWorkbookRows`)
        .not.toMatch(/XLSX\.read\s*\(/)
    }
  })

  it('no door splits a line on a comma or tab to make cells', () => {
    // The signature of a hand-rolled delimited reader. Narrow on purpose: it matches
    // a split whose separator is a comma or tab, which is how you cut a CSV row by
    // hand, and not the many legitimate splits on newlines, slashes or spaces.
    const HAND_SPLIT = /\.split\(\s*\/[^/]*(?:\\t\|,|,\|\\t|\[,\\t\]|\[\\t,\])[^/]*\/[a-z]*\s*\)|\.split\(\s*['"][,\t]['"]\s*\)/
    for (const rel of PREFERENCE_READ_FILES) {
      const src = readFileSync(join(repoRoot, rel), 'utf8')
      expect(src, `${rel} hand-splits a row on a delimiter — use readWorkbookRows`)
        .not.toMatch(HAND_SPLIT)
    }
  })
})
