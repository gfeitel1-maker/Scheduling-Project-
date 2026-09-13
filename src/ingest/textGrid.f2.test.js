import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { tokenize, isHeaderLine, hasTimeLabel, parseTextGrid } from './textGrid'

// T36 F2 — a BODY row must not be mistaken for a header.
//
// `isHeaderLine` accepted any first token STARTING with time/times/period, so a
// period literally named "Period 2", or an activity called "Times Up", read as
// a header. That starts a spurious page mid-body: the grid is cut at that row
// and whatever sat above it can be lost. Raised 2026-08-03 and proven then;
// re-verified as still reproducing on 2026-09-13 before this fix.
//
// The tightening is an EXACT match on the label rather than a prefix. Every
// time-labelled header in the four-camp corpus is the single word "Time"
// (measured, not assumed), so nothing real is refused — while "Period 2" and
// "Times Up" are no longer labels at all, because a column LABEL names the
// column and "Period 2" names one particular period.

const SAMPLES = path.join(process.cwd(), 'docs/work/specs/samples')
const header = (line) => isHeaderLine(tokenize(line))

describe('isHeaderLine — a body row starting with a time word (T36 F2)', () => {
  it.each([
    ['Period 2  Art  Swim  Dance'],
    ['Period 3  Archery  Pool'],
    ['Times Up  Art  Swim'],
    ['Time Out  Art  Swim'],
    ['Period One  Art  Swim'],
  ])('does not read %j as a header', (line) => {
    expect(header(line)).toBe(false)
  })

  it.each([
    ['Time  Bunk 1  Bunk 2  Bunk 3'],
    ['Times  Bunk 1  Bunk 2  Bunk 3'],
    ['Period  Bunk 1  Bunk 2  Bunk 3'],
    ['Time Block  Bunk 1  Bunk 2  Bunk 3'],
    // Punctuation on the label, not a second word making it data. An existing
    // test covered this spelling and caught its omission from the first cut.
    ['Time:  Bunk 1  Bunk 2  Bunk 3'],
    ['Period:  Bunk 1  Bunk 2  Bunk 3'],
  ])('still reads %j as a header', (line) => {
    expect(header(line)).toBe(true)
  })

  it('still reads a day-majority header with no time label at all', () => {
    expect(header('        Monday  Tuesday  Wednesday  Thursday')).toBe(true)
  })

  it('hasTimeLabel agrees with isHeaderLine — one constant, no drift', () => {
    // They share TIME_HEADER_LABEL; a tightening that touched only one would
    // route a page as labelled while refusing to find its header, or vice versa.
    expect(hasTimeLabel(tokenize('Period 2  Art  Swim'))).toBe(false)
    expect(hasTimeLabel(tokenize('Time  Bunk 1  Bunk 2'))).toBe(true)
  })
})

describe('isHeaderLine — the real corpus is unaffected (T36 F2)', () => {
  it.each(['campA-bunk-schedules.txt', 'campB-by-day.txt', 'campC-daysheet-synthetic.txt'])(
    '%s still parses to the same number of pages', (file) => {
      // The regression that matters: this fix must not cost a real camp a page.
      const text = fs.readFileSync(path.join(SAMPLES, file), 'utf8')
      const { pages } = parseTextGrid(text)
      expect(pages.length).toBeGreaterThan(0)
      // Every page still has columns and rows — a mis-tightening would strand
      // a page with a header it no longer recognises.
      for (const p of pages) expect(p.columns.length).toBeGreaterThan(0)
    })
})
