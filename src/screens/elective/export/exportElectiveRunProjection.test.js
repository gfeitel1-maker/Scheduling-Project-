// T197 (docs/adr/2026-09-26-elective-run-outer-inheritance-and-linked-choice-export.md, Governor
// ruling on Open Question 3): ONE combined projection document, format_version: 1 — child
// schedules, activity rosters, exceptions, summary all generated from one assignment run so the
// "roster counts equal summary counts" exit clause is checkable inside a single document.
import { describe, it, expect } from 'vitest'
import { buildElectiveRunProjectionExport } from './exportElectiveRunProjection.js'

function fixture() {
  const run = { id: 'run-1', name: 'Week 1', status: 'final', solver_generation: 'gen-1', source_sha256: 'abc' }
  const campers = [{ id: 'c1', display_name: 'Camper A', group_id: 'g1' }, { id: 'c2', display_name: 'Camper B', group_id: 'g1' }]
  const groups = [{ id: 'g1', name: 'Bunk Alpha' }]
  const days = [{ id: 'd1', name: 'Monday' }]
  const timeBlocks = [{ id: 't1', name: 'Period 1' }]
  // No camperName/groupId here — the real outer row (electron/main.js
  // getElectiveRunOuterScheduleHandler) never carries them; camper/group identity is resolved
  // from `campers`/`groups` (F1, round 2).
  const outerRows = [
    { camperId: 'c1', dayId: 'd1', timeBlockId: 't1', cellKind: 'elective', activityId: 'a1', activityName: 'Archery', spanBlocks: 1, isLinkedChoice: false },
    { camperId: 'c2', dayId: 'd1', timeBlockId: 't1', cellKind: 'elective', activityId: 'a1', activityName: 'Archery', spanBlocks: 1, isLinkedChoice: false },
  ]
  // T318 (c4) — occurrence_id on both the assignment and the preference, plus
  // rank_kind: 'cell-choice', so buildRunSummaryExport's join finds a positively
  // ordered preference for each row and the exit-clause counts below keep
  // matching. Without this the safe default would move both into
  // unordered_count instead of counts_by_rank.
  const preferences = [
    { camper_id: 'c1', choice_id: 'ch1', occurrence_id: 'occ-1', rank: 1, rank_kind: 'cell-choice' },
    { camper_id: 'c2', choice_id: 'ch1', occurrence_id: 'occ-1', rank: 1, rank_kind: 'cell-choice' },
  ]
  const assignments = [
    { camper_id: 'c1', choice_id: 'ch1', occurrence_id: 'occ-1', preference_rank: 1 },
    { camper_id: 'c2', choice_id: 'ch1', occurrence_id: 'occ-1', preference_rank: 1 },
  ]
  const occurrences = [{ id: 'occ-1', day_id: 'd1', time_block_id: 't1' }]
  return { run, campers, groups, days, timeBlocks, outerRows, preferences, assignments, occurrences }
}

