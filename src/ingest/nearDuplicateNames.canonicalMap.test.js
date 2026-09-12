import { describe, it, expect } from 'vitest'
import { extractEntities } from './extractEntities'
import { inferMultiBlockCandidates } from './multiBlockCandidates'
import { findNameVariantCandidates } from './nearDuplicateNames'

// T144 — the SEAM test. The detector's own precision is covered in
// nearDuplicateNames.test.js; what matters here is that one confirmed merge,
// folded into canonicalMap, heals every consumer at once — the catalogue AND
// the inferences that read names through that map — without any of them
// knowing the feature exists.
//
// Modelled on the real defect: Alufim 2's Wednesday cell reads "Swim
// Returning" where all other groups read "Swim Return", which silently drops
// that group out of the Swim companion pair (T143).
const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday']
const row = (label, cells) => ({ label, cells })

// Four groups swim on Wednesday. Three write the tail correctly; the fourth
// has the typo.
const page = (title, tail) => ({
  title,
  columns: DAYS,
  rows: [
    row('09:00-09:40', DAYS.map(() => 'Sports')),
    row('12:00-12:40', DAYS.map((d) => (d === 'Wednesday' ? 'Swim' : ''))),
    row('13:00-13:40', DAYS.map((d) => (d === 'Wednesday' ? tail : ''))),
  ],
})
const parsed = {
  pages: [
    page('A', 'Swim Return'),
    page('B', 'Swim Return'),
    page('C', 'Swim Return'),
    page('D', 'Swim Returning'),
  ],
}

const swimPair = (proposal) =>
  inferMultiBlockCandidates(parsed, proposal).multiBlockCandidates.find((c) => c.name === 'Swim')

describe('confirmed word-form merge heals every canonicalMap consumer (T144)', () => {
  const before = extractEntities(parsed)

  it('leaves the variant as its own phantom activity when nothing is confirmed', () => {
    expect(before.entities.activities).toContain('Swim Return')
    expect(before.entities.activities).toContain('Swim Returning')
  })

  it('drops the typo group out of the companion pair when nothing is confirmed', () => {
    expect(swimPair(before).scope.groups).toEqual(['A', 'B', 'C'])
  })

  it('offers exactly the merge a director would want', () => {
    const candidates = findNameVariantCandidates(
      Object.entries(before.seenCounts?.activities ?? {}).map(([name, count]) => ({ name, count }))
    )
    expect(candidates).toEqual([
      { canonical: 'Swim Return', variant: 'Swim Returning', canonicalCount: 3, variantCount: 1 },
    ])
  })

  describe('once the director confirms it', () => {
    const after = extractEntities(parsed, undefined, [['Swim Returning', 'Swim Return']])

    it('removes the phantom activity from the catalogue', () => {
      expect(after.entities.activities).toContain('Swim Return')
      expect(after.entities.activities).not.toContain('Swim Returning')
    })

    it('restores the typo group to the companion pair — the evidence was never lost, only misspelled', () => {
      expect(swimPair(after).scope).toEqual({ is_all_groups: true, groups: null })
    })
  })

  it('changes nothing when the director declines the merge', () => {
    const declined = extractEntities(parsed, undefined, [])
    expect(declined.entities.activities).toEqual(before.entities.activities)
    expect(swimPair(declined).scope.groups).toEqual(['A', 'B', 'C'])
  })
})
