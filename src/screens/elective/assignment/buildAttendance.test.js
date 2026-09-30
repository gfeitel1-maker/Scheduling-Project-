// T229 round 2, H4 — a camper's sheet division must gate which occurrences
// they attend. Before this fix `buildElectiveAssignments` was always called
// with `attendance: null` (its "every camper attends every occurrence"
// default), so a set placed on both a Juniors cell and a Seniors cell at the
// same day/block produced two occurrences holding the SAME campers in each.
//
// T301 VISUAL VERIFICATION FINDING (2026-09-29, unrelated to T301 itself —
// discovered while building a real multi-division solve fixture): every
// fixture below hand-built `{ division: '...' }` camper objects, and
// buildAttendance.js read `camper.division` — but `parsePreferenceSheet`
// (src/ingest/preferenceSheet.js) has never produced that field. It produces
// `division_label` (confirmed by calling it directly with the real
// production catalog shape). So in the shipped app, for every REAL sheet
// import, `camper.division` was always undefined, `buildAttendance` always
// took the "cannot match" branch for every camper, and a set spanning two
// divisions has never actually scoped attendance since T229 shipped — the
// exact H4 bug this module's own header says it was built to fix, silently
// unfixed by a one-field name mismatch this suite's own fixtures happened to
// paper over by using the field the code expected rather than the field the
// producer emits. Every fixture below is renamed division -> division_label
// to match; the integration test at the bottom of this file feeds the real
// parser's output through, so this specific shape of lie cannot recur.
import { describe, it, expect } from 'vitest'
import { buildAttendance } from './buildAttendance.js'
import { readPreferenceSheet } from '../../../ingest/preferenceImport.js'

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
      { id: 'cam-1', division_label: 'Juniors' },
      { id: 'cam-2', division_label: 'Seniors' },
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
    const campers = [{ id: 'cam-1', division_label: 'olderCampers' }]
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
    const campers = [{ id: 'cam-1', division_label: 'Nobody Matches This' }]
    const { attendance, unmatchedCount } = buildAttendance({ campers, occurrences, tiers })
    expect(attendance['cam-1'].sort()).toEqual(['occ-juniors', 'occ-seniors'])
    expect(unmatchedCount).toBe(1)
  })

  // A camper with no division column at all is the same "cannot match" case.
  it('sends a camper with no division to every occurrence and counts it', () => {
    const occurrences = [{ id: 'occ-1', tier_id: 'tier-1' }, { id: 'occ-2', tier_id: 'tier-2' }]
    const tiers = [{ id: 'tier-1', name: 'Juniors' }, { id: 'tier-2', name: 'Seniors' }]
    const campers = [{ id: 'cam-1', division_label: null }]
    const { attendance, unmatchedCount } = buildAttendance({ campers, occurrences, tiers })
    expect(attendance['cam-1'].sort()).toEqual(['occ-1', 'occ-2'])
    expect(unmatchedCount).toBe(1)
  })

  // The old fast path returned `attendance: null` whenever occurrences spanned
  // at most one tier, on the theory that a single-tier set has nothing to
  // disambiguate. That was a correctness bug, not an optimization: a single
  // tier can still span MULTIPLE groups (a same-tier set placed on two
  // groups' cells), and the group axis needs the same scoping the tier axis
  // already got in H4 — a director whose single-tier camp (this acceptance
  // fixture's Older 1 / Older 2 shape) is exactly the shape the early return
  // left unfixed. The function now always returns a computed map.
  it('still scopes by group even when occurrences span only one tier', () => {
    const occurrences = [
      { id: 'occ-1', tier_id: 'tier-1', group_ids: ['grp-1'] },
      { id: 'occ-2', tier_id: 'tier-1', group_ids: ['grp-2'] },
    ]
    const tiers = [{ id: 'tier-1', name: 'Juniors' }]
    const campers = [{ id: 'cam-1', division_label: 'Juniors', group_id: 'grp-1' }]
    const { attendance, unmatchedCount } = buildAttendance({ campers, occurrences, tiers })
    expect(attendance['cam-1']).toEqual(['occ-1'])
    expect(unmatchedCount).toBe(0)
  })

  // THE DEFECT SHAPE. One tier, two occurrences created by different groups.
  // A camper whose division matches the tier and whose group_id is X attends
  // only the occurrence X's group created — never the sibling group's
  // occurrence, even though both occurrences share the same tier_id.
  it('excludes a same-tier occurrence created by a sibling group', () => {
    const occurrences = [
      { id: 'occ-a', tier_id: 'tier-1', group_ids: ['grp-x'] },
      { id: 'occ-b', tier_id: 'tier-1', group_ids: ['grp-y'] },
    ]
    const tiers = [{ id: 'tier-1', name: 'Older' }]
    const campers = [{ id: 'cam-1', division_label: 'Older', group_id: 'grp-x' }]
    const { attendance } = buildAttendance({ campers, occurrences, tiers })
    expect(attendance['cam-1']).toEqual(['occ-a'])
    expect(attendance['cam-1']).not.toEqual(['occ-a', 'occ-b'])
  })

  // camper.group_id == null but division matched a tier (T279 §12.2a) — keeps
  // today's tier-wide admission: every occurrence of the matched tier,
  // regardless of which group created each one.
  it('admits a camper with no group_id to every occurrence of their matched tier', () => {
    const occurrences = [
      { id: 'occ-a', tier_id: 'tier-1', group_ids: ['grp-x'] },
      { id: 'occ-b', tier_id: 'tier-1', group_ids: ['grp-y'] },
    ]
    const tiers = [{ id: 'tier-1', name: 'Older' }]
    const campers = [{ id: 'cam-1', division_label: 'Older', group_id: null }]
    const { attendance, unmatchedCount } = buildAttendance({ campers, occurrences, tiers })
    expect(attendance['cam-1'].sort()).toEqual(['occ-a', 'occ-b'])
    expect(unmatchedCount).toBe(0)
  })

  // A correctly identified camper whose group carries the set in NO occurrence
  // legitimately gets []. This is NOT an R1 (never-unplaced) violation — R1 is
  // about a camper we cannot IDENTIFY, not one who was identified and simply
  // isn't in this set's rotation — so it must not increment unmatchedCount or
  // appear in `unmatched`.
  it('gives an empty occurrence list to a matched camper whose group carries the set nowhere, without counting them unmatched', () => {
    const occurrences = [
      { id: 'occ-a', tier_id: 'tier-1', group_ids: ['grp-x'] },
    ]
    const tiers = [{ id: 'tier-1', name: 'Older' }]
    const campers = [{ id: 'cam-1', division_label: 'Older', group_id: 'grp-z' }]
    const { attendance, unmatchedCount, unmatched, noCells } = buildAttendance({ campers, occurrences, tiers })
    expect(attendance['cam-1']).toEqual([])
    expect(unmatchedCount).toBe(0)
    expect(unmatched).toEqual([])
    // Round 2 — Constitution Art. V forbids a camper vanishing from every
    // export with zero visible cause. A correctly identified camper whose
    // group carries the set nowhere must be named in `noCells`, grouped by
    // the value that caused it (their group_id) the same shape as
    // unmatchedByValue/ambiguousByValue above.
    expect(noCells).toEqual([{ group_id: 'grp-z', camperCount: 1 }])
  })

  // Round 2, Art. V follow-up. `noCells` fires ONLY for branch 1 (a matched,
  // group-identified camper whose group is absent from every occurrence of
  // their matched tier) — never for the unmatched/ambiguous branches, which
  // already have their own visibility (unmatched/ambiguous) and must not be
  // double-counted or re-labeled. NON-VACUITY: an implementation that folded
  // this into `unmatched` (the likeliest wrong shortcut, since both are
  // "camper got []-ish treatment") would pass every attendance/unmatchedCount
  // assertion here while silently merging two different causes into one
  // channel — pinned by asserting unmatched/ambiguous stay empty while
  // noCells is populated, and vice versa in the sibling tests above.
  it('does not populate noCells for the unmatched or ambiguous branches', () => {
    const occurrences = [{ id: 'occ-a', tier_id: 'tier-1', group_ids: ['grp-x'] }]
    const tiers = [{ id: 'tier-1', name: 'Older' }, { id: 'tier-2', name: 'Older' }]
    const campers = [
      { id: 'cam-unmatched', division_label: 'Nobody', group_id: 'grp-z' },
      { id: 'cam-ambiguous', division_label: 'Older', group_id: 'grp-z' },
    ]
    const { noCells, unmatchedCount, ambiguous } = buildAttendance({ campers, occurrences, tiers })
    expect(noCells).toEqual([])
    expect(unmatchedCount).toBe(1)
    expect(ambiguous).toHaveLength(1)
  })

  // Round 3, Red Hat MEDIUM — REWRITTEN. The old version of this test PINNED
  // A SILENCE: a camper whose matched tier has zero occurrences landed in no
  // bucket at all, which contradicted this module's own noCells docstring
  // ("a correctly identified camper who attends zero occurrences" is
  // surfaced). Once the `tierOccurrences.length > 0` guard is dropped (round
  // 3), "your group has no period for this elective set" is true and useful
  // even when the WHOLE tier has no occurrences — the group's tier is
  // genuinely `tier-1`, and `tier-1` simply never got a cell.
  it('populates noCells when the matched tier itself has no occurrences, for a camper whose group tier matches', () => {
    const occurrences = [{ id: 'occ-other', tier_id: 'tier-other', group_ids: ['grp-x'] }]
    const tiers = [{ id: 'tier-1', name: 'Older' }, { id: 'tier-other', name: 'Younger' }]
    const groups = [{ id: 'grp-z', tier_id: 'tier-1' }]
    const campers = [{ id: 'cam-1', division_label: 'Older', group_id: 'grp-z' }]
    const { attendance, noCells, divisionMismatches } = buildAttendance({ campers, occurrences, tiers, groups })
    expect(attendance['cam-1']).toEqual([])
    expect(noCells).toEqual([{ group_id: 'grp-z', camperCount: 1 }])
    expect(divisionMismatches).toEqual([])
  })

  // Groups multiple campers of the same excluded group under one entry —
  // same per-value grouping shape as unmatchedByValue/ambiguousByValue.
  it('groups multiple campers of the same excluded group under one noCells entry', () => {
    const occurrences = [{ id: 'occ-a', tier_id: 'tier-1', group_ids: ['grp-x'] }]
    const tiers = [{ id: 'tier-1', name: 'Older' }]
    const campers = [
      { id: 'cam-1', division_label: 'Older', group_id: 'grp-z' },
      { id: 'cam-2', division_label: 'Older', group_id: 'grp-z' },
    ]
    const { noCells } = buildAttendance({ campers, occurrences, tiers })
    expect(noCells).toEqual([{ group_id: 'grp-z', camperCount: 2 }])
  })

  // T229/H4's original property, re-confirmed under group scoping: the tier
  // gate is checked FIRST and is never widened by a group_id match. A camper
  // whose group_id happens to appear in a SIBLING tier's occurrence must
  // still never reach it.
  it('never admits a camper to an occurrence of a different tier, even when group_ids overlap', () => {
    const occurrences = [
      { id: 'occ-juniors', tier_id: 'tier-juniors', group_ids: ['grp-shared'] },
      { id: 'occ-seniors', tier_id: 'tier-seniors', group_ids: ['grp-shared'] },
    ]
    const tiers = [
      { id: 'tier-juniors', name: 'Juniors' },
      { id: 'tier-seniors', name: 'Seniors' },
    ]
    const campers = [{ id: 'cam-1', division_label: 'Juniors', group_id: 'grp-shared' }]
    const { attendance } = buildAttendance({ campers, occurrences, tiers })
    expect(attendance['cam-1']).toEqual(['occ-juniors'])
  })

  // Round 3, Red Hat HIGH — SHEET/ROSTER TIER DISAGREEMENT. The sheet's
  // Division column says "Older" (matches tier-older); the camper's ROSTER
  // group is a Younger bunk. deriveOccurrences.js only ever adds a slot's
  // group_id after confirming the group's OWN tier_id, so a Younger group can
  // never appear in an Older occurrence's group_ids — groupOccurrences is
  // always empty for this camper, for a reason that has nothing to do with
  // "the group has no cell". Folding this into noCells would tell the
  // director "Younger 1's schedule has no period for this elective set" —
  // true and useless, since the real problem is the sheet/roster disagreement
  // itself, not Younger 1's rotation. NON-VACUITY: an implementation that
  // still lumps this into noCells must fail both the divisionMismatches
  // assertion and the noCells-emptiness assertion below.
  it('classifies a sheet/roster tier disagreement as a divisionMismatch, not a noCells', () => {
    const occurrences = [{ id: 'occ-older', tier_id: 'tier-older', group_ids: ['grp-older-1'] }]
    const tiers = [{ id: 'tier-older', name: 'Older' }, { id: 'tier-younger', name: 'Younger' }]
    const groups = [{ id: 'grp-younger-1', tier_id: 'tier-younger' }]
    const campers = [{ id: 'cam-1', division_label: 'Older', group_id: 'grp-younger-1' }]
    const { attendance, unmatchedCount, noCells, divisionMismatches } = buildAttendance({
      campers, occurrences, tiers, groups,
    })
    expect(attendance['cam-1']).toEqual([])
    expect(noCells).toEqual([])
    expect(divisionMismatches).toEqual([{ division: 'Older', group_id: 'grp-younger-1', camperCount: 1 }])
    expect(unmatchedCount).toBe(0)
  })

  // The genuine no-cell case must still land in noCells when the ROSTER
  // agrees with the sheet (the group's own tier IS the matched tier) — this
  // is the case round 2 introduced, re-confirmed now that classification
  // exists.
  it('still classifies a same-tier group with no carried occurrence as noCells, not a mismatch', () => {
    const occurrences = [{ id: 'occ-a', tier_id: 'tier-1', group_ids: ['grp-x'] }]
    const tiers = [{ id: 'tier-1', name: 'Older' }]
    const groups = [{ id: 'grp-z', tier_id: 'tier-1' }]
    const campers = [{ id: 'cam-1', division_label: 'Older', group_id: 'grp-z' }]
    const { noCells, divisionMismatches } = buildAttendance({ campers, occurrences, tiers, groups })
    expect(noCells).toEqual([{ group_id: 'grp-z', camperCount: 1 }])
    expect(divisionMismatches).toEqual([])
  })

  // A group_id absent from `groups` entirely (caller passed no roster, or the
  // group was deleted) must fall to noCells, never to divisionMismatches —
  // there is no second fact to disagree with, so inventing a "mismatch" from
  // missing data would be a fabricated diagnosis.
  it('falls back to noCells, not divisionMismatches, when the group_id is unknown to groups', () => {
    const occurrences = [{ id: 'occ-a', tier_id: 'tier-1', group_ids: ['grp-x'] }]
    const tiers = [{ id: 'tier-1', name: 'Older' }]
    const groups = [{ id: 'grp-x', tier_id: 'tier-1' }] // grp-z is NOT in groups
    const campers = [{ id: 'cam-1', division_label: 'Older', group_id: 'grp-z' }]
    const { noCells, divisionMismatches } = buildAttendance({ campers, occurrences, tiers, groups })
    expect(noCells).toEqual([{ group_id: 'grp-z', camperCount: 1 }])
    expect(divisionMismatches).toEqual([])
  })

  // NON-VACUITY. Drives the REAL parser (src/ingest/preferenceImport.js) on a
  // sheet naming a real division, then feeds its ACTUAL campers[] output
  // straight into buildAttendance — no hand-built fixture standing in for
  // what the producer emits. This is the shape of test the codebase's own
  // T62 lesson calls for (a fixture that matches the code's assumption
  // proves nothing about whether that assumption matches reality); it is
  // what would have caught the division/division_label mismatch.
  it('scopes attendance correctly from a camper produced by the REAL sheet parser, not a hand-built fixture', () => {
    const rows = [
      ['Name', 'Division', '#1'],
      ['Ari', 'Juniors', 'Drama'],
      ['Zev', 'Seniors', 'Drama'],
    ]
    const catalog = { activities: [{ id: 'act-1', name: 'Drama' }], groups: [], tiers: [{ id: 'tier-jr', name: 'Juniors' }, { id: 'tier-sr', name: 'Seniors' }] }
    const { parsed } = readPreferenceSheet({ rows, campId: 'camp-1', catalog, sourceLabel: 's', submissionKey: 'k', arrivalId: 'a' })
    const occurrences = [{ id: 'occ-jr', tier_id: 'tier-jr' }, { id: 'occ-sr', tier_id: 'tier-sr' }]
    const { attendance, unmatchedCount } = buildAttendance({ campers: parsed.campers, occurrences, tiers: catalog.tiers })
    const ari = parsed.campers.find((c) => c.display_name === 'Ari').id
    const zev = parsed.campers.find((c) => c.display_name === 'Zev').id
    expect(attendance[ari]).toEqual(['occ-jr'])
    expect(attendance[zev]).toEqual(['occ-sr'])
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
      { id: 'c1', display_name: 'A', division_label: 'Bogrimm' },
      { id: 'c2', display_name: 'B', division_label: 'Bogrimm' },
      { id: 'c3', display_name: 'C', division_label: 'Bogrim' },
    ]
    const { unmatched, unmatchedCount } = buildAttendance({ campers, occurrences, tiers })
    expect(unmatchedCount).toBe(2)
    expect(unmatched).toEqual([{ division: 'Bogrimm', camperCount: 2, suggestion: 'Bogrim' }])
  })

  it('reports a value with no plausible match as having no suggestion', () => {
    const campers = [{ id: 'c1', display_name: 'A', division_label: 'Waterfront' }]
    const { unmatched } = buildAttendance({ campers, occurrences, tiers })
    expect(unmatched).toEqual([{ division: 'Waterfront', camperCount: 1, suggestion: null }])
  })

  it('reports nothing when every division matches', () => {
    const campers = [{ id: 'c1', display_name: 'A', division_label: 'Bogrim' }]
    const { unmatched, unmatchedCount } = buildAttendance({ campers, occurrences, tiers })
    expect(unmatched).toEqual([])
    expect(unmatchedCount).toBe(0)
  })

  // The fallback is unchanged: an unmatched camper is still considered for
  // every occurrence rather than dropped (owner ruling: never unplaced). This
  // slice makes the problem legible, it does not change who gets placed.
  it('still considers an unmatched camper for every occurrence', () => {
    const campers = [{ id: 'c1', display_name: 'A', division_label: 'Bogrimm' }]
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
    const campers = [{ id: 'c1', division_label: 'Bogrim' }]
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
    const campers = [{ id: 'c1', division_label: 'BOGRIM' }]
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
      { id: 'c1', division_label: 'Bogrim' },
      { id: 'c2', division_label: 'Nobody' },
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
    const campers = [{ id: 'c1', division_label: 'Bogrim' }]
    const { unmatched, unmatchedCount } = buildAttendance({ campers, occurrences, tiers })
    expect(unmatched).toEqual([])
    expect(unmatchedCount).toBe(0)
  })
})
