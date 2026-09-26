import { describe, it, expect } from 'vitest'
import { buildRunSummaryExport } from './exportRunSummary.js'

describe('buildRunSummaryExport', () => {
  it('counts assignments by preference rank received', () => {
    const result = buildRunSummaryExport({
      run: { id: 'run-1', name: 'Week 1', status: 'final', solver_generation: 'gen-1', source_sha256: 'abc123' },
      assignments: [
        { camper_id: 'c1', preference_rank: 1 },
        { camper_id: 'c2', preference_rank: 1 },
        { camper_id: 'c3', preference_rank: 2 },
      ],
      preferences: [{ camper_id: 'c1' }, { camper_id: 'c2' }, { camper_id: 'c3' }, { camper_id: 'c4' }],
      capacityRows: [],
    })

    expect(result.counts_by_rank).toEqual({ 1: 2, 2: 1 })
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
})