describe('buildElectiveRunProjectionExport', () => {
  it('bundles all four sections under format_version: 2', () => {
    const fx = fixture()
    const result = buildElectiveRunProjectionExport({ ...fx, staleCount: 0, capacityRows: [], generatedAt: '2026-09-26T00:00:00.000Z' })

    // T318 (c4) bumped format_version 1 -> 2 for the added summary.unordered_count
    // field, the same precedent exportChildSchedule.js used for its own added-field bump.
    expect(result.format_version).toBe(2)
    expect(result.generated_at).toBe('2026-09-26T00:00:00.000Z')
    expect(result.child_schedules.campers).toHaveLength(2)
    expect(result.activity_rosters).toHaveLength(1)
    expect(result.exceptions).toMatchObject({ unassigned: [], unranked: [], unresolved: [] })
    expect(result.summary.run_id).toBe('run-1')
  })

  it('exit clause: activity roster ROW count (count field, assignment grain) equals summary assigned-count', () => {
    const fx = fixture()
    const result = buildElectiveRunProjectionExport({ ...fx, staleCount: 0, capacityRows: [], generatedAt: 'x' })

    const rosterRowCount = result.activity_rosters.reduce((sum, r) => sum + r.count, 0)
    const summaryAssignedCount = Object.values(result.summary.counts_by_rank).reduce((a, b) => a + b, 0)
    expect(rosterRowCount).toBe(summaryAssignedCount)
    expect(rosterRowCount).toBe(2)
  })

  // F5 (round 2): the roster clusters a linked choice's occurrences into ONE presentation row per
  // camper (members.length), which is a DIFFERENT grain than the summary's per-assignment-row
  // counts_by_rank — a linked choice with 2 occurrences and 1 camper would show members.length: 1
  // against counts_by_rank total: 2, and the two could never reconcile. `count` (not
  // members.length) is the assignment grain and must match.
  it('exit clause holds with a LINKED CHOICE in the fixture: roster count equals summary count at assignment grain', () => {
    const run = { id: 'run-1', name: 'Week 1', status: 'final', solver_generation: 'gen-1', source_sha256: 'abc' }
    const campers = [{ id: 'c1', display_name: 'Camper A', group_id: 'g1' }]
    const groups = [{ id: 'g1', name: 'Bunk Alpha' }]
    const days = [{ id: 'd1', name: 'Monday' }]
    const timeBlocks = [{ id: 't1', name: 'Period 1' }, { id: 't2', name: 'Period 2' }]
    // ONE camper, ONE linked choice spanning TWO occurrences (member rows) — the roster clusters
    // these into a single presentation row, but the underlying assignment grain is 2.
    const outerRows = [
      { camperId: 'c1', dayId: 'd1', timeBlockId: 't1', cellKind: 'elective', activityId: 'a1', activityName: 'Archery', spanBlocks: 1, isLinkedChoice: true, choiceId: 'ch1', choiceLabel: 'Bundle' },
      { camperId: 'c1', dayId: 'd1', timeBlockId: 't2', cellKind: 'elective', activityId: 'a2', activityName: 'Canoeing', spanBlocks: 1, isLinkedChoice: true, choiceId: 'ch1', choiceLabel: 'Bundle' },
    ]
    // occurrence_id: null (a whole-run fallback row) so BOTH linked occurrences
    // resolve to this one preference via the lookup's second, run-wide key arm.
    const preferences = [{ camper_id: 'c1', choice_id: 'ch1', occurrence_id: null, rank: 1, rank_kind: 'cell-choice' }]
    const assignments = [
      { camper_id: 'c1', choice_id: 'ch1', occurrence_id: 'occ-1', preference_rank: 1 },
      { camper_id: 'c1', choice_id: 'ch1', occurrence_id: 'occ-2', preference_rank: 1 },
    ]
    const occurrences = [
      { id: 'occ-1', day_id: 'd1', time_block_id: 't1' },
      { id: 'occ-2', day_id: 'd1', time_block_id: 't2' },
    ]

    const result = buildElectiveRunProjectionExport({
      run, campers, groups, days, timeBlocks, outerRows, preferences, assignments, occurrences,
      staleCount: 0, capacityRows: [], generatedAt: 'x',
    })

    expect(result.activity_rosters).toHaveLength(1)
    const rosterRowCount = result.activity_rosters.reduce((sum, r) => sum + r.count, 0)
    const summaryAssignedCount = Object.values(result.summary.counts_by_rank).reduce((a, b) => a + b, 0)
    expect(rosterRowCount).toBe(2)
    expect(summaryAssignedCount).toBe(2)
    expect(rosterRowCount).toBe(summaryAssignedCount)
  })

  // T318 (c4) — threads an unordered-set preference through the whole
  // projection and confirms the summary carries the new field.
  it('threads an unordered-set preference through to summary.unordered_count', () => {
    const fx = fixture()
    fx.preferences = [
      { camper_id: 'c1', choice_id: 'ch1', occurrence_id: 'occ-1', rank: 1, rank_kind: 'unordered-set' },
      { camper_id: 'c2', choice_id: 'ch1', occurrence_id: 'occ-1', rank: 1, rank_kind: 'cell-choice' },
    ]
    const result = buildElectiveRunProjectionExport({ ...fx, staleCount: 0, capacityRows: [], generatedAt: 'x' })

    expect(result.summary.unordered_count).toBe(1)
    expect(result.summary.counts_by_rank).toEqual({ 1: 1 })
  })

  // T318 (c5) — a residual the owner already ruled on rather than asked to fix:
  // FinalRunView's export input passes `occurrences: templateOccurrences`, empty
  // on a reopened run. This pins the owner's analysis: with `occurrences: []`, a
  // COORDINATE-ONLY preference (occurrence_id null — the shape a per-cell sheet
  // has before any template resolves it) simply keeps occurrence_id null, lands
  // under the whole-run key, and the lookup's second arm still hits — so an
  // empty occurrence list does not misclassify a genuinely ordered preference as
  // unordered.
  it('c5 — an empty occurrences list does not misclassify a coordinate-only ordered preference as unordered', () => {
    const fx = fixture()
    fx.occurrences = []
    fx.preferences = [
      { camper_id: 'c1', choice_id: 'ch1', occurrence_id: null, coordinate: { dayName: 'Monday', periodLabel: 'Period 1' }, rank: 1, rank_kind: 'cell-choice' },
      { camper_id: 'c2', choice_id: 'ch1', occurrence_id: null, coordinate: { dayName: 'Monday', periodLabel: 'Period 1' }, rank: 1, rank_kind: 'cell-choice' },
    ]
    const result = buildElectiveRunProjectionExport({ ...fx, staleCount: 0, capacityRows: [], generatedAt: 'x' })

    expect(result.summary.unordered_count).toBe(0)
    expect(result.summary.counts_by_rank).toEqual({ 1: 2 })
  })
})
