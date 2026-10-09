import { describe, it, expect } from 'vitest'
import { unresolvedPlacementsNotice } from './unresolvedPlacementsNotice.js'

describe('unresolvedPlacementsNotice', () => {
  it('is silent when everything matched', () => {
    expect(unresolvedPlacementsNotice({ created: true, unresolvedCount: 0, unresolvedNames: [] })).toBeNull()
  })
  it('names count, which, why and how to fix when some were skipped', () => {
    const msg = unresolvedPlacementsNotice({ created: true, unresolvedCount: 2, unresolvedNames: ['Kayak', 'Kayak'] })
    expect(msg).toMatch(/^2 placements/)
    expect(msg).toContain('(Kayak)')
    expect(msg).toMatch(/doesn't have/)
    expect(msg).toMatch(/import the file again/)
  })
  it('says the version was not saved when nothing matched', () => {
    expect(unresolvedPlacementsNotice({ created: false, unresolvedCount: 1, unresolvedNames: ['X'] })).toMatch(/couldn't be saved as a version/)
  })
})
