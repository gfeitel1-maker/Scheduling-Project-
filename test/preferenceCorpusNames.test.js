// The ONLY real control over synthetic-only identities in the probe corpus.
//
// docs/adr/2026-09-27-elective-preference-etl-canonical-record-and-learned-axis-binding.md 8.0 clause 4
//
// WHY A TEST AND NOT A GATE. `scanPrivacy` has three content rules — home
// paths, two hashed-token shapes, and email/phone shapes — and CANNOT match an
// unstructured personal name. `scripts/security-gate.js` path-scans binary
// files and never reads their contents, so an .xlsx probe is invisible to it
// twice over. A green security gate over this directory would mean nothing at
// all, and the ADR says so. This test is the control that gate cannot be.
//
// WHAT IT ASSERTS. Every person-name-SHAPED string in every probe file — and in
// every sheet name of every probe workbook — is either a camper name from the
// committed synthetic list or an entry on the hand-reviewed non-person
// vocabulary. A real child's name hand-added to a fixture is person-shaped and
// on neither list, so it fails here.
//
// NON-VACUITY. Two guards, because red-then-green only proves the predicate
// FIRES, never that its instruction is right: one plants the shape the guard is
// meant to catch (a plausible real name), and one plants a shape that is NOT on
// the expected list — a name in a cell that also contains other text — because
// a guard that only catches the defect its author imagined is not a guard.

import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import * as XLSX from 'xlsx'

const DIR = path.join(process.cwd(), 'test/fixtures/preference-corpus')
const PROBES = path.join(DIR, 'probes')

const NAMES = JSON.parse(fs.readFileSync(path.join(DIR, 'synthetic-names.json'), 'utf8')).names
const ALLOWED = JSON.parse(fs.readFileSync(path.join(DIR, 'vocabulary.json'), 'utf8')).allowed
const PERMITTED = new Set([...NAMES, ...ALLOWED])

// A run of two or more consecutive capitalised words. This is what a person's
// name looks like in a spreadsheet cell, and it is deliberately GREEDY so a
// four-word phrase is judged as one phrase rather than two halves.
const PERSON_SHAPE = /\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+\b/g

const personShapedStrings = (text) => String(text ?? '').match(PERSON_SHAPE) ?? []

/** Every cell string in one probe file, plus its sheet names. */
function cellsOf(file) {
  const full = path.join(PROBES, file)
  if (/\.(xlsx|xlsm|xls)$/i.test(file)) {
    const wb = XLSX.read(fs.readFileSync(full), { type: 'buffer' })
    const out = [...wb.SheetNames]
    for (const s of wb.SheetNames) {
      for (const row of XLSX.utils.sheet_to_json(wb.Sheets[s], { header: 1, defval: '', raw: false })) {
        for (const c of row) out.push(String(c ?? ''))
      }
    }
    return out
  }
  // CSV/TSV/TXT are scanned as raw text rather than parsed: a name hidden in a
  // malformed row that no parser reaches is still a name in a committed file.
  return fs.readFileSync(full, 'utf8').split(/[\n\r\t,"]+/)
}

const files = fs.readdirSync(PROBES)

describe('preference probe corpus contains synthetic identities only', () => {
  it('has probe files to check (so an empty directory cannot pass vacuously)', () => {
    expect(files.length).toBeGreaterThan(20)
  })

  it.each(files)('%s contains no person-name-shaped string outside the committed lists', (file) => {
    const offenders = new Set()
    for (const cell of cellsOf(file)) {
      for (const phrase of personShapedStrings(cell)) {
        if (!PERMITTED.has(phrase)) offenders.add(phrase)
      }
    }
    expect([...offenders]).toEqual([])
  })

  it('every camper name the corpus uses is on the synthetic list', () => {
    const used = new Set()
    for (const file of files) {
      for (const cell of cellsOf(file)) {
        for (const phrase of personShapedStrings(cell)) if (NAMES.includes(phrase)) used.add(phrase)
      }
    }
    expect(used.size).toBeGreaterThan(5)
    for (const n of used) expect(NAMES).toContain(n)
  })

  // --- non-vacuity ------------------------------------------------------
  it('rejects a plausible real name standing alone in a cell', () => {
    const offenders = personShapedStrings('Rachel Goldstein').filter((p) => !PERMITTED.has(p))
    expect(offenders).toEqual(['Rachel Goldstein'])
  })

  it('rejects a name EMBEDDED in a cell that also carries permitted text', () => {
    const cell = 'Camper Name: Rachel Goldstein (Upper Division)'
    const offenders = personShapedStrings(cell).filter((p) => !PERMITTED.has(p))
    expect(offenders).toEqual(['Rachel Goldstein'])
  })

  it('does not fire on a permitted non-person phrase', () => {
    expect(personShapedStrings('Rock Climbing').filter((p) => !PERMITTED.has(p))).toEqual([])
  })
})
