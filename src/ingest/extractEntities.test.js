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
    expect(entities.groups.length).toBe(33)
    for (const g of entities.groups) expect(g).not.toMatch(/Schedule$/)
  })

  it('reads the unit out of the bunk name, and files the bunk under it', () => {
    // "Adom 4's - Matzo Balls" names both. An earlier version of this file
    // asserted the opposite — that a bunk schedule never says which division a
    // bunk is in — which left a 33-bunk camp with 13 units to type by hand.
    expect(entities.tiers).toContain("Adom 4's")
    expect(entities.tiers).toContain('Maccabiah')
    expect(entities.tiers.length).toBe(13)
  })

  it('gives a bunk its short name once the unit is a field of its own', () => {
    expect(entities.groups).toContain('Matzo Balls')
    expect(entities.groups).not.toContain("Adom 4's - Matzo Balls")
  })

  it('keeps the full title when two units share a bunk name', () => {
    // Rimon and Zayit both have a "Traditional", and groups are
    // UNIQUE(camp_id, name), so the short name cannot be used for either.
    expect(entities.groups).toContain('Rimon - Traditional')
    expect(entities.groups).toContain('Zayit - Traditional')
    expect(entities.groups).not.toContain('Traditional')
  })

  it('leaves a bunk with no unit unfiled rather than inventing one', () => {
    // "Zahav" and "Gesher" have no separator. That is a real shape, not a
    // parse failure.
    const { groupUnits } = extractEntities(campA)
    expect(entities.groups).toContain('Zahav')
    expect(groupUnits.Zahav).toBeUndefined()
    expect(groupUnits['Matzo Balls']).toBe("Adom 4's")
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
  it('proposes no programs, because neither layout records a session', () => {
    // Units ARE recorded, in the bunk names — see the Camp A tests above. A
    // program is not: nothing in a weekly grid says which session it belongs
    // to, and an empty list the director fills in is honest where a guess is
    // silently wrong.
    for (const parsed of [campA, campB]) {
      expect(extractEntities(parsed).entities.cohorts).toEqual([])
    }
  })

  it('proposes no units for a layout that does not carry them', () => {
    // Camp B's columns are bare group names with no unit prefix.
    expect(extractEntities(campB).entities.tiers).toEqual([])
    expect(extractEntities(campB).groupUnits).toEqual({})
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

// The tests above assert that specific known-good values appear. That is not
// the same as the LIST being good, and the difference mattered: an early
// version passed every one of them while proposing 114 activities for Camp A,
// of which 29 were page titles ("Adom 5's - Blintzes Schedule") and 14 held a
// time. A director would have had to reject most of the list.
//
// These look at the whole proposal instead.
describe('the proposal as a whole is worth showing a director', () => {
  for (const [name, parsed] of [['Camp A', campA], ['Camp B', campB]]) {
    describe(name, () => {
      const { entities } = extractEntities(parsed)

      it('proposes no page title as an activity', () => {
        // Each page's title is the bunk's name; it must end the page above it,
        // or it is read as one more row of that page.
        const leaked = entities.activities.filter((a) => /Schedule$/i.test(a))
        expect(leaked, `leaked: ${leaked.slice(0, 3).join(', ')}`).toEqual([])
      })

      it('proposes no activity containing a clock time', () => {
        const timed = entities.activities.filter((a) => /\d{1,2}[:.]\d{2}/.test(a))
        expect(timed, `timed: ${timed.slice(0, 3).join(', ')}`).toEqual([])
      })

      it('proposes no activity that is a word repeated', () => {
        // "Field Field Field Field" — a cell accumulating down a column.
        const repeated = entities.activities.filter((a) => /\b(\w+)\b(?:\s+\1\b)+/i.test(a))
        expect(repeated, `repeated: ${repeated.slice(0, 3).join(', ')}`).toEqual([])
      })

      it('proposes no activity starting with leftover punctuation', () => {
        // Stripping a time leaves its dash: "- Instructional Swim" was a
        // separate, frequent activity from the real one.
        const ragged = entities.activities.filter((a) => /^[\s\-–—:]/.test(a))
        expect(ragged, `ragged: ${ragged.slice(0, 3).join(', ')}`).toEqual([])
      })

      it('proposes a believable number of periods for one camp day', () => {
        // Camp A's two-line time cell once produced 53 "periods". A camp day
        // has somewhere between a handful and about twenty.
        expect(entities.time_blocks.length).toBeGreaterThan(3)
        expect(entities.time_blocks.length).toBeLessThan(25)
      })

      it('gives every period a start and an end where the source had one', () => {
        const ranged = entities.time_blocks.filter((b) => /^\d{1,2}[:.]\d{2}-\d{1,2}[:.]\d{2}$/.test(b))
        expect(ranged.length / entities.time_blocks.length).toBeGreaterThan(0.6)
      })

      it('keeps the days in week order, not in whatever order they were counted', () => {
        const order = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
        const indexes = entities.days_of_operation.map((d) => order.indexOf(d))
        expect(indexes).toEqual([...indexes].sort((a, b) => a - b))
      })
    })
  }

  it('ranks activities by how often they were seen, so artifacts sink', () => {
    // The signal that separates a real activity from a misread: a real one
    // recurs across a 33-page document, an artifact appears once.
    const { entities, seenCounts } = extractEntities(campA)
    const counts = entities.activities.map((a) => seenCounts.activities[a])
    expect(counts).toEqual([...counts].sort((a, b) => b - a))
    expect(counts[0]).toBeGreaterThan(20)
    expect(counts[counts.length - 1]).toBe(1)
  })
})
