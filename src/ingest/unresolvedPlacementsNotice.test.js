import { describe, it, expect } from 'vitest'
import { unresolvedPlacementsNotice } from './unresolvedPlacementsNotice.js'

describe('unresolvedPlacementsNotice', () => {
  it('is silent when a version was saved, whatever was left out', () => {
    expect(unresolvedPlacementsNotice({ created: true, unresolvedCount: 2, unresolvedNames: ['Kayak'] })).toBeNull()
  })
  it('says plainly the schedule was not saved when every week is archived', () => {
    const msg = unresolvedPlacementsNotice({ created: false, allWeeksArchived: true, unresolvedCount: 0, unresolvedNames: [] })
    expect(msg).toMatch(/wasn't saved/)
    expect(msg).toMatch(/unarchive a week or add a new one/)
  })
})
