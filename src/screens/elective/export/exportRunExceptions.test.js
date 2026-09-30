import { describe, it, expect } from 'vitest'
import { buildRunExceptionsExport } from './exportRunExceptions.js'

describe('buildRunExceptionsExport', () => {
  it('flags a camper with preferences but zero assignments as unassigned', () => {
    const result = buildRunExceptionsExport({
      campers: [{ id: 'c1', display_name: 'Camper A' }],
      preferences: [{ camper_id: 'c1', choice_id: 'ch1', rank: 1 }],
      assignments: [],
      occurrences: [],
      staleCount: 0,
      capacityRows: [],
    })

    expect(result.unassigned).toEqual([{ camper_id: 'c1', camper_name: 'Camper A' }])
  })

  it('flags a camper with zero preferences as unranked', () => {
    const result = buildRunExceptionsExport({
      campers: [{ id: 'c1', display_name: 'Camper A' }],
      preferences: [],
      assignments: [],
      occurrences: [],
      staleCount: 0,
      capacityRows: [],
    })

    expect(result.unranked).toEqual([{ camper_id: 'c1', camper_name: 'Camper A' }])
  })

  it('flags an occurrence with zero assignments as unresolved', () => {
    const result = buildRunExceptionsExport({
      campers: [],
      preferences: [],
      assignments: [],
      occurrences: [{ id: 'occ-1', day_id: 'd1', time_block_id: 't1' }],
      staleCount: 0,
      capacityRows: [],
    })

    expect(result.unresolved).toEqual([{ occurrence_id: 'occ-1' }])
  })

  it('reports the given staleCount verbatim', () => {
    const result = buildRunExceptionsExport({
      campers: [], preferences: [], assignments: [], occurrences: [], staleCount: 4, capacityRows: [],
    })
    expect(result.stale).toBe(4)
  })

  it('flags an occurrence whose filled count exceeds its capacity', () => {
    const result = buildRunExceptionsExport({
      campers: [], preferences: [], assignments: [], occurrences: [],
      staleCount: 0,
      capacityRows: [{ occurrenceId: 'occ-1', activityId: 'a1', filled: 7, capacity: 5 }],
    })
    expect(result.capacity).toEqual([{ occurrence_id: 'occ-1', activity_id: 'a1', filled: 7, capacity: 5 }])
  })

  it('emits eligibility and resource as empty buckets when the caller passes no findings', () => {
    const result = buildRunExceptionsExport({ campers: [], preferences: [], assignments: [], occurrences: [], staleCount: 0, capacityRows: [] })
    expect(result.eligibility).toEqual([])
    expect(result.resource).toEqual([])
  })

  // T320 (docs/adr/2026-09-30-elective-run-durability.md item 4) — UPDATED to
  // assert the NEW truth: both categories are now genuinely computed
  // (persisted eligibility findings, live-computed resource conflicts), so
  // not_computed is always [], never ['eligibility', 'resource'].
  it('never marks eligibility/resource as not_computed — both are now genuinely computed', () => {
    const result = buildRunExceptionsExport({ campers: [], preferences: [], assignments: [], occurrences: [], staleCount: 0, capacityRows: [] })
    expect(result.not_computed).toEqual([])
  })

  it('does NOT mark unassigned/unranked/unresolved/capacity as not_computed — those ARE discharged from real data', () => {
    const result = buildRunExceptionsExport({ campers: [], preferences: [], assignments: [], occurrences: [], staleCount: 0, capacityRows: [] })
    expect(result.not_computed).not.toContain('unassigned')
    expect(result.not_computed).not.toContain('unranked')
    expect(result.not_computed).not.toContain('unresolved')
    expect(result.not_computed).not.toContain('capacity')
  })

  it('a camper with both a preference AND an assignment is neither unassigned nor unranked', () => {
    const result = buildRunExceptionsExport({
      campers: [{ id: 'c1', display_name: 'Camper A' }],
      preferences: [{ camper_id: 'c1', choice_id: 'ch1', rank: 1 }],
      assignments: [{ camper_id: 'c1', occurrence_id: 'occ-1' }],
      occurrences: [{ id: 'occ-1', day_id: 'd1', time_block_id: 't1' }],
      staleCount: 0,
      capacityRows: [],
    })
    expect(result.unassigned).toEqual([])
    expect(result.unranked).toEqual([])
    expect(result.unresolved).toEqual([])
  })
})
