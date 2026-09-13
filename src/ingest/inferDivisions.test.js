import { describe, it, expect } from 'vitest'
import { inferDivisions, inferDivisionEntities, refineDivisionsByCoOccurrence } from './inferDivisions.js'

// T114 — infer age divisions and their membership from group NAMES.
//
// THE PREMISE (owner, 2026-09-13): "What camp is not separating out their kids
// into divisions?" EVERY group is in one. The question is never whether a
// division exists, only which group belongs to which.
//
// An earlier draft required repetition before admitting a division at all, and
// so returned nothing for `CIT`, nothing for `Maccabi`, and nothing for a camp
// with plainly-named bunks — refusing the ordinary case in the name of not
// guessing. These tests pin the corrected model.
const p = (groupName, dayName, blockLabel, activityName) =>
  ({ groupName, dayName, blockLabel, activityName })

describe('inferDivisions — every group lands in a division', () => {
  it('clusters a numbered family under its stem', () => {
    const d = inferDivisions(['Tzofim 1', 'Tzofim 2', 'Tzofim 3'])
    expect(d['Tzofim 1']).toBe('Tzofim')
    expect(d['Tzofim 3']).toBe('Tzofim')
  })

  it('clusters WORD indices too — Kittah Aleph and Kittah Bet are one division', () => {
    // The specific correction: Aleph/Bet are the camp's own counting words, not
    // unrelated names. The rule is structural (shared stem, differing tail), so
    // nothing here needs to know Hebrew.
    const d = inferDivisions(['Kittah Aleph', 'Kittah Bet'])
    expect(d['Kittah Aleph']).toBe('Kittah')
    expect(d['Kittah Bet']).toBe('Kittah')
  })

  it('gives a lone group its OWN division rather than none', () => {
    const d = inferDivisions(['Tzofim 1', 'Tzofim 2', 'CIT'])
    expect(d['CIT']).toBe('CIT')
  })

  it('gives a single-group division its FULL name, not a fragment of it', () => {
    // "Maccabi Gold" alone must not create a division called "Maccabi" — that
    // names a division after half a bunk's name.
    const d = inferDivisions(['Maccabi Gold'])
    expect(d['Maccabi Gold']).toBe('Maccabi Gold')
  })

  it('assigns EVERY group — nothing is left undecided', () => {
    const names = ['Tzofim 1', 'Tzofim 2', 'Kittah Aleph', 'Kittah Bet', 'CIT', 'Maccabi']
    const d = inferDivisions(names)
    for (const n of names) expect(d[n]).toBeTruthy()
  })

  it('handles hyphens and hashes as separators', () => {
    const d = inferDivisions(['Nitzanim-1', 'Nitzanim-2'])
    expect(d['Nitzanim-1']).toBe('Nitzanim')
    const h = inferDivisions(['Bunk #1', 'Bunk #2'])
    expect(h['Bunk #1']).toBe('Bunk')
  })

  it('matches the stem case-insensitively', () => {
    const d = inferDivisions(['tzofim 1', 'Tzofim  2', 'TZOFIM 3'])
    expect(new Set(Object.values(d)).size).toBe(1)
  })

  it('never throws on junk, and skips empties', () => {
    expect(inferDivisions([])).toEqual({})
    expect(inferDivisions(null)).toEqual({})
    expect(inferDivisions([null, '', '   '])).toEqual({})
  })

  it('is deterministic regardless of input order', () => {
    const a = inferDivisions(['Tzofim 2', 'Tzofim 1'])
    const b = inferDivisions(['Tzofim 1', 'Tzofim 2'])
    expect(a).toEqual(b)
  })

  it('a real camp shape: several divisions of differing sizes, every bunk placed', () => {
    const d = inferDivisions([
      'Tzofim 1', 'Tzofim 2', 'Tzofim 3',
      'Kittah Aleph', 'Kittah Bet',
      'CIT',
    ])
    expect(new Set(Object.values(d))).toEqual(new Set(['Tzofim', 'Kittah', 'CIT']))
  })
})

