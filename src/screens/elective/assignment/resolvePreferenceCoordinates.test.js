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
