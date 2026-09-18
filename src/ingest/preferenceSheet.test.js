// T226 — reading a camper ranked-preference sheet.
//
// Fixtures here are the shape of a real blank form (camper name, division, a
// 1..N ranking, a swim opt-out), fabricated. No real camper data is in this
// repo, and none may be added.
import { describe, it, expect } from 'vitest'
import { inferPreferenceMapping, parsePreferenceSheet, hasContradictoryRanks } from './preferenceSheet.js'

const HEADER = ['Camper Name', 'Division', 'Swim Alternative (Y/N)', '#1', '#2', '#3', 'Additional Comments']
const ROWS = [
  HEADER,
  ['Ari Green', 'Arad', 'N', 'Archery', 'Gaga', 'Sailing', ''],
  ['Noa Katz', 'Bogrim', 'Y', 'Ceramics', 'Archery', 'Gaga', 'allergic to bees'],
]

describe('inferPreferenceMapping', () => {
  it('finds the name, division and rank columns in the Top-25 form shape', () => {
    const m = inferPreferenceMapping(HEADER)
    expect(m.nameIndex).toBe(0)
    expect(m.divisionIndex).toBe(1)
    expect(m.rankColumns).toEqual([{ rank: 1, index: 3 }, { rank: 2, index: 4 }, { rank: 3, index: 5 }])
    expect(m.externalIdIndex).toBeNull()
  })

  it('finds an external id column when the export carries one', () => {
    const m = inferPreferenceMapping(['Camper ID', 'Camper Name', '#1'])
    expect(m.externalIdIndex).toBe(0)
    expect(m.nameIndex).toBe(1)
  })

  // The inference is a proposal, never a decision — the director overrides it.
  it('reports what it could not find instead of guessing', () => {
    const m = inferPreferenceMapping(['Who', 'Thing A', 'Thing B'])
    expect(m.nameIndex).toBeNull()
    expect(m.rankColumns).toEqual([])
    expect(m.unmapped).toContain('name')
    expect(m.unmapped).toContain('ranks')
  })
})

describe('parsePreferenceSheet', () => {
  const mapping = inferPreferenceMapping(HEADER)

  it('reads campers, their distinct choices, and one preference per rank', () => {
    const out = parsePreferenceSheet(ROWS, { campId: 'camp-1', mapping })
    expect(out.campers.map((c) => c.display_name)).toEqual(['Ari Green', 'Noa Katz'])
    expect(out.choices.map((c) => c.label).sort()).toEqual(['Archery', 'Ceramics', 'Gaga', 'Sailing'])
    expect(out.preferences).toHaveLength(6)
    const ari = out.campers[0]
    expect(out.preferences.filter((p) => p.camper_id === ari.id).map((p) => p.rank)).toEqual([1, 2, 3])
  })

  it('gives every camper a derived id, so two devices reading one sheet converge', () => {
    const a = parsePreferenceSheet(ROWS, { campId: 'camp-1', mapping })
    const b = parsePreferenceSheet(ROWS, { campId: 'camp-1', mapping })
    expect(a.campers.map((c) => c.id)).toEqual(b.campers.map((c) => c.id))
  })

  // The owner-approved identity rule: surface the collision, never merge two
  // real children and never mint a third record behind the director's back.
  it('flags two campers with the same name instead of merging them', () => {
    const rows = [HEADER, ROWS[1], ['Ari Green', 'Bogrim', 'N', 'Gaga', 'Archery', 'Sailing', '']]
    const out = parsePreferenceSheet(rows, { campId: 'camp-1', mapping })
    expect(out.sameNameCampers).toEqual([
      { display_name: 'Ari Green', rowNumbers: [2, 3] },
    ])
    // Not merged, not silently split: one id, and a decision handed back.
    expect(new Set(out.campers.map((c) => c.id)).size).toBe(1)
  })

  // Observed against a 100-row fabricated sheet: three rows naming one child
  // collapse onto one camper holding 75 preferences with THREE rank-1 choices.
  // The flag is therefore not advisory — committing this would hand the solver
  // contradictory input it would resolve by silently picking one. Pinned so
  // nobody later reads sameNameCampers as a warning to click past.
  it('a same-name collision produces contradictory ranks, not merely a duplicate', () => {
    const rows = [
      HEADER,
      ['Ari Green', 'Arad', 'N', 'Archery', 'Gaga', 'Sailing', ''],
      ['Ari Green', 'Bogrim', 'N', 'Ceramics', 'Sailing', 'Gaga', ''],
    ]
    const out = parsePreferenceSheet(rows, { campId: 'camp-1', mapping })
    expect(out.sameNameCampers).toHaveLength(1)
    const rankOne = out.preferences.filter((p) => p.rank === 1).map((p) => p.label)
    expect(rankOne).toEqual(['Archery', 'Ceramics']) // one camper, two firsts
    expect(hasContradictoryRanks(out)).toBe(true)
  })

  it('reports no contradiction for a clean sheet', () => {
    expect(hasContradictoryRanks(parsePreferenceSheet(ROWS, { campId: 'camp-1', mapping }))).toBe(false)
  })

  it('does not flag same-name campers who carry distinct external ids', () => {
    const header = ['Camper ID', 'Camper Name', '#1']
    const m = inferPreferenceMapping(header)
    const out = parsePreferenceSheet(
      [header, ['CM-1', 'Ari Green', 'Gaga'], ['CM-2', 'Ari Green', 'Archery']],
      { campId: 'camp-1', mapping: m }
    )
    expect(out.sameNameCampers).toEqual([])
    expect(new Set(out.campers.map((c) => c.id)).size).toBe(2)
  })

  it('skips blank rank cells without shifting the ranks below them', () => {
    const out = parsePreferenceSheet(
      [HEADER, ['Ari Green', 'Arad', 'N', 'Archery', '', 'Sailing', '']],
      { campId: 'camp-1', mapping }
    )
    expect(out.preferences.map((p) => [p.rank, p.label])).toEqual([[1, 'Archery'], [3, 'Sailing']])
  })

  it('folds a spelling variant of one activity onto a single choice', () => {
    const out = parsePreferenceSheet(
      [HEADER, ['Ari Green', 'Arad', 'N', 'Water Ski', 'waterski', 'Gaga', '']],
      { campId: 'camp-1', mapping }
    )
    expect(out.choices).toHaveLength(2)
  })

  it('reports a row it cannot name rather than importing an anonymous camper', () => {
    const out = parsePreferenceSheet([HEADER, ['', 'Arad', 'N', 'Archery', '', '', '']], { campId: 'camp-1', mapping })
    expect(out.campers).toHaveLength(0)
    expect(out.skippedRows).toEqual([{ rowNumber: 2, reason: 'no camper name' }])
  })
})
