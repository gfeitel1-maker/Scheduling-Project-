import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { parseTextGrid, tokenize, looksLikeTime, isDayName, findHeaderLine } from './textGrid'

// docs/adr/2026-08-01-ingesting-a-prior-year-schedule.md §7.
//
// Run against the two real camps' schedules, because the hazards here were
// measured from those files and not imagined: the two layouts are transposes of
// each other, cells wrap across lines, and one camp interleaves non-schedule
// rows among the blocks.

const SAMPLES = path.join(process.cwd(), 'docs/work/specs/samples')
const campA = fs.readFileSync(path.join(SAMPLES, 'campA-bunk-schedules.txt'), 'utf8')
const campB = fs.readFileSync(path.join(SAMPLES, 'campB-by-day.txt'), 'utf8')

describe('tokenize', () => {
  it('keeps a two-word label together but splits across a wide gap', () => {
    const tokens = tokenize('   Drama                  Back Playground        Dance')
    expect(tokens.map((t) => t.text)).toEqual(['Drama', 'Back Playground', 'Dance'])
  })

  it('records where each label sits, which is the only column information there is', () => {
    const [first] = tokenize('     Time      Monday')
    expect(first.text).toBe('Time')
    expect(first.start).toBe(5)
    expect(first.end).toBe(9)
  })
})

describe('looksLikeTime', () => {
  it('accepts the forms both camps actually use', () => {
    for (const t of ['08:40–09:00', '9:15-', '11:25–12:05', '12:10-12:50']) {
      expect(looksLikeTime(t), t).toBe(true)
    }
  })

  it('rejects an activity that merely contains digits', () => {
    for (const t of ['Lunch 1', 'CIT Block 1', 'Beavers 2', 'Aqua 4’s']) {
      expect(looksLikeTime(t), t).toBe(false)
    }
  })
})

describe('parseTextGrid on Camp B — one page per day, columns are groups', () => {
  const { pages } = parseTextGrid(campB)

  it('finds a page per day', () => {
    expect(pages.length).toBeGreaterThanOrEqual(5)
    expect(pages[0].title).toMatch(/Monday/)
  })

  it('reads the group names out of the header row', () => {
    expect(pages[0].columns).toContain('Beavers 1')
    expect(pages[0].columns).toContain('CIT')
    // 14 groups in this camp.
    expect(pages[0].columns.length).toBe(14)
  })

  it('does not mistake the group names for days', () => {
    expect(pages[0].columns.some(isDayName)).toBe(false)
  })

  it('reads a full row of placements', () => {
    const carpool = pages[0].rows.find((r) => r.cells.includes('Carpool'))
    expect(carpool).toBeTruthy()
    expect(carpool.label).toMatch(/08:40/)
  })

  it('reassembles a cell that wrapped onto its own line', () => {
    // "Little Playground" is split across two lines in the source, and
    // "Arts and Crafts" across three. Naive line-splitting yields "Little".
    const all = pages.flatMap((p) => p.rows.flatMap((r) => r.cells))
    expect(all).toContain('Little Playground')
    expect(all.some((c) => c === 'Little')).toBe(false)
  })
})

describe('parseTextGrid on Camp A — one page per group, columns are days', () => {
  const { pages } = parseTextGrid(campA)

  it('finds many pages, one per bunk', () => {
    expect(pages.length).toBeGreaterThan(10)
  })

  it('reads the days out of the header row', () => {
    expect(pages[0].columns).toEqual(['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'])
    expect(pages[0].columns.every(isDayName)).toBe(true)
  })

  it('carries the bunk name as the page title', () => {
    expect(pages[0].title).toMatch(/Aqua/)
  })

  it('reads activities into the right day column', () => {
    const row = pages[0].rows.find((r) => r.cells.includes('Drama'))
    expect(row).toBeTruthy()
    // Camp A's first activity row is Drama on Monday.
    expect(row.cells[0]).toBe('Drama')
  })
})

describe('the two layouts are transposes, and the parser must not assume one', () => {
  it('tells them apart by whether the column headers are day names', () => {
    const a = parseTextGrid(campA).pages[0]
    const b = parseTextGrid(campB).pages[0]
    expect(a.columns.every(isDayName)).toBe(true)
    expect(b.columns.every(isDayName)).toBe(false)
  })
})

describe('robustness', () => {
  it('returns no pages rather than throwing on text it cannot read', () => {
    for (const input of ['', null, undefined, 'just some prose with no grid in it']) {
      expect(() => parseTextGrid(input)).not.toThrow()
      expect(parseTextGrid(input).pages).toEqual([])
    }
  })

  it('reports no header when there is none', () => {
    expect(findHeaderLine(['nothing', 'here'])).toBe(-1)
  })
})
