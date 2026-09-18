// T229 round 2, H4 — a camper's sheet division must gate which occurrences
// they attend. Before this fix `buildElectiveAssignments` was always called
// with `attendance: null` (its "every camper attends every occurrence"
// default), so a set placed on both a Juniors cell and a Seniors cell at the
// same day/block produced two occurrences holding the SAME campers in each.
import { describe, it, expect } from 'vitest'
import { buildAttendance } from './buildAttendance.js'

describe('buildAttendance', () => {
  it('sends a camper only to occurrences whose tier matches their division', () => {
    const occurrences = [
      { id: 'occ-juniors', tier_id: 'tier-juniors' },
      { id: 'occ-seniors', tier_id: 'tier-seniors' },
    ]
    const tiers = [
      { id: 'tier-juniors', name: 'Juniors' },
      { id: 'tier-seniors', name: 'Seniors' },
    ]
    const campers = [
      { id: 'cam-1', division: 'Juniors' },
      { id: 'cam-2', division: 'Seniors' },
    ]
    const { attendance } = buildAttendance({ campers, occurrences, tiers })
    expect(attendance['cam-1']).toEqual(['occ-juniors'])
    expect(attendance['cam-2']).toEqual(['occ-seniors'])
  })

  it('matches division to tier name whitespace/case-insensitively', () => {
    const occurrences = [
      { id: 'occ-1', tier_id: 'tier-1' },
      { id: 'occ-2', tier_id: 'tier-2' },
    ]
    const tiers = [
      { id: 'tier-1', name: 'Older  Campers' },
      { id: 'tier-2', name: 'Younger Campers' },
    ]
    const campers = [{ id: 'cam-1', division: 'olderCampers' }]
    const { attendance } = buildAttendance({ campers, occurrences, tiers })
    expect(attendance['cam-1']).toEqual(['occ-1'])
  })

  // Owner ruling R1 (never-unplaced) extends here: a camper whose division
  // matches no tier attends everything rather than being silently dropped,
  // and the caller is told how many that affected.
  it('sends an unmatched camper to every occurrence and counts it', () => {
    const occurrences = [
      { id: 'occ-juniors', tier_id: 'tier-juniors' },
      { id: 'occ-seniors', tier_id: 'tier-seniors' },
    ]
    const tiers = [
      { id: 'tier-juniors', name: 'Juniors' },
      { id: 'tier-seniors', name: 'Seniors' },
    ]
    const campers = [{ id: 'cam-1', division: 'Nobody Matches This' }]
    const { attendance, unmatchedCount } = buildAttendance({ campers, occurrences, tiers })
    expect(attendance['cam-1'].sort()).toEqual(['occ-juniors', 'occ-seniors'])
    expect(unmatchedCount).toBe(1)
  })

  // A camper with no division column at all is the same "cannot match" case.
  it('sends a camper with no division to every occurrence and counts it', () => {
    const occurrences = [{ id: 'occ-1', tier_id: 'tier-1' }, { id: 'occ-2', tier_id: 'tier-2' }]
    const tiers = [{ id: 'tier-1', name: 'Juniors' }, { id: 'tier-2', name: 'Seniors' }]
    const campers = [{ id: 'cam-1', division: null }]
    const { attendance, unmatchedCount } = buildAttendance({ campers, occurrences, tiers })
    expect(attendance['cam-1'].sort()).toEqual(['occ-1', 'occ-2'])
    expect(unmatchedCount).toBe(1)
  })

  // The common case: a set placed on only one tier's cells has nothing to
  // disambiguate — matching would be inventing a failure mode. attendance is
  // null, which is buildElectiveAssignments' own "attend everything" default.
  it('skips matching entirely when occurrences span only one tier', () => {
    const occurrences = [
      { id: 'occ-1', tier_id: 'tier-1' },
      { id: 'occ-2', tier_id: 'tier-1' },
    ]
    const tiers = [{ id: 'tier-1', name: 'Juniors' }]
    const campers = [{ id: 'cam-1', division: 'Juniors' }]
    const { attendance, unmatchedCount } = buildAttendance({ campers, occurrences, tiers })
    expect(attendance).toBeNull()
    expect(unmatchedCount).toBe(0)
  })
})