// The behavioural test the owner named: groups in one division share
// activities; groups in different divisions do not.
describe('refineDivisionsByCoOccurrence — the grid can contradict the names', () => {
  it('splits a name-derived division whose halves never share a slot', () => {
    // Kittah Aleph 1/2 share lunch with each other, Kittah Bet 1/2 share lunch
    // with each other, and the two halves never meet. Names said one division;
    // the grid says two.
    const names = ['Kittah Aleph 1', 'Kittah Aleph 2', 'Kittah Bet 1', 'Kittah Bet 2']
    const named = inferDivisions(names)
    expect(new Set(Object.values(named)).size).toBe(2) // "Kittah Aleph" / "Kittah Bet"

    const placements = [
      p('Kittah Aleph 1', 'Mon', '12:00', 'Lunch'),
      p('Kittah Aleph 2', 'Mon', '12:00', 'Lunch'),
      p('Kittah Bet 1', 'Mon', '13:00', 'Lunch'),
      p('Kittah Bet 2', 'Mon', '13:00', 'Lunch'),
    ]
    const refined = refineDivisionsByCoOccurrence({
      'Kittah Aleph 1': 'Kittah', 'Kittah Aleph 2': 'Kittah',
      'Kittah Bet 1': 'Kittah', 'Kittah Bet 2': 'Kittah',
    }, placements)
    expect(refined['Kittah Aleph 1']).toBe(refined['Kittah Aleph 2'])
    expect(refined['Kittah Bet 1']).toBe(refined['Kittah Bet 2'])
    expect(refined['Kittah Aleph 1']).not.toBe(refined['Kittah Bet 1'])
  })

  it('leaves a division alone when its groups DO share activities', () => {
    const placements = [
      p('Tzofim 1', 'Mon', '12:00', 'Lunch'),
      p('Tzofim 2', 'Mon', '12:00', 'Lunch'),
    ]
    const refined = refineDivisionsByCoOccurrence(
      { 'Tzofim 1': 'Tzofim', 'Tzofim 2': 'Tzofim' }, placements)
    expect(refined['Tzofim 1']).toBe('Tzofim')
    expect(refined['Tzofim 2']).toBe('Tzofim')
  })

  it('never MERGES two divisions the names kept apart', () => {
    // An all-camp lunch makes every group co-occur. Merging on that would fold
    // the whole camp into one division — the opposite failure.
    const placements = [
      p('Tzofim 1', 'Mon', '12:00', 'All-Camp Lunch'),
      p('Bogrim 1', 'Mon', '12:00', 'All-Camp Lunch'),
    ]
    const refined = refineDivisionsByCoOccurrence(
      { 'Tzofim 1': 'Tzofim', 'Bogrim 1': 'Bogrim' }, placements)
    expect(refined['Tzofim 1']).toBe('Tzofim')
    expect(refined['Bogrim 1']).toBe('Bogrim')
  })

  it('is a no-op without placements — names stand when the grid says nothing', () => {
    const named = { 'Tzofim 1': 'Tzofim', 'Tzofim 2': 'Tzofim' }
    expect(refineDivisionsByCoOccurrence(named, [])).toEqual(named)
    expect(refineDivisionsByCoOccurrence(named, null)).toEqual(named)
  })
})

