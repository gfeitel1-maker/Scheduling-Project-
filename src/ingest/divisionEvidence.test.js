import { describe, it, expect } from 'vitest'
import { divisionSupportByGroup } from './inferDivisions.js'

// T114 follow-up — a division split must be AUDITABLE.
//
// Co-schedule rules record why they concluded what they did; divisions did not,
// so when the importer decided that "Kittah Aleph" and "Kittah Bet" are two
// divisions rather than one, a director had no way to find out why. That
// asymmetry was recorded as a known gap rather than overlooked, and this closes
// it.
//
// The claim being evidenced is per GROUP, not per division: the question a
// director actually asks is "why is Tzofim 1 in Tzofim?" — and a split shows up
// as two groups whose support says the grid contradicted their shared name.

const p = (groupName, dayName, blockLabel, activityName) =>
  ({ groupName, dayName, blockLabel, activityName })

describe('divisionSupportByGroup', () => {
  it('explains a name-stem cluster, naming the siblings it clustered with', () => {
    const s = divisionSupportByGroup(['Tzofim 1', 'Tzofim 2', 'Tzofim 3'])
    expect(s['Tzofim 1'].basis).toBe('name_stem')
    expect(s['Tzofim 1'].division).toBe('Tzofim')
    expect(s['Tzofim 1'].members).toEqual(['Tzofim 1', 'Tzofim 2', 'Tzofim 3'])
    // The shared stem IS the reason — quote it, so a director can see the
    // importer read "Tzofim" out of the names and not from anywhere else.
    expect(s['Tzofim 1'].stem).toBe('Tzofim')
  })

  it('explains a lone group as its own division', () => {
    const s = divisionSupportByGroup(['CIT', 'Tzofim 1', 'Tzofim 2'])
    expect(s.CIT.basis).toBe('solo')
    expect(s.CIT.division).toBe('CIT')
    expect(s.CIT.members).toEqual(['CIT'])
  })

  it('records a bracketed qualifier as stripped, since that changes the answer', () => {
    // "Tzofim 1 (girls)" clusters only because the bracket came off first.
    // Without that noted, the division looks unexplainable from the raw names.
    const s = divisionSupportByGroup(['Tzofim 1 (girls)', 'Tzofim 2 (girls)'])
    expect(s['Tzofim 1 (girls)'].division).toBe('Tzofim')
    expect(s['Tzofim 1 (girls)'].qualifier_stripped).toBe(true)
  })

  it('leaves qualifier_stripped false when nothing was stripped', () => {
    expect(divisionSupportByGroup(['Tzofim 1', 'Tzofim 2'])['Tzofim 1'].qualifier_stripped).toBe(false)
  })

  it('explains a SPLIT — the names said one division, the grid said otherwise', () => {
    // Kittah Aleph groups share activities with each other and Kittah Bet
    // groups with each other, but the two halves never once meet.
    // NOTE the names must share a STEM for a split to be possible at all: the
    // stem is everything but the final token, so "Kittah Aleph 1" / "Kittah
    // Bet 1" are already two families by name and never reach the grid check.
    // These four are ONE "Kittah" family that the grid breaks in half.
    const placements = [
      p('Kittah 1', 'Mon', '9:00', 'Sports'),
      p('Kittah 2', 'Mon', '9:00', 'Sports'),
      p('Kittah 3', 'Mon', '10:00', 'Art'),
      p('Kittah 4', 'Mon', '10:00', 'Art'),
    ]
    const names = ['Kittah 1', 'Kittah 2', 'Kittah 3', 'Kittah 4']
    const s = divisionSupportByGroup(names, placements)
    expect(s['Kittah 1'].basis).toBe('split_by_co_occurrence')
    // The reason a director needs: names proposed ONE division, the grid
    // contradicted it. Both halves of that must be visible.
    expect(s['Kittah 1'].names_proposed).toBe('Kittah')
    expect(s['Kittah 1'].division).not.toBe('Kittah')
    expect(s['Kittah 3'].names_proposed).toBe('Kittah')
    expect(s['Kittah 1'].division).not.toBe(s['Kittah 3'].division)
  })

  it('does NOT call it a split when the grid agrees with the names', () => {
    const placements = [
      p('Tzofim 1', 'Mon', '9:00', 'Sports'),
      p('Tzofim 2', 'Mon', '9:00', 'Sports'),
    ]
    expect(divisionSupportByGroup(['Tzofim 1', 'Tzofim 2'], placements)['Tzofim 1'].basis)
      .toBe('name_stem')
  })

  it('records which anchors were excluded, because that decides what the grid can show', () => {
    // An all-camp lunch puts every group in one slot. With anchors left in,
    // NOTHING could ever split — every group would look like it shares a
    // division with every other. So "which activities were ignored" is
    // load-bearing evidence, not a footnote.
    const placements = [
      p('Kittah 1', 'Mon', '12:00', 'Lunch'),
      p('Kittah 2', 'Mon', '12:00', 'Lunch'),
      p('Kittah 1', 'Mon', '9:00', 'Sports'),
      p('Kittah 2', 'Mon', '9:00', 'Sports'),
    ]
    const s = divisionSupportByGroup(['Kittah 1', 'Kittah 2'], placements, ['Lunch'])
    expect(s['Kittah 1'].anchors_excluded).toEqual(['Lunch'])
    // Sports still vouches for them, so the names stand.
    expect(s['Kittah 1'].basis).toBe('name_stem')
  })

  it('does not split when excluding anchors leaves NO evidence either way', () => {
    // Lunch was the only thing these two ever shared. Excluded, the grid says
    // nothing at all about them — and "nothing observed" is not the same as
    // "never shared". Splitting on an empty grid would manufacture a boundary
    // out of an absence, so the name-derived division stands.
    const placements = [
      p('Kittah 1', 'Mon', '12:00', 'Lunch'),
      p('Kittah 2', 'Mon', '12:00', 'Lunch'),
    ]
    const s = divisionSupportByGroup(['Kittah 1', 'Kittah 2'], placements, ['Lunch'])
    expect(s['Kittah 1'].basis).toBe('name_stem')
    expect(s['Kittah 1'].division).toBe('Kittah')
  })

  it('covers every group and never throws on degenerate input', () => {
    expect(divisionSupportByGroup([])).toEqual({})
    expect(divisionSupportByGroup(null)).toEqual({})
    const s = divisionSupportByGroup(['A', 'B'], null, null)
    expect(Object.keys(s).sort()).toEqual(['A', 'B'])
  })

  it('agrees with inferDivisionEntities — one source of truth, not two', async () => {
    // The support must describe the SAME assignment that is actually committed,
    // or the evidence explains a division the director never sees.
    const { inferDivisionEntities } = await import('./inferDivisions.js')
    const names = ['Tzofim 1', 'Tzofim 2', 'CIT']
    const entities = inferDivisionEntities(names)
    const s = divisionSupportByGroup(names)
    for (const d of entities) {
      for (const g of d.groupNames) expect(s[g].division).toBe(d.name)
    }
  })
})
