// T319 — importEventRunName produces the name for an elective_assignment_runs
// row from the IMPORT EVENT (when it happened, how many sheets it read), never
// from a filename. See src/ingest/importEventRunName.js for the full rationale.
//
// Every `at` here is built from LOCAL date/time components
// (`new Date(y, m, d, h, min, s)`), never from an ISO string or UTC fields, so
// this test cannot flake depending on the machine's timezone: the function
// formats in local time, and so does the fixture that feeds it.
import { describe, it, expect } from 'vitest'

import { importEventRunName } from './importEventRunName.js'

describe('importEventRunName', () => {
  it('formats as "Import YYYY-MM-DD HH:MM, N sheets"', () => {
    const at = new Date(2026, 8, 29, 14, 2, 37) // 2026-09-29 14:02:37 local
    expect(importEventRunName({ at, sheetCount: 32 })).toBe('Import 2026-09-29 14:02, 32 sheets')
  })

  it('uses singular "1 sheet" for exactly one sheet', () => {
    const at = new Date(2026, 8, 29, 14, 2, 37)
    expect(importEventRunName({ at, sheetCount: 1 })).toBe('Import 2026-09-29 14:02, 1 sheet')
  })

  it('uses plural "0 sheets" for zero', () => {
    const at = new Date(2026, 8, 29, 14, 2, 37)
    expect(importEventRunName({ at, sheetCount: 0 })).toBe('Import 2026-09-29 14:02, 0 sheets')
  })

  it('uses plural for a large count', () => {
    const at = new Date(2026, 8, 29, 14, 2, 37)
    expect(importEventRunName({ at, sheetCount: 2 })).toBe('Import 2026-09-29 14:02, 2 sheets')
  })

  it('ignores seconds — precision is to the minute', () => {
    const a = importEventRunName({ at: new Date(2026, 8, 29, 14, 2, 0), sheetCount: 1 })
    const b = importEventRunName({ at: new Date(2026, 8, 29, 14, 2, 59), sheetCount: 1 })
    expect(a).toBe(b)
    expect(a).toBe('Import 2026-09-29 14:02, 1 sheet')
  })

  it('zero-pads month, day, hour and minute', () => {
    const at = new Date(2026, 0, 5, 9, 7, 0) // 2026-01-05 09:07
    expect(importEventRunName({ at, sheetCount: 1 })).toBe('Import 2026-01-05 09:07, 1 sheet')
  })

  it('is deterministic for a given `at`', () => {
    const at = new Date(2026, 8, 29, 14, 2, 37)
    expect(importEventRunName({ at, sheetCount: 5 })).toBe(importEventRunName({ at, sheetCount: 5 }))
  })
})