describe('inferDivisionEntities — what the import proposes as age divisions', () => {
  it('proposes every division with its groups, including single-group ones', () => {
    const tiers = inferDivisionEntities(['Tzofim 1', 'Tzofim 2', 'CIT'])
    expect(tiers).toEqual([
      { name: 'CIT', groupNames: ['CIT'] },
      { name: 'Tzofim', groupNames: ['Tzofim 1', 'Tzofim 2'] },
    ])
  })

  it('applies the grid refinement when placements are supplied', () => {
    const names = ['Kittah Aleph 1', 'Kittah Aleph 2', 'Kittah Bet 1']
    const placements = [
      p('Kittah Aleph 1', 'Mon', '12:00', 'Lunch'),
      p('Kittah Aleph 2', 'Mon', '12:00', 'Lunch'),
      p('Kittah Bet 1', 'Mon', '13:00', 'Lunch'),
    ]
    const tiers = inferDivisionEntities(names, placements)
    const aleph = tiers.find((t) => t.groupNames.includes('Kittah Aleph 1'))
    expect(aleph.groupNames).not.toContain('Kittah Bet 1')
  })

  it("never carries an age — a division is the camp's own word for it", () => {
    const tiers = inferDivisionEntities(['Tzofim 1', 'Tzofim 2'])
    expect(Object.keys(tiers[0])).toEqual(['name', 'groupNames'])
  })

  it('is ordered stably — the same camp read twice proposes the same list', () => {
    const a = inferDivisionEntities(['Bogrim 2', 'Tzofim 1', 'Bogrim 1', 'Tzofim 2'])
    const b = inferDivisionEntities(['Tzofim 2', 'Bogrim 1', 'Tzofim 1', 'Bogrim 2'])
    expect(a).toEqual(b)
  })
})

// Owner, 2026-09-13: "anchor activities (all groups, everyday, same time)
// should never be a factor for determining whether another activity set can be
// a co-location or co-scheduled activity."
//
// Not a refinement — load-bearing. With anchors left in, an all-camp lunch puts
// every group in one slot, so NOTHING would ever split and every group would
// appear to share a division with every other.
describe('anchors are excluded from the co-occurrence signal', () => {
  const NAMES = ['Kittah Aleph 1', 'Kittah Aleph 2', 'Kittah Bet 1', 'Kittah Bet 2']
  const named = {
    'Kittah Aleph 1': 'Kittah', 'Kittah Aleph 2': 'Kittah',
    'Kittah Bet 1': 'Kittah', 'Kittah Bet 2': 'Kittah',
  }
  // An all-camp lunch every group attends together, PLUS real division-only
  // activities that actually distinguish them.
  const placements = [
    ...NAMES.map((g) => p(g, 'Mon', '12:00', 'Lunch')),
    p('Kittah Aleph 1', 'Mon', '9:00', 'Sports'),
    p('Kittah Aleph 2', 'Mon', '9:00', 'Sports'),
    p('Kittah Bet 1', 'Mon', '10:00', 'Sports'),
    p('Kittah Bet 2', 'Mon', '10:00', 'Sports'),
  ]

  it('WITHOUT the exclusion the lunch masks the boundary — nothing splits', () => {
    // Documents the failure mode the exclusion exists to prevent.
    const refined = refineDivisionsByCoOccurrence(named, placements)
    expect(refined['Kittah Aleph 1']).toBe(refined['Kittah Bet 1'])
  })

  it('WITH the anchor excluded the real boundary surfaces', () => {
    const refined = refineDivisionsByCoOccurrence(named, placements, ['Lunch'])
    expect(refined['Kittah Aleph 1']).toBe(refined['Kittah Aleph 2'])
    expect(refined['Kittah Bet 1']).toBe(refined['Kittah Bet 2'])
    expect(refined['Kittah Aleph 1']).not.toBe(refined['Kittah Bet 1'])
  })

  it('matches anchor names case- and whitespace-insensitively', () => {
    const refined = refineDivisionsByCoOccurrence(named, placements, ['  lUnCh '])
    expect(refined['Kittah Aleph 1']).not.toBe(refined['Kittah Bet 1'])
  })

  it('inferDivisionEntities threads the exclusion through', () => {
    const tiers = inferDivisionEntities(NAMES, placements, ['Lunch'])
    expect(tiers).toHaveLength(2)
  })
})
