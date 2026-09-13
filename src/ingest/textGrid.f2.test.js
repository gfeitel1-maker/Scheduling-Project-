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
    // Red Hat: all of these passed the OLD prefix match. Refusing them would
    // silently route a labelled camp into the unlabeled family and cost it unit
    // inference — a worse failure than the mid-body split this closes.
    ['Time (approx)  Bunk 1  Bunk 2  Bunk 3'],
    ['Period #  Bunk 1  Bunk 2  Bunk 3'],
    ['Time/Period  Bunk 1  Bunk 2  Bunk 3'],
    ['TIME OF DAY  Bunk 1  Bunk 2  Bunk 3'],
    ['Periods:  Bunk 1  Bunk 2  Bunk 3'],
    ['Time Blocks  Bunk 1  Bunk 2  Bunk 3'],
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

// Red Hat (T36 review): these asserted `pages.length > 0`, under a test name
// claiming "the same number of pages". A regression dropping one page of five,
// or halving every page's columns, would have passed — a weak guard dressed as
// a strong one by its own description. Pinned to the real, measured shape now,
// so any change to the parser that moves a shipped camp's parse fails here.
const GOLDEN = {
  'campA-bunk-schedules.txt': { pages: 33, columnsPerPage: 5, rows: 483 },
  'campB-by-day.txt': { pages: 5, columnsPerPage: 14, rows: 62 },
  'campC-daysheet-synthetic.txt': { pages: 3, columnsPerPage: 5, rows: 23 },
}

describe('the real corpus parses to exactly the shape it did before (T36)', () => {
  it.each(Object.keys(GOLDEN))('%s', (file) => {
    const { pages } = parseTextGrid(fs.readFileSync(path.join(SAMPLES, file), 'utf8'))
    const g = GOLDEN[file]
    expect(pages).toHaveLength(g.pages)
    expect(pages.map((p) => p.columns.length)).toEqual(Array(g.pages).fill(g.columnsPerPage))
    expect(pages.reduce((n, p) => n + p.rows.length, 0)).toBe(g.rows)
  })
})
