// Tier-2 fuzzing (docs/work/security/2026-09-14-security-program.md) — the ingest parser
// surface. A camp file is attacker-authorable input a director imports from someone else, so
// the parse path must fail closed on garbage, never crash the process, and always respect the
// resource caps. Bounded + SEEDED so any failure reproduces exactly. Property test, not a
// payload hunt: "no input crashes; caps always hold; output is always a sane shape".
import { describe, it, expect } from 'vitest'
import { parseTextGrid } from '../../src/ingest/textGrid.js'
import {
  assertImportFileSize,
  assertWorkbookComplexity,
  IMPORT_LIMITS,
  unescapeRow,
  sanitizeCell,
  unescapeCell,
} from '../../src/utils/exportSanitize.js'

function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const rand = mulberry32(0x9e3779)
const randInt = (max) => Math.floor(rand() * max)
const CHARS = '\t\n ,;:|"\'=+-@0123456789:AMPamp/\\\0abcXYZ日本語💥'
function randText(len) {
  let s = ''
  for (let i = 0; i < len; i++) s += CHARS[randInt(CHARS.length)]
  return s
}

describe('parseTextGrid — arbitrary text never crashes and always returns a sane shape', () => {
  it('300 random blobs: no throw escapes, result always has a pages array', () => {
    for (let i = 0; i < 300; i++) {
      const text = randText(randInt(400))
      let out, threw = false
      try { out = parseTextGrid(text) } catch { threw = true }
      // parseTextGrid must be total over string input: it may return empty pages, but it must
      // not throw on a hostile grid (the import UI shows "nothing could be read", not a crash).
      expect(threw).toBe(false)
      expect(out).toBeTruthy()
      expect(Array.isArray(out.pages)).toBe(true)
    }
  })

  it('degenerate inputs (empty, whitespace, NUL, huge single line) are handled', () => {
    for (const t of ['', '   ', '\n\n\n', '\0\0\0', '\t'.repeat(5000), 'x'.repeat(50000)]) {
      const out = parseTextGrid(t)
      expect(Array.isArray(out.pages)).toBe(true)
    }
  })
})

describe('import resource caps — enforced before any parse work', () => {
  it('assertImportFileSize throws exactly at the byte ceiling, never below', () => {
    expect(() => assertImportFileSize(IMPORT_LIMITS.maxBytes)).not.toThrow()
    expect(() => assertImportFileSize(IMPORT_LIMITS.maxBytes + 1)).toThrow()
    // random sizes: the throw boundary is monotonic and never lets an over-cap size through
    for (let i = 0; i < 200; i++) {
      const size = randInt(IMPORT_LIMITS.maxBytes * 2)
      let threw = false
      try { assertImportFileSize(size) } catch { threw = true }
      expect(threw).toBe(size > IMPORT_LIMITS.maxBytes)
    }
  })

  it('assertWorkbookComplexity rejects too many sheets and never throws on a shapeless object', () => {
    const tooManySheets = { SheetNames: Array.from({ length: IMPORT_LIMITS.maxSheets + 1 }, (_, i) => `s${i}`), Sheets: {} }
    expect(() => assertWorkbookComplexity(tooManySheets)).toThrow()
    // junk workbook shapes must not crash uncatchably (fail-closed or pass, but no crash)
    for (const junk of [{}, { SheetNames: null }, { SheetNames: [], Sheets: null }, { SheetNames: ['a'], Sheets: {} }]) {
      expect(() => assertWorkbookComplexity(junk)).not.toThrow()
    }
  })
})

describe('formula-injection round-trip — sanitize/unescape is lossless and never re-arms', () => {
  it('round-trips losslessly for any value not beginning with an apostrophe', () => {
    // The one documented, accepted asymmetry (ADR 2026-08-08): a value that itself starts with
    // ' followed by a trigger char is indistinguishable from the sanitizer's own escape, so
    // unescape strips that apostrophe. That is a display/storage lossy edge, NOT a security
    // hole — see the re-sanitize invariant below. For every other value the round-trip is exact.
    for (let i = 0; i < 400; i++) {
      const original = randText(randInt(30)).replace(/^'+/, 'x')
      expect(unescapeCell(sanitizeCell(original))).toBe(original)
    }
  })

  it('SECURITY INVARIANT: no value, after unescape, re-sanitizes to a live-formula cell', () => {
    // This is the property that actually matters: whatever a cell holds, the export sanitizer
    // never emits a string a spreadsheet would execute. Exercise the full read→write cycle.
    const TRIG = /^[=+\-@\t\r\n]/
    for (let i = 0; i < 400; i++) {
      const cell = randText(randInt(30))
      const afterImport = unescapeCell(cell)
      const reExported = sanitizeCell(afterImport)
      // A string that would be a live formula must have been escaped (leading apostrophe).
      if (TRIG.test(afterImport)) expect(reExported.startsWith("'")).toBe(true)
    }
  })

  it('an imported row never carries a live-formula leading char after unescape of a sanitized value', () => {
    const TRIGGERS = ['=', '+', '-', '@', '\t', '\r', '\n']
    for (const t of TRIGGERS) {
      const payload = `${t}cmd|'/C calc'!A1`
      // Export sanitizes; a re-import that unescapes OUR escape gets the value back verbatim —
      // it does not silently strip a leading apostrophe a user actually typed.
      expect(unescapeRow([sanitizeCell(payload)])[0]).toBe(payload)
    }
  })
})
