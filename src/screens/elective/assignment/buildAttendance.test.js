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

// T232 — a count is not actionable. Name the values, and propose the division
// the sheet probably meant (propose, never merge — T144's standing decision).
describe('unmatched divisions are named, with a proposal', () => {
  const tiers = [{ id: 't1', name: 'Bogrim' }, { id: 't2', name: 'Machanayim' }]
  const occurrences = [{ id: 'o1', tier_id: 't1' }, { id: 'o2', tier_id: 't2' }]

  it('reports each unmatched division value with the camper count and a suggestion', () => {
    const campers = [
      { id: 'c1', display_name: 'A', division: 'Bogrimm' },
      { id: 'c2', display_name: 'B', division: 'Bogrimm' },
      { id: 'c3', display_name: 'C', division: 'Bogrim' },
    ]
    const { unmatched, unmatchedCount } = buildAttendance({ campers, occurrences, tiers })
    expect(unmatchedCount).toBe(2)
    expect(unmatched).toEqual([{ division: 'Bogrimm', camperCount: 2, suggestion: 'Bogrim' }])
  })

  it('reports a value with no plausible match as having no suggestion', () => {
    const campers = [{ id: 'c1', display_name: 'A', division: 'Waterfront' }]
    const { unmatched } = buildAttendance({ campers, occurrences, tiers })
    expect(unmatched).toEqual([{ division: 'Waterfront', camperCount: 1, suggestion: null }])
  })

  it('reports nothing when every division matches', () => {
    const campers = [{ id: 'c1', display_name: 'A', division: 'Bogrim' }]
    const { unmatched, unmatchedCount } = buildAttendance({ campers, occurrences, tiers })
    expect(unmatched).toEqual([])
    expect(unmatchedCount).toBe(0)
  })

  // The fallback is unchanged: an unmatched camper is still considered for
  // every occurrence rather than dropped (owner ruling: never unplaced). This
  // slice makes the problem legible, it does not change who gets placed.
  it('still considers an unmatched camper for every occurrence', () => {
    const campers = [{ id: 'c1', display_name: 'A', division: 'Bogrimm' }]
    const { attendance } = buildAttendance({ campers, occurrences, tiers })
    expect(attendance.c1).toEqual(['o1', 'o2'])
  })
})


// T255 Slice B, finding 6 — schema v73 lets two tiers (age divisions) share a
// name. `tierIdByNameKey` was a plain last-write-wins Map, so a camper whose
// division matched an ambiguous name bound to whichever tier happened to be
// seeded last — silently seating them in only ONE of the two same-named
// divisions' occurrences, which is exactly the wrong-bind failure this module
// exists to prevent (a Juniors set seating Seniors kids, or here, half of an
// ambiguous division's campers losing their occurrences). The correct
// treatment is the existing never-unplaced fallback (owner ruling R1): every
// occurrence, not an arbitrary one.
describe('ambiguous divisions fall back to every occurrence, never an arbitrary tier', () => {
  it('does not bind a camper to only one of two same-named tiers', () => {
    const tiers = [{ id: 't1', name: 'Bogrim' }, { id: 't2', name: 'Bogrim' }]
    const occurrences = [{ id: 'o1', tier_id: 't1' }, { id: 'o2', tier_id: 't2' }]
    const campers = [{ id: 'c1', division: 'Bogrim' }]
    const { attendance, ambiguous } = buildAttendance({ campers, occurrences, tiers })
    expect(attendance.c1.sort()).toEqual(['o1', 'o2'])
    expect(ambiguous).toEqual([{ division: 'Bogrim', camperCount: 1 }])
  })

  // NON-VACUITY. Code Reviewer and Red Hat independently rejected the first
  // attempt at this, which added a THIRD same-named tier. They were right: the
  // refusal tracks ambiguity in a Set (`if (ambiguous.has(key)) continue`), so
  // the two-way and three-way paths are byte-identical and an extra row plants
  // nothing. A guard's description is part of the guard, and "one more
  // duplicate" is inside the description.
  //
  // These two plant shapes the guard was NOT written against.
  //
  // FIRST: the collision exists only AFTER the fold. The raw names differ
  // ("Bogrim" vs " bogrim"), so an implementation that compared raw names —
  // or that collected collisions before canonicalizing — would see two
  // distinct divisions, bind the camper to whichever the sheet's own folded
  // key happened to hit, and report no ambiguity at all. That is a wrong bind
  // this file's own premise makes possible: electiveChoiceLabelKey exists
  // precisely because a director transcribing "Older Campers" and
  // "OlderCampers" means one division.
  it('refuses a collision that exists only after the name is canonicalized', () => {
    const tiers = [{ id: 't1', name: 'Bogrim' }, { id: 't2', name: ' bogrim' }]
    const occurrences = [{ id: 'o1', tier_id: 't1' }, { id: 'o2', tier_id: 't2' }]
    const campers = [{ id: 'c1', division: 'BOGRIM' }]
    const { attendance, ambiguous, unmatched } = buildAttendance({ campers, occurrences, tiers })
    expect(attendance.c1.sort()).toEqual(['o1', 'o2'])
    expect(ambiguous).toHaveLength(1)
    expect(unmatched).toEqual([])
  })

  // SECOND: a HALF-DONE fix, which is the likeliest way this regresses and is
  // not the defect the guard was written for. Deleting the colliding key from
  // the map without adding the third `ambiguous` state would satisfy every
  // attendance assertion above — the camper still gets every occurrence, via
  // the never-unplaced fallback — while misreporting the cause as a typo the
  // director should fix in their spreadsheet. The remedy is the opposite
  // (rename a division), so a wrong diagnosis sends them to the wrong screen.
  // Pinned by asserting the two channels do not swap, with a camper whose
  // division is genuinely absent present in the same run so the test cannot
  // pass by simply never reporting anything.
  it('reports an ambiguous division as ambiguous and a missing one as unmatched, never the reverse', () => {
    const tiers = [{ id: 't1', name: 'Bogrim' }, { id: 't2', name: 'Bogrim' }, { id: 't3', name: 'Sollelim' }]
    const occurrences = [{ id: 'o1', tier_id: 't1' }, { id: 'o2', tier_id: 't2' }, { id: 'o3', tier_id: 't3' }]
    const campers = [
      { id: 'c1', division: 'Bogrim' },
      { id: 'c2', division: 'Nobody' },
    ]
    const { ambiguous, unmatched, unmatchedCount } = buildAttendance({ campers, occurrences, tiers })
    expect(ambiguous.map((a) => a.division)).toEqual(['Bogrim'])
    expect(unmatched.map((u) => u.division ?? u.value ?? u)).toEqual(
      expect.arrayContaining([expect.anything()])
    )
    expect(JSON.stringify(unmatched)).toContain('Nobody')
    expect(JSON.stringify(unmatched)).not.toContain('Bogrim')
    expect(unmatchedCount).toBe(1)
  })

  it('does not count an ambiguous division as unmatched', () => {
    const tiers = [{ id: 't1', name: 'Bogrim' }, { id: 't2', name: 'Bogrim' }]
    const occurrences = [{ id: 'o1', tier_id: 't1' }, { id: 'o2', tier_id: 't2' }]
    const campers = [{ id: 'c1', division: 'Bogrim' }]
    const { unmatched, unmatchedCount } = buildAttendance({ campers, occurrences, tiers })
    expect(unmatched).toEqual([])
    expect(unmatchedCount).toBe(0)
  })
})
