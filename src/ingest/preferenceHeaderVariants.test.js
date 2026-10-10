// Audit E2 (2026-10-10) — the column roles a preference sheet's headers name are
// read case-, space- and punctuation-insensitively, so the director only confirms.
import { describe, it, expect } from 'vitest'
import { inferPreferenceMapping } from './preferenceSheet.js'

const roles = (header) => {
  const m = inferPreferenceMapping(header)
  return {
    name: m.nameIndex,
    id: m.externalIdIndex,
    division: m.divisionIndex,
    ranks: m.rankColumns.map((r) => [r.rank, r.index]),
    unmapped: m.unmapped,
  }
}

describe('inferPreferenceMapping — header variants (audit E2)', () => {
  it("maps the fixture's exact headers with nothing left for the director to set", () => {
    const header = ['Camper ID', 'Camper Name', 'Division', '#1', '#2', '#3', '#4', '#5', '#6', '#7', '#8', '#9', '#10']
    const r = roles(header)
    expect(r).toMatchObject({ name: 1, id: 0, division: 2, unmapped: [] })
    expect(r.ranks).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => [n, n + 2]))
  })

  it.each([
    [['Name', 'Rank 1', 'Rank 2'], 'Rank N'],
    [['Name', 'rank_1', 'rank_2'], 'rank_N'],
    [['Name', 'Choice 1', 'Choice 2'], 'Choice N'],
    [['Name', 'choice-1', 'choice-2'], 'choice-N'],
    [['Name', '1st choice', '2nd choice'], 'Nth choice'],
    [['Name', 'First Choice', 'Second Choice'], 'ordinal word'],
    [['Name', '# 1', '#2.'], '# N with stray punctuation'],
    [['Name', 'Preference 1', 'Preference 2'], 'Preference N'],
    [['Name', 'Pref #1', 'Pref #2'], 'Pref #N'],
  ])('reads ranks 1 and 2 from %j (%s)', (header) => {
    expect(roles(header).ranks).toEqual([[1, 1], [2, 2]])
  })

  it.each([
    [['CAMPER_ID', 'camper_name', 'DIVISION', '#1'], { id: 0, name: 1, division: 2 }],
    [['camper-id', 'Camper-Name', 'Bunk', '#1'], { id: 0, name: 1, division: 2 }],
    [['Student ID', 'Full Name', 'Cabin', '#1'], { id: 0, name: 1, division: 2 }],
    [['ID', ' camper  name ', 'Edah', '#1'], { id: 0, name: 1, division: 2 }],
  ])('maps identity roles from %j', (header, want) => {
    expect(roles(header)).toMatchObject({ ...want, unmapped: [] })
  })

  it('still leaves a bare long-format "Rank" column to the long-format reader', () => {
    const m = inferPreferenceMapping(['Camper Name', 'Rank', 'Activity'])
    expect(m.rankColumns).toEqual([])
    expect(m.longFormat).toEqual({ rankValueIndex: 1, activityValueIndex: 2 })
  })
})
