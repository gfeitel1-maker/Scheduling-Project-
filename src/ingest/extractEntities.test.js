import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { parseTextGrid } from './textGrid'
import {
  extractEntities, detectOrientation, INGESTIBLE_ENTITIES,
  isElectiveHeaderText, ELECTIVE_HEADER_TERMS,
} from './extractEntities'
import { inferFixedEvents } from './fixedEvents'
import { inferMultiBlockCandidates } from './multiBlockCandidates'

// docs/adr/2026-08-01-ingesting-a-prior-year-schedule.md §2, §7.

const SAMPLES = path.join(process.cwd(), 'docs/work/specs/samples')
const campA = parseTextGrid(fs.readFileSync(path.join(SAMPLES, 'campA-bunk-schedules.txt'), 'utf8'))
const campB = parseTextGrid(fs.readFileSync(path.join(SAMPLES, 'campB-achva-by-day.txt'), 'utf8'))

describe('the entities-only boundary (ADR §2)', () => {
  // M4 (docs/adr/2026-08-15-locations-import-export-roundtrip.md §D2):
  // 'locations' joins as a genuine 7th ingestible entity.
  it('can only ever propose the seven setup entities', () => {
    expect([...INGESTIBLE_ENTITIES].sort()).toEqual(
      ['activities', 'cohorts', 'days_of_operation', 'groups', 'locations', 'tiers', 'time_blocks'].sort()
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

describe('residual — unrecognised cell content (T36)', () => {
  // A cell that survives cleaning but never becomes an activity name (a stray
  // "Block 2", a bare room number left in a data column) is content the
  // director laid out and the parser silently threw away. Surfacing it is the
  // whole of T36's transparency goal — not a parser fix, a report of what the
  // parser already decided not to use.
  it('collects a cell that failed isActivityLike, with its count', () => {
    const parsed = {
      pages: [{
        title: 'Yeladim',
        columns: ['Monday', 'Tuesday'],
        rows: [
          { label: '9:00', cells: ['Block 2', 'Swim'] },
          { label: '10:00', cells: ['Block 2', 'Drama'] },
        ],
      }],
    }
    const { residual } = extractEntities(parsed)
    expect(residual.cells).toEqual([{ value: 'Block 2', count: 2 }])
  })

  it('never reports an empty cell or a bare dash as residual', () => {
    const parsed = {
      pages: [{
        title: 'Yeladim',
        columns: ['Monday', 'Tuesday'],
        rows: [{ label: '9:00', cells: ['', '-'] }],
      }],
    }
    const { residual } = extractEntities(parsed)
    expect(residual.cells).toEqual([])
  })

  it('reports no residual for the two real camps beyond what they already carry', () => {
    // Not an assertion that residual is empty (both camps DO have some
    // unmatched content) — just that the shape holds on real data.
    for (const parsed of [campA, campB]) {
      const { residual } = extractEntities(parsed)
      expect(Array.isArray(residual.cells)).toBe(true)
      for (const entry of residual.cells) {
        expect(typeof entry.value).toBe('string')
        expect(entry.value.length).toBeGreaterThan(0)
        expect(entry.count).toBeGreaterThan(0)
      }
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

  it('populates activityPages with real group names (groups orientation, T35 Fix 2a)', () => {
    // Regression: before Fix 2, the `columns: 'groups'` layout (Camp B, one
    // page per day, groups as columns) left activityPages empty for the
    // WHOLE import, silently marking every activity "all groups" as though
    // it were a confident inference.
    const { activityPages, entities: e } = extractEntities(campB)
    expect(Object.keys(activityPages).length).toBeGreaterThan(0)
    for (const groupNames of Object.values(activityPages)) {
      for (const name of groupNames) expect(e.groups).toContain(name)
    }
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

  it('populates activityPages with real group names (days orientation, T35 Fix 2a)', () => {
    const { activityPages, entities: e } = extractEntities(campA)
    expect(Object.keys(activityPages).length).toBeGreaterThan(0)
    // Every group name activityPages points at must be a group the entity
    // proposal actually spells, not a raw page title.
    for (const groupNames of Object.values(activityPages)) {
      for (const name of groupNames) expect(e.groups).toContain(name)
    }
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

  it('infers a division from a "Word Number" group-column header (W6)', () => {
    // Camp B's real headers are "Yeladim 1", "Tzofim 2", etc. — a division
    // word followed by a bunk number, no hyphen. The division is the leading
    // word-part; the bunk keeps its FULL header as its name (owner decision).
    const { entities, groupUnits } = extractEntities(campB)
    expect(entities.tiers).toEqual(['Yeladim', 'Tzofim', 'Chalutzim', 'Alufim', 'Giborim', 'CIT'])
    expect(groupUnits['Tzofim 2']).toBe('Tzofim')
    expect(groupUnits['Yeladim 1']).toBe('Yeladim')
    expect(groupUnits['CIT']).toBe('CIT')
  })
})

// ADR 2026-08-09 Decision 2 — better unit inference where the file can encode
// it, conservatively (a blank unit, never a wrong one).
describe('unit inference (ADR 2026-08-09 Decision 2)', () => {
  it('groups-are-columns: a "Unit - Bunk" column header now populates the unit', () => {
    const grid = { pages: [{ title: 'Monday', columns: ['Kfar A - Chagalls', 'Kfar B - Picassos'], rows: [
      { label: '09:00-10:00', cells: ['Swim', 'Art'] },
    ] }] }
    const { entities, groupUnits } = extractEntities(grid)
    expect(entities.tiers).toEqual(expect.arrayContaining(['Kfar A', 'Kfar B']))
    expect(groupUnits['Chagalls']).toBe('Kfar A')
    expect(groupUnits['Picassos']).toBe('Kfar B')
  })

  it('groups-are-columns: a lone-token header with no separator and no trailing number becomes its own division (W6)', () => {
    // "CIT" has no hyphen and no trailing bunk number, so it falls to the
    // lone-token fallback: division "CIT", bunk "CIT" — never "C" (that was
    // the false positive the old guard existed to prevent; the guard's real
    // intent — never mint "C" from "CIT" — still holds under the new rule).
    const grid = { pages: [{ title: 'Monday', columns: ['Zahav', 'Gesher', 'CIT'], rows: [
      { label: '09:00-10:00', cells: ['Swim', 'Art', 'Music'] },
    ] }] }
    const { entities, groupUnits } = extractEntities(grid)
    expect(entities.tiers).toEqual(['Zahav', 'Gesher', 'CIT'])
    expect(groupUnits['Zahav']).toBe('Zahav')
    expect(groupUnits['Gesher']).toBe('Gesher')
    expect(groupUnits['CIT']).toBe('CIT')
  })

  it('groups-are-columns: a "Word Number" header keeps the full header as the bunk name', () => {
    const grid = { pages: [{ title: 'Monday', columns: ['Yeladim 1'], rows: [
      { label: '09:00-10:00', cells: ['Swim'] },
    ] }] }
    const { entities, groupUnits } = extractEntities(grid)
    expect(entities.tiers).toEqual(['Yeladim'])
    expect(groupUnits['Yeladim 1']).toBe('Yeladim')
  })

  it('groups-are-columns: a hyphenated header still splits via the hyphen rule first, even when it also looks like "Word Number"', () => {
    const grid = { pages: [{ title: 'Monday', columns: ['Kfar A - Chagalls 1'], rows: [
      { label: '09:00-10:00', cells: ['Swim'] },
    ] }] }
    const { entities, groupUnits } = extractEntities(grid)
    expect(entities.tiers).toEqual(['Kfar A'])
    expect(groupUnits['Chagalls 1']).toBe('Kfar A')
  })

  it('groups-are-columns: metadata columns (Notes, Lunch) are skipped entirely, not treated as divisions or groups', () => {
    const grid = { pages: [{ title: 'Monday', columns: ['Yeladim 1', 'Notes', 'Tzofim 2', 'Lunch', 'CIT'], rows: [
      { label: '09:00-10:00', cells: ['Swim', 'n/a', 'Art', 'n/a', 'Archery'] },
    ] }] }
    const { entities, groupUnits } = extractEntities(grid)
    expect(entities.tiers).toEqual(['Yeladim', 'Tzofim', 'CIT'])
    expect(entities.groups).toEqual(['Yeladim 1', 'Tzofim 2', 'CIT'])
    expect(groupUnits['Notes']).toBeUndefined()
    expect(groupUnits['Lunch']).toBeUndefined()
  })

  it('groups-are-columns: metadata match is case-insensitive on the trimmed header', () => {
    const grid = { pages: [{ title: 'Monday', columns: [' NOTES ', 'CIT'], rows: [
      { label: '09:00-10:00', cells: ['n/a', 'Archery'] },
    ] }] }
    const { entities } = extractEntities(grid)
    expect(entities.groups).toEqual(['CIT'])
  })

  it('groups-are-columns: an accented division word is captured ("Café 1" -> division "Café")', () => {
    const grid = { pages: [{ title: 'Monday', columns: ['Café 1', 'Zoï 2'], rows: [
      { label: '09:00-10:00', cells: ['Swim', 'Art'] },
    ] }] }
    const { entities, groupUnits } = extractEntities(grid)
    expect(entities.tiers).toEqual(['Café', 'Zoï'])
    expect(groupUnits['Café 1']).toBe('Café')
    expect(groupUnits['Zoï 2']).toBe('Zoï')
  })

  it('groups-are-pages (positional-code path) is unaffected by the W6 group-column rule', () => {
    const grid = { pages: [{
      title: 'Tzofim 1', columns: ['Monday', 'Tuesday'], timeColumnLabeled: false,
      rows: [{ label: '09:00-10:00', cells: ['Swim', 'Art'] }],
    }] }
    const { entities, groupUnits } = extractEntities(grid)
    // days-orientation path: splitUnitAndGroup then inferUnitFromCode fallback.
    // "Tzofim 1" has no hyphen and inferUnitFromCode's regex requires a single
    // leading letter/digit-run token, which "Tzofim" (a whole word) is not.
    expect(entities.tiers).toEqual([])
    expect(groupUnits['Tzofim 1']).toBeUndefined()
  })

  it('groups-are-pages, labeled: a title matching neither shape now falls back to inferUnitFromCode', () => {
    // "2A" has no "Unit - Bunk" separator, so splitUnitAndGroup alone (the
    // pre-ADR behaviour) misses it — but it IS a positional code
    // inferUnitFromCode already recognizes on unlabeled pages. The ADR adds
    // it as a fallback on labeled pages too, without overriding either
    // heuristic's own find.
    const grid = { pages: [{
      title: '2A', columns: ['Monday', 'Tuesday'], timeColumnLabeled: true,
      rows: [{ label: '09:00-10:00', cells: ['Swim', 'Art'] }],
    }] }
    const { entities, groupUnits } = extractEntities(grid)
    expect(entities.tiers).toEqual(['2'])
    expect(groupUnits['2A']).toBe('2')
  })
})

describe('what it refuses to guess, continued', () => {
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

describe('rarity is judged within a unit, not across the camp', () => {
  // Product owner, 2026-08-01: "count frequency within the unit". A camp with
  // many programmes has activities that are rare overall and completely normal
  // where they happen — only the Omanut bunks do Ceramics. Judged against the
  // whole camp those look like misreads.
  function campWith(pages) {
    return extractEntities({ pages })
  }

  it('scores an activity by how much of its own unit does it', () => {
    const { seenCounts } = campWith([
      { title: 'Omanut - Chagalls', columns: ['Monday'], rows: [{ label: '9:00-10:00', cells: ['Ceramics'] }] },
      { title: 'Omanut - Picassos', columns: ['Monday'], rows: [{ label: '9:00-10:00', cells: ['Ceramics'] }] },
      { title: 'Lavan - Chais', columns: ['Monday'], rows: [{ label: '9:00-10:00', cells: ['Swim'] }] },
      { title: 'Lavan - Yads', columns: ['Monday'], rows: [{ label: '9:00-10:00', cells: ['Swim'] }] },
    ])
    // Both Omanut bunks do Ceramics; no Lavan bunk does.
    expect(seenCounts.activityUnitShare.ceramics).toBe(1)
  })

  it('gives a half share to an activity only one bunk of a unit does', () => {
    const { seenCounts } = campWith([
      { title: 'Omanut - Chagalls', columns: ['Monday'], rows: [{ label: '9:00-10:00', cells: ['Ceramics'] }] },
      { title: 'Omanut - Picassos', columns: ['Monday'], rows: [{ label: '9:00-10:00', cells: ['Swim'] }] },
    ])
    expect(seenCounts.activityUnitShare.ceramics).toBe(0.5)
  })

  it('treats a bunk with no unit as its own unit', () => {
    // "Gesher" has no unit prefix, and what Gesher does is still normal for
    // Gesher — "Service Project" should not read as a misread.
    const { seenCounts } = campWith([
      { title: 'Gesher', columns: ['Monday'], rows: [{ label: '9:00-10:00', cells: ['Service Project'] }] },
      { title: 'Lavan - Chais', columns: ['Monday'], rows: [{ label: '9:00-10:00', cells: ['Swim'] }] },
    ])
    expect(seenCounts.activityUnitShare['service project']).toBe(1)
  })
})

describe('days are the calendar\'s words, not the camp\'s', () => {
  it('normalises a shouted day name', () => {
    // A real camp's spreadsheet writes "MONDAY". The app should not shout
    // because a spreadsheet did, and a day is a closed set with one spelling.
    const grid = { pages: [
      { title: 'Bunk A', columns: ['MONDAY', 'TUESDAY'], rows: [{ label: '9:00-10:00', cells: ['Swim', 'Art'] }] },
      { title: 'Bunk B', columns: ['MONDAY', 'TUESDAY'], rows: [{ label: '9:00-10:00', cells: ['Art', 'Swim'] }] },
    ] }
    expect(extractEntities(grid).entities.days_of_operation).toEqual(['Monday', 'Tuesday'])
  })

  it('treats a shouted and a spelled day as the same day', () => {
    const grid = { pages: [
      { title: 'Bunk A', columns: ['MONDAY'], rows: [{ label: '9:00', cells: ['Swim'] }] },
      { title: 'Bunk B', columns: ['Monday'], rows: [{ label: '9:00', cells: ['Art'] }] },
    ] }
    expect(extractEntities(grid).entities.days_of_operation).toEqual(['Monday'])
  })
})

// Slice 3a (docs/adr/2026-08-22-nested-schedules-electives-and-events.md §4
// addendum; docs/work/specs/2026-08-22-electives-nested-schedule-slices.md).
describe('elective header-label detector (Slice 3a)', () => {
  it('flags every controlled term, case-insensitively', () => {
    for (const term of ELECTIVE_HEADER_TERMS) {
      expect(isElectiveHeaderText(term.toUpperCase())).toBe(true)
    }
  })

  it('does not flag a normal activity column header', () => {
    for (const term of ['Swim', 'Drama', 'Free Choice', 'Studio Art', 'Sports']) {
      expect(isElectiveHeaderText(term)).toBe(false)
    }
  })

  it('fires on the real Camp A file, which prints "Indoor Elective"/"Outdoor Elective"/"Chugim" as period content', () => {
    const { electiveHeaderFindings } = extractEntities(campA)
    const excerpts = new Set(electiveHeaderFindings.map((f) => f.sourceExcerpt))
    expect(excerpts.has('Indoor Elective')).toBe(true)
    expect(excerpts.has('Outdoor Elective')).toBe(true)
    expect(excerpts.has('Chugim')).toBe(true)
    for (const f of electiveHeaderFindings) {
      expect(f.detector).toBe('header')
      expect(f.band).toBe('confirmed')
    }
  })

  it('raises no header findings on the real Camp B file, which has no elective period', () => {
    const { electiveHeaderFindings } = extractEntities(campB)
    expect(electiveHeaderFindings).toEqual([])
  })

  it('a group/bunk column titled "Chugim" is flagged and skipped as a group, not proposed as a bunk', () => {
    const grid = {
      pages: [{
        title: 'Monday',
        columns: ['Adom 1', 'Chugim'],
        rows: [{ label: '9:00', cells: ['Swim', 'Ceramics'] }],
      }],
    }
    const { entities, electiveHeaderFindings } = extractEntities(grid)
    expect(entities.groups).toEqual(['Adom 1'])
    expect(electiveHeaderFindings.some((f) => f.column === 'Chugim')).toBe(true)
  })

  it('exempts a token that resolves 1:1 to an existing activity by construction (false-positive guard)', () => {
    // "Free Choice" is a real, plain activity name — never in ELECTIVE_HEADER_TERMS
    // — and must never be misread as an elective nudge just because it names
    // an unstructured-choice period informally.
    expect(isElectiveHeaderText('Free Choice')).toBe(false)
  })

  // fix, panel round 2 (Red Hat + Code Reviewer, HIGH) — a prior `.includes()`
  // substring match fired on any text CONTAINING a term, so "Selective Sports"
  // (contains "elective") and "Elective A: Ceramics" (a specific offering
  // named after the period, not the period's own header) both wrongly nudged.
  it('does not flag text that merely CONTAINS a controlled term as a substring', () => {
    for (const text of ['Selective Sports', 'Elective A: Ceramics', 'Non-Elective Study Hall', 'Selectives']) {
      expect(isElectiveHeaderText(text)).toBe(false)
    }
  })

  it('still flags the exact qualified real-world forms', () => {
    for (const text of ['Chugim', 'Electives', 'Indoor Elective', 'Outdoor Elective', 'chugim', 'INDOOR ELECTIVE']) {
      expect(isElectiveHeaderText(text)).toBe(true)
    }
  })
})

// T118 slice 3 — extraction integration for confirmed compound-cell decisions.
// docs/adr/2026-09-03-compound-cell-interpretation.md,
// docs/work/tickets/T118-compound-cell-interpretation.md "Slice 3".
//
// Real pattern from the ADR's own pressure-testing: a "Lunch + Leave" cell —
// a real activity (Lunch) plus a short bus/transition wrapper (Leave) that a
// camp compressed into one cell.
describe('compound-cell decisions (T118 slice 3)', () => {
  const LUNCH_LEAVE = 'Lunch + Leave'

  function gridWithCell(cellText) {
    return {
      pages: [{
        title: 'A',
        columns: ['Monday', 'Tuesday'],
        rows: [{ label: '12:00', cells: [cellText, cellText] }],
      }],
    }
  }

  it('no compoundCellDecisions argument at all — unchanged behavior (regression guard)', () => {
    const parsed = gridWithCell(LUNCH_LEAVE)
    const withoutArg = extractEntities(parsed)
    const withEmptyMap = extractEntities(parsed, new Map())
    expect(withoutArg.entities.activities).toEqual([LUNCH_LEAVE])
    expect(withoutArg.seenCounts.activities).toEqual({ [LUNCH_LEAVE]: 2 })
    // An empty Map (nothing confirmed yet) must be byte-for-byte identical to
    // no argument at all — the common case for a camp's first-ever import.
    // (compoundCellDecisions itself legitimately differs — it just rides the
    // proposal object back out, same as canonicalMap would with a different
    // input map — everything else must match exactly.)
    const { compoundCellDecisions: _a, ...restWithout } = withoutArg
    const { compoundCellDecisions: _b, ...restWithEmpty } = withEmptyMap
    expect(restWithEmpty).toEqual(restWithout)
  })

  it('a confirmed "wrapper" decision folds the wrapper cell onto the anchor alone', () => {
    const parsed = gridWithCell(LUNCH_LEAVE)
    const decisions = new Map([
      [LUNCH_LEAVE, { interpretation: 'wrapper', anchor_name: 'Lunch', wrapper_name: 'Leave' }],
    ])
    const { entities, seenCounts } = extractEntities(parsed, decisions)
    expect(entities.activities).toEqual(['Lunch'])
    expect(entities.activities).not.toContain(LUNCH_LEAVE)
    expect(seenCounts.activities).toEqual({ Lunch: 2 })
    expect(seenCounts.activities[LUNCH_LEAVE]).toBeUndefined()
  })

  it('a confirmed "as_written" decision is identical to having no decision for that pattern', () => {
    const parsed = gridWithCell(LUNCH_LEAVE)
    const decisions = new Map([
      [LUNCH_LEAVE, { interpretation: 'as_written', anchor_name: null, wrapper_name: null }],
    ])
    const withDecision = extractEntities(parsed, decisions)
    const withoutDecision = extractEntities(parsed)
    const { compoundCellDecisions: _a, ...restWith } = withDecision
    const { compoundCellDecisions: _b, ...restWithout } = withoutDecision
    expect(restWith).toEqual(restWithout)
  })

  it('a confirmed "alternatives" decision does not throw and keeps the cell literal, same as as_written for now', () => {
    const parsed = gridWithCell(LUNCH_LEAVE)
    const decisions = new Map([
      [LUNCH_LEAVE, { interpretation: 'alternatives', anchor_name: null, wrapper_name: null }],
    ])
    expect(() => extractEntities(parsed, decisions)).not.toThrow()
    const { entities, seenCounts } = extractEntities(parsed, decisions)
    // Slice 4 decides shared-slot eligibility mechanics; for slice 3 this must
    // read exactly like as_written/no-decision — a deliberate, explicitly
    // asserted placeholder so a future change to this is an intentional edit.
    expect(entities.activities).toEqual([LUNCH_LEAVE])
    expect(seenCounts.activities).toEqual({ [LUNCH_LEAVE]: 2 })
  })

  it('a pattern in the Map that never appears in this file is a no-op', () => {
    const parsed = gridWithCell('Swim')
    const decisions = new Map([
      [LUNCH_LEAVE, { interpretation: 'wrapper', anchor_name: 'Lunch', wrapper_name: 'Leave' }],
    ])
    expect(() => extractEntities(parsed, decisions)).not.toThrow()
    const { entities } = extractEntities(parsed, decisions)
    expect(entities.activities).toEqual(['Swim'])
  })

  // The exact seam Red Hat caught missing in PR #256 (typo-canonicalization):
  // canonicalMap threading missed a third call site. compoundCellDecisions
  // must reach every caller of activityNamesFromCell, not just extractEntities
  // itself — grep-verify the count rather than hardcoding one, since the T118
  // slice 3 code review itself caught a FOURTH caller (capturePlacements.js,
  // covered in capturePlacements.test.js) that this same class of miss had
  // already slipped past once in this diff.
  describe('reaches every activityNamesFromCell caller (see capturePlacements.test.js for the 4th)', () => {
    const decisions = new Map([
      [LUNCH_LEAVE, { interpretation: 'wrapper', anchor_name: 'Lunch', wrapper_name: 'Leave' }],
    ])

    it('inferFixedEvents sees the resolved anchor name, not the wrapper text', () => {
      const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday']
      const parsed = {
        pages: [{
          title: 'A',
          columns: DAYS,
          rows: [{ label: '12:00-12:30', cells: [LUNCH_LEAVE, LUNCH_LEAVE, LUNCH_LEAVE, LUNCH_LEAVE, LUNCH_LEAVE] }],
        }],
      }
      const proposal = extractEntities(parsed, decisions)
      expect(proposal.compoundCellDecisions).toBe(decisions)
      const { fixedEvents } = inferFixedEvents(parsed, proposal)
      const names = fixedEvents.map((e) => e.name)
      expect(names).toContain('Lunch')
      expect(names).not.toContain(LUNCH_LEAVE)
    })

    it('inferMultiBlockCandidates sees the resolved anchor name, not the wrapper text', () => {
      const row = (label, cells, blockSpans) => ({ label, cells, ...(blockSpans && { blockSpans }) })
      const parsed = {
        pages: [{
          title: 'A',
          columns: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'],
          rows: [
            row('16:00', [LUNCH_LEAVE, '', '', '', ''], [2]),
            row('17:00', ['', '', '', '', '']),
          ],
        }],
      }
      const proposal = extractEntities(parsed, decisions)
      const { multiBlockCandidates } = inferMultiBlockCandidates(parsed, proposal)
      const names = multiBlockCandidates.map((c) => c.name)
      expect(names).toContain('Lunch')
      expect(names).not.toContain(LUNCH_LEAVE)
    })
  })
})
