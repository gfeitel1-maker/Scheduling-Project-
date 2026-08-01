import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { parseTextGrid } from './textGrid'
import { extractEntities, detectOrientation, INGESTIBLE_ENTITIES } from './extractEntities'

// docs/adr/2026-08-01-ingesting-a-prior-year-schedule.md §2, §7.

const SAMPLES = path.join(process.cwd(), 'docs/work/specs/samples')
const campA = parseTextGrid(fs.readFileSync(path.join(SAMPLES, 'campA-bunk-schedules.txt'), 'utf8'))
const campB = parseTextGrid(fs.readFileSync(path.join(SAMPLES, 'campB-achva-by-day.txt'), 'utf8'))

describe('the entities-only boundary (ADR §2)', () => {
  it('can only ever propose the six setup entities', () => {
    expect([...INGESTIBLE_ENTITIES].sort()).toEqual(
      ['activities', 'cohorts', 'days_of_operation', 'groups', 'tiers', 'time_blocks'].sort()
    )
  })

  it('proposes no key outside the whitelist, on either real camp', () => {
    // The placements are sitting right there in the parsed grid. This is the
    // test that notices if they ever start coming out.
    for (const parsed of [campA, campB]) {
      const { entities } = extractEntities(parsed)
      for (const key of Object.keys(entities)) expect(INGESTIBLE_ENTITIES).toContain(key)
      expect(entities).not.toHaveProperty('template_slots')
      expect(entities).not.toHaveProperty('anchor_activities')
    }
  })
})

describe('orientation is detected, not assumed (ADR §7)', () => {
  it('reads Camp A as one page per group, days across', () => {
    const o = detectOrientation(campA.pages)
    expect(o).toEqual({ columns: 'days', pages: 'groups', confident: true })
  })

  it('reads Camp B as one page per day, groups across', () => {
    const o = detectOrientation(campB.pages)
    expect(o).toEqual({ columns: 'groups', pages: 'days', confident: true })
  })

  it('admits when it cannot tell, rather than picking', () => {
    const o = detectOrientation([{ title: 'Sheet 1', columns: ['A', 'B'], rows: [] }])
    expect(o.confident).toBe(false)
  })

  it('says nothing confidently about nothing', () => {
    expect(detectOrientation([]).confident).toBe(false)
  })
})

describe('Camp B — one page per day, groups across', () => {
  const { entities } = extractEntities(campB)

  it('finds the groups from the column headers', () => {
    expect(entities.groups).toContain('Yeladim 1')
    expect(entities.groups).toContain('CIT')
    expect(entities.groups.length).toBe(14)
  })

  it('finds the days from the page titles', () => {
    expect(entities.days_of_operation).toEqual(['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'])
  })

  it('finds the activities, including one that wrapped across lines', () => {
    expect(entities.activities).toContain('Slingshots')
    expect(entities.activities).toContain('Little Playground')
    expect(entities.activities).toContain('Arts and Crafts')
  })

  it('does not propose a time as an activity', () => {
    for (const a of entities.activities) expect(a).not.toMatch(/^\d{1,2}[:.]\d{2}/)
  })

  it('finds the periods', () => {
    expect(entities.time_blocks.length).toBeGreaterThan(5)
    expect(entities.time_blocks[0]).toMatch(/08:40/)
  })
})

describe('Camp A — one page per group, days across', () => {
  const { entities } = extractEntities(campA)

  it('finds the bunks from the page titles, with "Schedule" trimmed off', () => {
    expect(entities.groups.length).toBeGreaterThan(10)
    expect(entities.groups.some((g) => /Adom/.test(g))).toBe(true)
    for (const g of entities.groups) expect(g).not.toMatch(/Schedule$/)
  })

  it('finds the five weekdays from the column headers', () => {
    expect(entities.days_of_operation).toEqual(['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'])
  })

  it('finds the activities', () => {
    expect(entities.activities).toContain('Drama')
    expect(entities.activities).toContain('Back Playground')
  })

  it('does not turn the interleaved "Change" rows into activities or blocks', () => {
    // Camp A has "11:10-11:20 Change" rows between its real periods.
    for (const a of entities.activities) expect(a).not.toMatch(/^\d{1,2}[:.]\d{2}/)
    for (const b of entities.time_blocks) expect(b).toMatch(/^\d/)
  })

  it('does not propose "Block 2" as an activity', () => {
    expect(entities.activities.some((a) => /^Block\s*\d*$/i.test(a))).toBe(false)
  })
})

describe('what it refuses to guess', () => {
  it('proposes no units or programs, because neither layout records them', () => {
    // A bunk schedule does not say which division a bunk belongs to. An empty
    // list the director fills in is honest; a guessed hierarchy is not.
    for (const parsed of [campA, campB]) {
      const { entities } = extractEntities(parsed)
      expect(entities.tiers).toEqual([])
      expect(entities.cohorts).toEqual([])
    }
  })

  it('deduplicates case- and whitespace-insensitively, keeping the first spelling', () => {
    const grid = { pages: [{ title: 'Monday', columns: ['Bunk A'], rows: [
      { label: '09:00-10:00', cells: ['Swim'] },
      { label: '10:00-11:00', cells: ['swim'] },
      { label: '11:00-12:00', cells: ['Swim '] },
    ] }] }
    expect(extractEntities(grid).entities.activities).toEqual(['Swim'])
  })

  it('survives an empty or malformed parse without throwing', () => {
    for (const input of [null, undefined, {}, { pages: [] }]) {
      expect(() => extractEntities(input)).not.toThrow()
      expect(extractEntities(input).counts.activities).toBe(0)
    }
  })
})
