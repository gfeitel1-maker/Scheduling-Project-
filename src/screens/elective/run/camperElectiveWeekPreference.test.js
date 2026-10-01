// T297 — the week projection has to name the PREFERENCE ROW behind each
// placement, because that is what an edit corrects. A new file rather than an
// append to camperElectiveWeek.test.js, per this corner's convention of keeping
// each ticket's tests separate so merges stay mechanical.
//
// Fabricated names only.
import { describe, it, expect } from 'vitest'
import { buildCamperElectiveWeek, buildPreferenceLookup } from './camperElectiveWeek.js'

const DAYS = [
  { id: 'day-mon', label: 'Monday', sort_order: 1 },
  { id: 'day-tue', label: 'Tuesday', sort_order: 2 },
]
const TIME_BLOCKS = [
  { id: 'tb-1', name: 'Period 1', sort_order: 1 },
  { id: 'tb-2', name: 'Period 2', sort_order: 2 },
]
const ACTIVITIES = [{ id: 'act-gaga', name: 'Gaga' }, { id: 'act-ceramics', name: 'Ceramics' }]
const OCCURRENCES = [
  { id: 'occ-a', day_id: 'day-mon', time_block_id: 'tb-1' },
  { id: 'occ-b', day_id: 'day-tue', time_block_id: 'tb-2' },
]
const ROW = {
  id: 'asg-1', camper_id: 'cam-1', occurrence_id: 'occ-a', activity_id: 'act-gaga',
  choice_id: 'choice-gaga', preference_rank: 1, camper_name: 'Ari Green',
}

const week = (preferences) => buildCamperElectiveWeek({
  camperId: 'cam-1', rows: [ROW], occurrences: OCCURRENCES,
  activities: ACTIVITIES, days: DAYS, timeBlocks: TIME_BLOCKS, preferences,
})

describe('buildCamperElectiveWeek — the preference behind a placement', () => {
  it('finds an occurrence-scoped preference for the same choice', () => {
    const [entry] = week([
      { id: 'pref-1', camper_id: 'cam-1', choice_id: 'choice-gaga', occurrence_id: 'occ-a', rank: 1, coordinate: null },
    ]).entries
    expect(entry.preferenceId).toBe('pref-1')
  })

  it('finds a COORDINATE-keyed preference, which is the shape an imported planner sheet has', () => {
    // commitElectiveRun persists the unresolved sheet, so a planner-grid row
    // carries occurrence_id NULL and a coordinate. The child wrote the day
    // lowercase and the period as a bare number; the camp says 'Monday' and
    // 'Period 1'. Matching on the raw strings finds nothing and the edit
    // affordance would silently fall back to "add", writing a second row.
    const [entry] = week([
      { id: 'pref-1', camper_id: 'cam-1', choice_id: 'choice-gaga', occurrence_id: null, rank: 1, coordinate: { dayName: 'monday', periodLabel: '1' } },
    ]).entries
    expect(entry.preferenceId).toBe('pref-1')
  })

  it('falls back to a whole-run preference when nothing names the cell', () => {
    const [entry] = week([
      { id: 'pref-run', camper_id: 'cam-1', choice_id: 'choice-gaga', occurrence_id: null, rank: 1, coordinate: null },
    ]).entries
    expect(entry.preferenceId).toBe('pref-run')
  })

  it('prefers the MOST SPECIFIC row when a camper has both', () => {
    // Order is reversed against the answer so a projection that simply takes the
    // first match fails. The engine's own rankAt prefers an occurrence-scoped
    // rank over a whole-run fallback; this mirrors that precedence rather than
    // inventing a second one.
    const [entry] = week([
      { id: 'pref-run', camper_id: 'cam-1', choice_id: 'choice-gaga', occurrence_id: null, rank: 4, coordinate: null },
      { id: 'pref-cell', camper_id: 'cam-1', choice_id: 'choice-gaga', occurrence_id: 'occ-a', rank: 1, coordinate: null },
    ]).entries
    expect(entry.preferenceId).toBe('pref-cell')
  })

  it('is null for a placement the camper never asked for, and for another camper’s row', () => {
    // The bronze "not requested" case: there is no preference to correct, so the
    // edit is an ADD. A wrong id here would rewrite a preference the director
    // never looked at.
    expect(week([]).entries[0].preferenceId).toBe(null)
    expect(week([
      { id: 'pref-other', camper_id: 'cam-2', choice_id: 'choice-gaga', occurrence_id: 'occ-a', rank: 1, coordinate: null },
    ]).entries[0].preferenceId).toBe(null)
    // A different choice at the same cell is not this placement's preference
    // either — the camper ranked Ceramics, the solver gave them Gaga.
    expect(week([
      { id: 'pref-cer', camper_id: 'cam-1', choice_id: 'choice-ceramics', occurrence_id: 'occ-a', rank: 1, coordinate: null },
    ]).entries[0].preferenceId).toBe(null)
  })

  // THE CASE THAT DISTINGUISHES BINDING FROM GUESSING, and the first version of
  // this file did not have it — proved by planting exactly that defect (skip the
  // coordinate resolution and treat every unbound row as a whole-run fallback):
  // ten tests still passed. One coordinate row per cell for the SAME choice is
  // the shape that tells them apart, because unbound they share one key and the
  // first one seen answers for both cells.
  //
  // The array is ordered AGAINST the answer — Tuesday's row first — so a
  // first-wins fallback gives Monday's placement the Tuesday row.
  it('gives each cell its OWN coordinate row when one choice is written in two cells', () => {
    const week = buildCamperElectiveWeek({
      camperId: 'cam-1',
      rows: [
        { ...ROW, id: 'asg-mon', occurrence_id: 'occ-a' },
        { ...ROW, id: 'asg-tue', occurrence_id: 'occ-b' },
      ],
      occurrences: OCCURRENCES, activities: ACTIVITIES, days: DAYS, timeBlocks: TIME_BLOCKS,
      preferences: [
        { id: 'pref-tue', camper_id: 'cam-1', choice_id: 'choice-gaga', occurrence_id: null, rank: 1, coordinate: { dayName: 'tuesday', periodLabel: '2' } },
        { id: 'pref-mon', camper_id: 'cam-1', choice_id: 'choice-gaga', occurrence_id: null, rank: 1, coordinate: { dayName: 'monday', periodLabel: '1' } },
      ],
    })
    expect(week.entries.map((e) => [e.assignmentId, e.preferenceId])).toEqual([
      ['asg-mon', 'pref-mon'],
      ['asg-tue', 'pref-tue'],
    ])
  })

  // T318 (c1) — the week entry must carry the joined preference's rank_kind, so
  // rankLabel can refuse an ordinal it has no evidence for.
  it('carries the joined preference’s rank_kind onto the entry', () => {
    const [entry] = week([
      { id: 'pref-1', camper_id: 'cam-1', choice_id: 'choice-gaga', occurrence_id: 'occ-a', rank: 1, rank_kind: 'unordered-set', coordinate: null },
    ]).entries
    expect(entry.preferenceId).toBe('pref-1')
    expect(entry.rankKind).toBe('unordered-set')
  })

  it('is null for a placement with no joinable preference, alongside a null preferenceId', () => {
    const [entry] = week([]).entries
    expect(entry.preferenceId).toBe(null)
    expect(entry.rankKind).toBe(null)
  })

  it('omitting preferences entirely leaves the rest of the week unchanged', () => {
    // T296's callers pass no `preferences`; they must keep working.
    const [entry] = buildCamperElectiveWeek({
      camperId: 'cam-1', rows: [ROW], occurrences: OCCURRENCES,
      activities: ACTIVITIES, days: DAYS, timeBlocks: TIME_BLOCKS,
    }).entries
    expect(entry).toMatchObject({
      assignmentId: 'asg-1', activityName: 'Gaga', rank: 1, isFallback: false, preferenceId: null,
    })
  })
})

