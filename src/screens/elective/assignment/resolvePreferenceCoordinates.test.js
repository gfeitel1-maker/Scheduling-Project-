// @vitest-environment node
//
// T285 — resolver 5's MISSING HALF, and the regression it lets through.
//
// THE DEFECT THIS EXISTS TO CLOSE, reproduced by execution before anything was
// written. Given a per-cell sheet:
//
//   Camper Name,Day Of Week,Period Number,#1,#2,#3
//   Ari Feldspar,Monday,3,Swim,Archery,
//   Ari Feldspar,Friday,6,Archery,,Swim
//
// the PARSE is correct — four preferences, coordinates intact, `occurrence_id`
// absent on all of them, because no template exists at parse time. Feed those to
// the solver and Friday P6 came back placed in SWIM, which Ari ranked THIRD
// there, while he had named Archery as his Friday first choice.
//
// MECHANISM: the engine has exactly TWO scopes — `occurrence_id`, and one
// whole-run scalar — and `record()` did `entry.fallback = rank`, a bare
// assignment. A coordinate row has no occurrence_id, so EVERY cell of a planner
// collapsed onto that single scalar and overwrote the others.
//
// ROOT CAUSE, which is why this module exists rather than a patch to the
// fallback: the coordinate columns had ZERO READERS. ADR §3.1 and
// schema.sql both say "the caller resolves the coordinate to an occurrence at
// solve time" and no caller did. We stored what the child wrote and never read it
// back.
//
// WHY THIS IS WORSE THAN THE BUG IT REPLACED: before this branch those rows were
// REFUSED by `hasContradictoryRanks` — loud and wrong. Accepted-and-silently-
// misplaced, with a `preference_rank` asserting a first choice that was not
// honoured, is a confident wrong answer. That is a regression against where we
// started, and it is T278's own defect class one layer downstream.
import { describe, it, expect } from 'vitest'
import { resolvePreferenceCoordinates } from './resolvePreferenceCoordinates.js'
import { buildElectiveAssignments } from '../../../engine/buildElectiveAssignments.js'

const DAYS = [
  { id: 'd-mon', label: 'Monday' },
  { id: 'd-fri', label: 'Friday' },
]
const TIME_BLOCKS = [
  { id: 'tb-3', name: 'Period 3' },
  { id: 'tb-6', name: 'Period 6' },
]
const OCCURRENCES = [
  { id: 'o-mon3', day_id: 'd-mon', time_block_id: 'tb-3', tier_id: 't-1' },
  { id: 'o-fri6', day_id: 'd-fri', time_block_id: 'tb-6', tier_id: 't-1' },
]

const pref = (rank, dayName, periodLabel, labelKey) => ({
  camper_id: 'cam-1',
  labelKey,
  rank,
  coordinate: { dayName, periodLabel },
})

