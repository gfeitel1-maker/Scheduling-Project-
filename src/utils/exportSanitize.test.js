import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
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
    'screens/AnchorsScreen.jsx',
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
