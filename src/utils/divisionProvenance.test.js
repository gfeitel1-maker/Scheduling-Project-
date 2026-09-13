import { describe, it, expect } from 'vitest'
import { describeDivisionEvidence } from './divisionProvenance.js'

// The sentence a director reads when they ask why a bunk is in a division.
// Pure and separately tested because it is the ENTIRE user-facing value of the
// evidence — a row in a table nobody can read explains nothing.

const base = {
  division: 'Tzofim', basis: 'name_stem', members: ['Tzofim 1', 'Tzofim 2', 'Tzofim 3'],
  stem: 'Tzofim', qualifier_stripped: false, anchors_excluded: [],
}

describe('describeDivisionEvidence', () => {
  it('names the shared stem and the siblings for a name cluster', () => {
    const s = describeDivisionEvidence(base, 'Tzofim 1')
    expect(s).toContain('Tzofim')
    expect(s).toContain('Tzofim 2')
    // The sibling list must not include the group being explained — telling a
    // director "Tzofim 1 was grouped with Tzofim 1" reads as a bug.
    expect(s).not.toMatch(/with[^.]*Tzofim 1/)
  })

  it('explains a solo group without implying something went wrong', () => {
    const s = describeDivisionEvidence(
      { ...base, basis: 'solo', division: 'CIT', members: ['CIT'], stem: 'CIT' }, 'CIT')
    expect(s).toMatch(/own age division/i)
    expect(s).not.toMatch(/only|failed|could not/i)
  })

  it('says plainly that the grid overruled the names on a split', () => {
    const s = describeDivisionEvidence({
      ...base, basis: 'split_by_co_occurrence', division: 'Kittah 1',
      names_proposed: 'Kittah', members: ['Kittah 1', 'Kittah 2'], stem: 'Kittah',
    }, 'Kittah 1')
    expect(s).toContain('Kittah')
    expect(s).toMatch(/never share|no shared|separate/i)
  })

  it('mentions a stripped qualifier, because it changes the answer', () => {
    const s = describeDivisionEvidence({ ...base, qualifier_stripped: true }, 'Tzofim 1 (girls)')
    expect(s).toMatch(/bracket|parenthes|\(/i)
  })

  it('mentions ignored all-camp activities, since they decide what the grid could show', () => {
    const s = describeDivisionEvidence({ ...base, anchors_excluded: ['Lunch', 'Carpool'] }, 'Tzofim 1')
    expect(s).toContain('Lunch')
    expect(s).toMatch(/all-camp|ignored|every group/i)
  })

  it('says nothing about anchors when none were excluded', () => {
    expect(describeDivisionEvidence(base, 'Tzofim 1')).not.toMatch(/ignored/i)
  })

  it('degrades to a plain sentence rather than throwing on junk', () => {
    expect(typeof describeDivisionEvidence(null, 'X')).toBe('string')
    expect(typeof describeDivisionEvidence({}, 'X')).toBe('string')
    expect(describeDivisionEvidence(undefined, 'X').length).toBeGreaterThan(0)
  })
})