describe('resolvePreferenceCoordinates', () => {
  it('binds a (day label, period label) coordinate onto the occurrence at that cell', () => {
    const { preferences, residue } = resolvePreferenceCoordinates({
      preferences: [pref(1, 'Monday', '3', 'swim'), pref(1, 'Friday', '6', 'archery')],
      occurrences: OCCURRENCES,
      days: DAYS,
      timeBlocks: TIME_BLOCKS,
    })

    expect(preferences.map((p) => [p.labelKey, p.occurrence_id])).toEqual([
      ['swim', 'o-mon3'],
      ['archery', 'o-fri6'],
    ])
    expect(residue).toEqual([])
  })

  it('matches the camp’s OWN labels case- and spacing-insensitively', () => {
    // A camper writes "monday" and "period 3"; the camp calls them "Monday" and
    // "Period 3". Same recognition rule the rest of the ETL uses, not a second one.
    const { preferences, residue } = resolvePreferenceCoordinates({
      preferences: [pref(1, ' monday ', 'period 3', 'swim')],
      occurrences: OCCURRENCES,
      days: DAYS,
      timeBlocks: TIME_BLOCKS,
    })
    expect(preferences[0].occurrence_id).toBe('o-mon3')
    expect(residue).toEqual([])
  })

  it('a bare period NUMBER matches a period the camp calls "Period N"', () => {
    // The sheet's own column was headed "Period Number" and its cells hold "3".
    // The camp's time block is named "Period 3". Refusing to bind those would be
    // a coordinate lost to a naming convention.
    const { preferences } = resolvePreferenceCoordinates({
      preferences: [pref(1, 'Monday', '3', 'swim')],
      occurrences: OCCURRENCES,
      days: DAYS,
      timeBlocks: TIME_BLOCKS,
    })
    expect(preferences[0].occurrence_id).toBe('o-mon3')
  })

  it('a day this camp does not have is PROVABLY wrong, and is reported', () => {
    // ADR §11.2's domain check. The day set is KNOWN — electives are a schedule
    // inside an already-defined day — so a coordinate naming Sunday at a camp with
    // no Sunday is not ambiguous, it is wrong. Reported, never guessed at.
    const { preferences, residue } = resolvePreferenceCoordinates({
      preferences: [pref(1, 'Sunday', '3', 'swim')],
      occurrences: OCCURRENCES,
      days: DAYS,
      timeBlocks: TIME_BLOCKS,
    })
    expect(preferences[0].occurrence_id).toBeUndefined()
    expect(residue).toHaveLength(1)
    expect(residue[0].kind).toBe('COORDINATE_NOT_IN_CAMP')
    expect(residue[0].message).toMatch(/Sunday/)
  })

  it('a real cell this TEMPLATE does not offer is residue, not a silent drop', () => {
    // Monday Period 6 is a day this camp has and a period this camp has, but this
    // template places no elective cell there. The camper asked for a cell this
    // schedule does not have, which is information the director needs — and §13.2
    // says the answer is per-template, so the other candidate route may differ.
    const { preferences, residue } = resolvePreferenceCoordinates({
      preferences: [pref(1, 'Monday', 'Period 6', 'swim')],
      occurrences: OCCURRENCES,
      days: DAYS,
      timeBlocks: TIME_BLOCKS,
      templateId: 'tmpl-a',
    })
    expect(preferences[0].occurrence_id).toBeUndefined()
    expect(residue).toHaveLength(1)
    expect(residue[0].kind).toBe('COORDINATE_NOT_IN_TEMPLATE')
    expect(residue[0].templateId).toBe('tmpl-a')
  })

  it('leaves a preference that already names an occurrence exactly alone', () => {
    const already = { camper_id: 'cam-1', labelKey: 'swim', rank: 1, occurrence_id: 'o-fri6' }
    const { preferences, residue } = resolvePreferenceCoordinates({
      preferences: [already],
      occurrences: OCCURRENCES,
      days: DAYS,
      timeBlocks: TIME_BLOCKS,
    })
    expect(preferences[0].occurrence_id).toBe('o-fri6')
    expect(residue).toEqual([])
  })

  it('leaves a whole-run preference (no coordinate) unscoped', () => {
    // A flat ranked list legitimately has no cell. It must stay a fallback rather
    // than being bound to an arbitrary occurrence.
    const wholeRun = { camper_id: 'cam-1', labelKey: 'swim', rank: 1, coordinate: null }
    const { preferences, residue } = resolvePreferenceCoordinates({
      preferences: [wholeRun],
      occurrences: OCCURRENCES,
      days: DAYS,
      timeBlocks: TIME_BLOCKS,
    })
    expect(preferences[0].occurrence_id ?? null).toBeNull()
    expect(residue).toEqual([])
  })

  it('does not MUTATE the preferences it is given', () => {
    // The stored rows keep their coordinates and gain no occurrence_id: resolution
    // is in-memory and per-template, and writing a resolved occurrence back onto
    // the row would make one candidate route canonical, which CLAUDE.md forbids.
    const input = [pref(1, 'Monday', '3', 'swim')]
    resolvePreferenceCoordinates({
      preferences: input,
      occurrences: OCCURRENCES,
      days: DAYS,
      timeBlocks: TIME_BLOCKS,
    })
    expect(input[0].occurrence_id).toBeUndefined()
  })

  it('two templates disagreeing about one coordinate is reported PER TEMPLATE', () => {
    // §13.2: the coordinate set is per-template and two candidate routes may
    // disagree, and neither is canonical. So the same sheet against a template
    // that lacks the cell must say so, naming that template — not silently pick
    // the route that happens to work.
    const routeB = [{ id: 'o-b-mon3', day_id: 'd-mon', time_block_id: 'tb-3', tier_id: 't-1' }]
    const a = resolvePreferenceCoordinates({
      preferences: [pref(1, 'Friday', '6', 'archery')],
      occurrences: OCCURRENCES,
      days: DAYS,
      timeBlocks: TIME_BLOCKS,
      templateId: 'route-a',
    })
    const b = resolvePreferenceCoordinates({
      preferences: [pref(1, 'Friday', '6', 'archery')],
      occurrences: routeB,
      days: DAYS,
      timeBlocks: TIME_BLOCKS,
      templateId: 'route-b',
    })
    expect(a.preferences[0].occurrence_id).toBe('o-fri6')
    expect(a.residue).toEqual([])
    expect(b.preferences[0].occurrence_id).toBeUndefined()
    expect(b.residue[0].templateId).toBe('route-b')
  })
})

