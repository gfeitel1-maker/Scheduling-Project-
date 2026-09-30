import { describe, it, expect } from 'vitest'
import { buildRunSummaryExport } from './exportRunSummary.js'

describe('buildRunSummaryExport', () => {
  it('counts assignments by preference rank received', () => {
    // T318 (c4) — the join needs choice_id/occurrence_id to find each
    // assignment's preference row, so this fixture is enriched with matching
    // ids and an explicit rank_kind: 'cell-choice' (genuine ordering), rather
    // than the bare { camper_id, preference_rank } shape the pre-T318 fixture
    // used. Without that evidence the safe default would move these into
    // unordered_count instead — see the dedicated unordered-set test below.
    const result = buildRunSummaryExport({
      run: { id: 'run-1', name: 'Week 1', status: 'final', solver_generation: 'gen-1', source_sha256: 'abc123' },
      assignments: [
        { camper_id: 'c1', choice_id: 'ch-1', occurrence_id: 'occ-1', preference_rank: 1 },
        { camper_id: 'c2', choice_id: 'ch-2', occurrence_id: 'occ-1', preference_rank: 1 },
        { camper_id: 'c3', choice_id: 'ch-3', occurrence_id: 'occ-1', preference_rank: 2 },
      ],
      preferences: [
        { camper_id: 'c1', choice_id: 'ch-1', occurrence_id: 'occ-1', rank: 1, rank_kind: 'cell-choice' },
        { camper_id: 'c2', choice_id: 'ch-2', occurrence_id: 'occ-1', rank: 1, rank_kind: 'cell-choice' },
        { camper_id: 'c3', choice_id: 'ch-3', occurrence_id: 'occ-1', rank: 2, rank_kind: 'cell-choice' },
        { camper_id: 'c4' },
      ],
      capacityRows: [],
    })

    expect(result.counts_by_rank).toEqual({ 1: 2, 2: 1 })
    expect(result.unordered_count).toBe(0)
  })

  // T318 (c4) — a camper whose sheet was read as an unordered set still carries
  // a real integer rank (a tie among equals, never a ranking). That rank must
  // not reach the exported Rank N buckets, which is exactly what the paper
  // Summary sheet renders as "Rank N: count".
  it('excludes an unordered-set assignment from counts_by_rank and reports it separately', () => {
    const result = buildRunSummaryExport({
      run: { id: 'run-1', name: 'Week 1', status: 'final' },
      assignments: [{ camper_id: 'c1', choice_id: 'ch-1', occurrence_id: 'occ-1', preference_rank: 2 }],
      preferences: [{ camper_id: 'c1', choice_id: 'ch-1', occurrence_id: 'occ-1', rank: 2, rank_kind: 'unordered-set' }],
      capacityRows: [],
    })

    expect(result.counts_by_rank).toEqual({})
    expect(result.unordered_count).toBe(1)
  })

  it('counts campers with preferences but no assignment as unassigned', () => {
    const result = buildRunSummaryExport({
      run: { id: 'run-1', name: 'Week 1', status: 'draft' },
      assignments: [{ camper_id: 'c1', preference_rank: 1 }],
      preferences: [{ camper_id: 'c1' }, { camper_id: 'c2' }],
      capacityRows: [],
    })

    expect(result.unassigned_count).toBe(1)
  })

  it('reports fill by offering from capacityRows', () => {
    const result = buildRunSummaryExport({
      run: { id: 'run-1', name: 'Week 1', status: 'draft' },
      assignments: [], preferences: [],
      capacityRows: [{ occurrenceId: 'occ-1', activityId: 'a1', filled: 3, capacity: 5 }],
    })

    expect(result.fill_by_offering).toEqual([{ occurrence_id: 'occ-1', activity_id: 'a1', filled: 3, capacity: 5 }])
  })

  it('carries run identity and source hash', () => {
    const result = buildRunSummaryExport({
      run: { id: 'run-1', name: 'Week 1', status: 'final', solver_generation: 'gen-1', source_sha256: 'abc123' },
      assignments: [], preferences: [], capacityRows: [],
    })

    expect(result).toMatchObject({
      run_id: 'run-1', run_name: 'Week 1', run_status: 'final',
      solver_generation: 'gen-1', source_hash: 'abc123',
    })
  })

  // T320 round 2, F3 — no live caller invokes this builder directly today,
  // but the ADR names it as one of the guarded builders, so a latent gap
  // here is still a gap the moment a caller is added.
  it('refuses a finalized run whose outer snapshot is incomplete, instead of a complete-looking summary', () => {
    const result = buildRunSummaryExport({
      run: { id: 'run-1', name: 'Week 1', status: 'final', snapshotIncomplete: true, expectedSnapshotRows: 10, heldSnapshotRows: 4 },
      assignments: [], preferences: [], capacityRows: [],
    })
    expect(result).toEqual({ ok: false, error: 'SNAPSHOT_INCOMPLETE', expectedSnapshotRows: 10, heldSnapshotRows: 4 })
  })
})
