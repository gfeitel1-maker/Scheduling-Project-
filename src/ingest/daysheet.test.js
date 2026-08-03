import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { parseTextGrid, findHeaderLine, isHeaderLine, hasTimeLabel, leadingTimeExtent, tokenize } from './textGrid'
import { extractEntities, inferUnitFromCode } from './extractEntities'

// docs/adr/2026-08-01-ingesting-a-prior-year-schedule.md §7 addendum (2026-08-02).
// docs/work/specs/2026-08-02-ingest-robust-grid-detection.md.
//
// A third layout family: one page per group with days across the top (like Camp
// A), but the time column is UNLABELED, an activity's room is printed on the
// line below it, the group titles are separator-less positional codes, and a
// camp banner repeats above every page. The fixture is a FABRICATED structural
// clone — no real camp names — so the rules are exercised without committing a
// real extraction (spec §4.7).

const SAMPLES = path.join(process.cwd(), 'docs/work/specs/samples')
const campC = fs.readFileSync(path.join(SAMPLES, 'campC-daysheet-synthetic.txt'), 'utf8')

describe('header detection without a "Time" label', () => {
  it('finds a days-only header row (no "Time" token)', () => {
    const header = tokenize('                  Monday                 Tuesday                Wednesday                Thursday               Friday')
    expect(hasTimeLabel(header)).toBe(false)
    expect(isHeaderLine(header)).toBe(true)
  })

  it('still requires a real header — prose and short lines are not headers', () => {
    expect(findHeaderLine(['nothing', 'here'])).toBe(-1)
    expect(isHeaderLine(tokenize('Monday only'))).toBe(false) // one day name, not a header
  })

  it('reads the unlabeled time column extent from where the body times sit', () => {
    const lines = ['   Monday   Tuesday   Wednesday', '09:05 AM', '   A   B   C']
    // first day token starts at 3; the time "09:05 AM" ends at 8, but is capped
    // below the first data column, so a lone body time this wide is ignored here.
    expect(leadingTimeExtent(lines, 0, lines.length, 3)).toBe(0)
    const wide = ['                  Monday                 Tuesday', '09:05 AM', '             X               Y']
    expect(leadingTimeExtent(wide, 0, wide.length, 18)).toBe(8)
  })
})

describe('parseTextGrid on the unlabeled days-sheet family', () => {
  const { pages } = parseTextGrid(campC)

  it('finds a page per group code and marks them unlabeled', () => {
    expect(pages.map((p) => p.title)).toEqual(['PA', 'P1 (X)', '2A'])
    expect(pages.every((p) => p.timeColumnLabeled === false)).toBe(true)
  })

  it('does not swallow the unlabeled time column into the first day', () => {
    expect(pages[0].columns).toEqual(['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'])
    // Monday's activity lands in cells[0]; the time is the row label, not a cell.
    const row = pages[0].rows.find((r) => r.cells[0] === 'Archery')
    expect(row).toBeTruthy()
    expect(row.cells).toEqual(['Archery', 'Pottery', 'Sailing', 'Archery', 'Theme Day'])
    expect(row.label).toBe('09:30-10:10')
    // no time leaked into any data cell
    const cells = pages.flatMap((p) => p.rows.flatMap((r) => r.cells))
    expect(cells.some((c) => /\d{1,2}:\d{2}/.test(c))).toBe(false)
  })

  it('drops the repeating page banner instead of reading it as an activity', () => {
    const cells = pages.flatMap((p) => p.rows.flatMap((r) => r.cells))
    expect(cells.some((c) => c.includes('Placeholder Camp 2099'))).toBe(false)
  })
})

describe('location sub-lines are stripped, real events are kept', () => {
  const { entities } = extractEntities(parseTextGrid(campC))

  it('strips location lines — room words and bare numbers — from activities', () => {
    for (const loc of ['Barn', 'Loft', 'Lake', 'Meadow', '301', '302', '303']) {
      expect(entities.activities, loc).not.toContain(loc)
    }
    // and no bare number survived anywhere
    expect(entities.activities.some((a) => /^\d+$/.test(a))).toBe(false)
  })

  it('keeps a fixed event that shares a block with the period above it', () => {
    // "Closing Circle" follows its own time line inside a block whose earlier
    // lines are an activity + its dropped location. A time line resets the
    // adjacency, so the fixed event is kept — the naive "drop everything after
    // the first row" rule would have silently dropped it.
    expect(entities.activities).toContain('Closing Circle')
    expect(entities.activities).toContain('Pick Up')
    expect(entities.activities).toContain('Sign In')
  })
})

describe('positional codes yield units and group->unit links', () => {
  const result = extractEntities(parseTextGrid(campC))

  it('infers the unit from a separator-less code prefix', () => {
    expect(inferUnitFromCode('PA')).toBe('P')
    expect(inferUnitFromCode('P1 (X)')).toBe('P')
    expect(inferUnitFromCode('2A')).toBe('2')
    // a bunk name that is not a code stays whole with no unit
    expect(inferUnitFromCode('Zahav')).toBeNull()
    expect(inferUnitFromCode('Gesher')).toBeNull()
  })

  it('over-includes units and files every group under the right one', () => {
    expect(result.entities.tiers).toEqual(['P', '2'])
    expect(result.entities.groups).toEqual(['PA', 'P1 (X)', '2A'])
    expect(result.groupUnits).toEqual({ PA: 'P', 'P1 (X)': 'P', '2A': '2' })
  })

  it('reads the week as Monday..Friday', () => {
    expect(result.entities.days_of_operation).toEqual(['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'])
  })
})

describe('resilience — malformed unlabeled input fails cleanly', () => {
  it('a day-name header with no time-range body yields an empty proposal, never throws', () => {
    const malformed = '                  Monday                 Tuesday                Wednesday                Thursday               Friday\n'
    expect(() => parseTextGrid(malformed)).not.toThrow()
    let result
    expect(() => { result = extractEntities(parseTextGrid(malformed)) }).not.toThrow()
    expect(result.entities.activities).toEqual([])
    expect(result.entities.time_blocks).toEqual([])
  })
})