// Board item 9b — WHICH TIER'S OCCURRENCE AT A SHARED CELL.
//
// PRE-EXISTING, and tier-level. Occurrences are keyed on tier (deriveOccurrences)
// and `group_ids` is derived metadata — several groups of one tier share ONE
// occurrence — so there is no group axis to scope on here and #670 added none.
// What there is: a cell carrying two tiers' occurrences, where first-at-cell
// bound every camper outside the first tier to a FOREIGN occurrence.
//
// The consequence is not a mis-binding a director can see. `bestAt` in
// src/engine/buildElectiveAssignments.js reads
// `entry.byOccurrence.has(occurrenceId) ? entry.byOccurrence.get(...) : entry.fallback`,
// and a coordinate row bound to the foreign occurrence populates `byOccurrence`
// for THAT id and leaves `fallback` null. So at the camper's OWN occurrence the
// lookup misses, falls through to a null fallback, `rankAt` returns null, and
// the cost function substitutes UNRANKED_COST — seating them in something they
// did not ask for while their ranked answer sits in memory unread. The second
// test drives the real engine because the binding alone does not demonstrate
// that.
describe('binding a per-cell preference to the CAMPER\'S OWN tier', () => {
  const TWO_TIER_OCCURRENCES = [
    { id: 'o-jr-mon3', day_id: 'd-mon', time_block_id: 'tb-3', tier_id: 't-jr' },
    { id: 'o-sr-mon3', day_id: 'd-mon', time_block_id: 'tb-3', tier_id: 't-sr' },
  ]
  const coordinatePreference = (camperId) => ({
    camper_id: camperId, labelKey: 'swim', rank: 1, coordinate: { dayName: 'Monday', periodLabel: 'Period 3' },
  })

  it('binds a Seniors camper to the SENIORS occurrence, not the first one at the cell', () => {
    const { preferences, residue } = resolvePreferenceCoordinates({
      preferences: [coordinatePreference('cam-sr')],
      occurrences: TWO_TIER_OCCURRENCES,
      days: DAYS,
      timeBlocks: TIME_BLOCKS,
      tierIdByCamperId: { 'cam-sr': 't-sr' },
    })
    expect(preferences[0].occurrence_id).toBe('o-sr-mon3')
    expect(residue).toEqual([])
  })

  it('binds a Juniors camper at the same cell to the JUNIORS occurrence', () => {
    const { preferences } = resolvePreferenceCoordinates({
      preferences: [coordinatePreference('cam-jr')],
      occurrences: TWO_TIER_OCCURRENCES,
      days: DAYS,
      timeBlocks: TIME_BLOCKS,
      tierIdByCamperId: { 'cam-jr': 't-jr' },
    })
    expect(preferences[0].occurrence_id).toBe('o-jr-mon3')
  })

  it('falls back to the first occurrence at the cell when the tier is unknown', () => {
    // R1's shape, one layer down: a camper we cannot identify is not dropped.
    for (const tierIdByCamperId of [{}, { 'cam-x': null }, undefined]) {
      const { preferences } = resolvePreferenceCoordinates({
        preferences: [coordinatePreference('cam-x')],
        occurrences: TWO_TIER_OCCURRENCES,
        days: DAYS,
        timeBlocks: TIME_BLOCKS,
        tierIdByCamperId,
      })
      expect(preferences[0].occurrence_id).toBe('o-jr-mon3')
    }
  })

  it('a tier with no occurrence at that cell falls back rather than binding nothing', () => {
    const { preferences } = resolvePreferenceCoordinates({
      preferences: [coordinatePreference('cam-mid')],
      occurrences: TWO_TIER_OCCURRENCES,
      days: DAYS,
      timeBlocks: TIME_BLOCKS,
      tierIdByCamperId: { 'cam-mid': 't-middles' },
    })
    expect(preferences[0].occurrence_id).toBe('o-jr-mon3')
  })
})

