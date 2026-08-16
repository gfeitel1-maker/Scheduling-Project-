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

// M4/Q8 (docs/adr/2026-08-15-locations-import-export-roundtrip.md §D5): the
// dropped location line is now CAPTURED, not discarded — this is the real
// unlabeled-family fixture Red Hat's list asks to confirm against (strip ->
// capture, correctly paired to the activity/column it sits under).
describe('Q8 — the stripped location line is captured, not discarded', () => {
  const { pages } = parseTextGrid(campC)
  const { entities, activityLocations } = extractEntities({ pages })

  it('pairs each captured location with its activity by column, row by row', () => {
    const row = pages[0].rows.find((r) => r.cells[0] === 'Archery')
    expect(row.locations).toEqual(['Barn', 'Loft', 'Lake', 'Barn', '301'])
  })

  it('captures room text into entities.locations, ranked by how often seen', () => {
    for (const loc of ['Barn', 'Loft', 'Lake', 'Meadow', '301', '302', '303']) {
      expect(entities.locations).toContain(loc)
    }
  })

  it('pairs an activity name to the place it was most often seen at (majority vote)', () => {
    // "Sign In" appears on every page's opening line with no location line
    // beneath it (a fixed banner-style row) — no pairing, never invented.
    expect(activityLocations[normalizeKey('Sign In')]).toBeUndefined()
    // "Archery"/"Barn" and "Pottery"/"Loft" are each other's majority pairing
    // across the whole fixture (verified against the file's own content).
    expect(activityLocations[normalizeKey('Archery')]).toBe('Barn')
    expect(activityLocations[normalizeKey('Pottery')]).toBe('Loft')
  })

  function normalizeKey(name) {
    return name.toLowerCase().replace(/\s+/g, ' ')
  }
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

// FIX 2 — a Camp-A-shaped camp that labels its time column "Times"/"Period"/etc.
// must still take the labelled path, or it silently loses unit inference. The
// gate is a prefix match, not the exact word "Time" (spec §3a, R3).
describe('the time-label gate matches beyond the exact word "Time"', () => {
  for (const label of ['Time', 'TIME', 'Times', 'Time:', 'Time Block', 'Period']) {
    it(`a "${label}"-labelled header takes the labelled path`, () => {
      const header = tokenize(`${label}          Yeladim 1          Yeladim 2          CIT`)
      expect(hasTimeLabel(header)).toBe(true)
      expect(isHeaderLine(header)).toBe(true)
    })
  }

  it('a plain day-only header stays unlabelled (day-name majority, not a time label)', () => {
    const header = tokenize('                  Monday                 Tuesday                Wednesday')
    expect(hasTimeLabel(header)).toBe(false)
    expect(isHeaderLine(header)).toBe(true)
  })
})

// FIX 1 — the location strip is fail-safe. A NARROW trailing line (a wrapped
// activity name continuing one column) is kept; only a full-width value row or
// bare numbers (a room) is dropped. The old adjacency-only strip dropped ANY
// trailing data line and so silently truncated a genuine wrap (spec §3b, R3).
describe('a narrow wrapped activity continuation is kept, not stripped as a location', () => {
  const HDR = '                  Monday                 Tuesday                Wednesday                Thursday               Friday'
  const page = [
    '                                                                 QA',
    HDR,
    '09:30 AM',
    '             Instructional             Pottery                 Sailing                 Archery               Theme Day',
    '             Swim',
    '10:10 AM',
    '',
  ].join('\n')

  it('retains the full wrapped name ("Instructional" over "Swim")', () => {
    const { entities } = extractEntities(parseTextGrid(page))
    expect(entities.activities).toContain('Instructional Swim')
    // the truncated half must not appear on its own (the old bug)
    expect(entities.activities).not.toContain('Instructional')
  })
})

// FIX 3 — a repeating full-width fixed-event row must not be eaten as a banner.
// A banner candidate is a single centred label (one token); a real daily event
// row tokenizes to many columns and is kept. The old detector counted any
// pre-title line and stripped it on every page (spec §3d, R3).
describe('a repeating full-width fixed-event row is not mistaken for a banner', () => {
  const HDR = '                  Monday                 Tuesday                Wednesday                Thursday               Friday'
  const DIS = '             Dismissal               Dismissal               Dismissal               Dismissal             Dismissal'
  const SIGN = '             Sign In                 Sign In                 Sign In                 Sign In               Sign In'
  const dayPage = (t) => [
    '                                                                 ' + t,
    HDR, '09:00 AM', SIGN, '09:20 AM', '', '03:45 PM', DIS, '',
  ].join('\n')
  // Each page ends with a full-width "Dismissal" row sitting directly above the
  // next page's title — exactly where the old banner detector would grab it.
  const doc = [dayPage('QA'), dayPage('QB'), dayPage('QC')].join('\n')

  it('keeps the repeated "Dismissal" event as an activity', () => {
    const { entities } = extractEntities(parseTextGrid(doc))
    expect(entities.activities).toContain('Dismissal')
  })
})
