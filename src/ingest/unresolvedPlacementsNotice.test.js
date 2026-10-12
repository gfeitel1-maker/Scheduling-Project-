import { describe, it, expect } from 'vitest'
import { unresolvedPlacementsNotice, electiveLinkNotices } from './unresolvedPlacementsNotice.js'

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

// T219 (Red Hat #4, #5): a double-period elective the import could not link is said, never silent.
describe('electiveLinkNotices', () => {
  it('says which elective was not linked across its periods, and why a link failed', () => {
    expect(electiveLinkNotices({ unlinkedSpans: [{ electiveSetName: 'Chugim', dayName: 'Monday' }] })).toEqual([
      "Chugim on Monday runs across different periods for different groups, so its choices weren't linked across the double period. Each period is chosen separately.",
    ])
    expect(electiveLinkNotices({ linkFailed: 'disk full' })).toEqual([
      "Your schedule was saved, but its double-period electives couldn't be linked, so each period is chosen separately (disk full).",
    ])
    expect(electiveLinkNotices({ created: true })).toEqual([])
    expect(electiveLinkNotices(null)).toEqual([])
  })
})

// Red Hat #5: when the version step itself fails, the director is told it failed and why,
// not shown every placement as "left out".
describe('unresolvedPlacementsNotice when the version could not be saved', () => {
  it('names the failure', () => {
    expect(unresolvedPlacementsNotice({ created: false, failed: 'disk full' })).toBe(
      "Your import finished, but the imported schedule couldn't be saved as a version (disk full). Import the file again to save it.",
    )
  })
})