// THE OBSERVABLE CONSEQUENCE, driven through the real engine. The binding
// assertions above are necessary and not sufficient: what a director sees is a
// rank being honoured or not.
describe('the engine reads back the rank only at the occurrence the coordinate bound to', () => {
  const OCCS = [
    { id: 'o-jr-mon3', day_id: 'd-mon', time_block_id: 'tb-3', tier_id: 't-jr' },
    { id: 'o-sr-mon3', day_id: 'd-mon', time_block_id: 'tb-3', tier_id: 't-sr' },
  ]
  const OFFERINGS = OCCS.flatMap((o) => [
    { occurrence_id: o.id, labelKey: 'swim', activity_id: 'act-swim', capacity: 99, minimum: null },
    { occurrence_id: o.id, labelKey: 'archery', activity_id: 'act-archery', capacity: 99, minimum: null },
  ])

  const solveWith = (tierIdByCamperId) => {
    const { preferences } = resolvePreferenceCoordinates({
      preferences: [{
        camper_id: 'cam-sr', labelKey: 'swim', rank: 1,
        coordinate: { dayName: 'Monday', periodLabel: 'Period 3' },
      }],
      occurrences: OCCS, days: DAYS, timeBlocks: TIME_BLOCKS, tierIdByCamperId,
    })
    return buildElectiveAssignments({
      campers: [{ id: 'cam-sr', display_name: 'Noa Katz' }],
      occurrences: OCCS,
      offerings: OFFERINGS,
      preferences,
      // The camper attends only their OWN tier's occurrence, which is what
      // buildAttendance produces for them.
      attendance: { 'cam-sr': ['o-sr-mon3'] },
    })
  }

  it("honours the rank at the camper's own occurrence when the tier is known", () => {
    const { assignments } = solveWith({ 'cam-sr': 't-sr' })
    const seat = assignments.find((a) => a.camper_id === 'cam-sr' && a.occurrence_id === 'o-sr-mon3')
    expect(seat.preference_rank).toBe(1)
    expect(seat.activity_id).toBe('act-swim')
  })

  it('reports NO rank at all when the coordinate bound to the other tier — the silent loss', () => {
    // Drives the pre-fix behaviour by withholding the tier, which is exactly
    // what the caller did before this parameter existed.
    const { assignments } = solveWith({})
    const seat = assignments.find((a) => a.camper_id === 'cam-sr' && a.occurrence_id === 'o-sr-mon3')
    expect(seat.preference_rank).toBeNull()
  })
})