// board item 9b round 3 (T321-equivalent, no ticket) — the join itself is
// tier-blind at 3 of the 4 acceptance-fixture misses: buildPreferenceLookup
// called resolvePreferenceCoordinates WITHOUT tierIdByCamperId, so a
// coordinate preference at a cell TWO TIERS SHARE bound to whichever
// occurrence is first in array order, not the camper's own. The solve/commit
// path (AssignmentPanel.jsx) already derives tierIdByCamperId and passes it to
// the resolver directly; buildPreferenceLookup had no such parameter at all.
//
// Fix shape: an optional `rows` param (the run's own assignment rows, which
// every caller already holds) lets buildPreferenceLookup recover the tier
// INTERNALLY — a camper is only ever placed in occurrences of their own tier
// (buildAttendance scopes them), so `row.occurrence_id -> occurrence.tier_id`
// is the tier the solver actually used. No new catalog read, no roster
// re-derivation.
describe('buildPreferenceLookup — tier-aware join at a cell two tiers share', () => {
  const TWO_TIER_OCCURRENCES = [
    { id: 'occ-jr', day_id: 'day-mon', time_block_id: 'tb-1', tier_id: 'tier-jr' },
    { id: 'occ-sr', day_id: 'day-mon', time_block_id: 'tb-1', tier_id: 'tier-sr' },
  ]
  // A Seniors camper's assignment: the solver placed them at the SENIORS
  // occurrence of this shared cell (buildAttendance would never place a
  // Seniors camper at occ-jr).
  const assignmentRow = {
    id: 'asg-sr', camper_id: 'cam-sr', occurrence_id: 'occ-sr', activity_id: 'act-swim',
    choice_id: 'choice-swim', preference_rank: 1, camper_name: 'Noa Katz',
  }
  // The camper's sheet named the cell, not an occurrence — exactly the shape
  // a per-cell preference sheet produces before solve-time binding.
  const coordinatePreference = {
    id: 'pref-sr', camper_id: 'cam-sr', choice_id: 'choice-swim', occurrence_id: null, rank: 1,
    coordinate: { dayName: 'Monday', periodLabel: 'Period 1' },
  }

  it('tier-blind (no rows): binds to the FIRST occurrence at the cell, not the camper’s own, so the join misses', () => {
    const lookup = buildPreferenceLookup({
      preferences: [coordinatePreference], occurrences: TWO_TIER_OCCURRENCES, days: DAYS, timeBlocks: TIME_BLOCKS,
    })
    expect(lookup(assignmentRow)).toBeNull()
  })

  it('tier-aware (rows passed): derives the camper’s tier from their own assignment and the join finds the row', () => {
    const lookup = buildPreferenceLookup({
      preferences: [coordinatePreference], occurrences: TWO_TIER_OCCURRENCES, days: DAYS, timeBlocks: TIME_BLOCKS,
      rows: [assignmentRow],
    })
    expect(lookup(assignmentRow)?.id).toBe('pref-sr')
  })
})
