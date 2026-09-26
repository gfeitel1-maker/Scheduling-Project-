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
  const preferences = [{ camper_id: 'c1', choice_id: 'ch1' }, { camper_id: 'c2', choice_id: 'ch1' }]
  const assignments = [{ camper_id: 'c1', occurrence_id: 'occ-1', preference_rank: 1 }, { camper_id: 'c2', occurrence_id: 'occ-1', preference_rank: 1 }]
  const occurrences = [{ id: 'occ-1', day_id: 'd1', time_block_id: 't1' }]
  return { run, campers, groups, days, timeBlocks, outerRows, preferences, assignments, occurrences }
}

describe('buildElectiveRunProjectionExport', () => {
  it('bundles all four sections under format_version: 1', () => {
    const fx = fixture()
    const result = buildElectiveRunProjectionExport({ ...fx, staleCount: 0, capacityRows: [], generatedAt: '2026-09-26T00:00:00.000Z' })

    expect(result.format_version).toBe(1)
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
    const preferences = [{ camper_id: 'c1', choice_id: 'ch1' }]
    const assignments = [
      { camper_id: 'c1', occurrence_id: 'occ-1', preference_rank: 1 },
      { camper_id: 'c1', occurrence_id: 'occ-2', preference_rank: 1 },
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
})
