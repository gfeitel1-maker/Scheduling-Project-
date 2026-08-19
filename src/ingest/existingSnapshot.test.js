import { describe, it, expect } from 'vitest'
import { fetchCensusSnapshot } from './existingSnapshot.js'
import { CHILD_OF, DOMAIN_OF } from '../components/reconciliation/domainRollup.js'

function fakeList(byEntity) {
  return async (entity) => byEntity[entity] ?? []
}

describe('fetchCensusSnapshot', () => {
  it('returns exactly the keys CHILD_OF/DOMAIN_OF use — the R1 regression test', async () => {
    const snapshot = await fetchCensusSnapshot(fakeList({}))
    expect(Object.keys(snapshot).sort()).toEqual(Object.keys(CHILD_OF).sort())
    expect(Object.keys(snapshot).sort()).toEqual(Object.keys(DOMAIN_OF).sort())
  })

  it('normalizes days_of_operation rows to a .name field from their .label column', async () => {
    const snapshot = await fetchCensusSnapshot(fakeList({
      days_of_operation: [{ id: 'd1', label: 'Monday' }],
    }))
    expect(snapshot.days_of_operation[0].name).toBe('Monday')
  })

  it('passes through other entities with an existing .name column unchanged', async () => {
    const snapshot = await fetchCensusSnapshot(fakeList({
      groups: [{ id: 'g1', name: 'Shoresh', tier_id: 't1' }],
    }))
    expect(snapshot.groups[0]).toEqual({ id: 'g1', name: 'Shoresh', tier_id: 't1' })
  })

  it('marks a rejected list() call as null (fetch-failed), distinct from a genuinely empty table', async () => {
    const list = async (entity) => { if (entity === 'activities') throw new Error('boom'); return [] }
    const snapshot = await fetchCensusSnapshot(list)
    expect(snapshot.activities).toBeNull()
    expect(snapshot.groups).toEqual([])
  })

  it('fetches all entities in parallel, not serially', async () => {
    let concurrentCalls = 0
    let maxConcurrent = 0
    const list = async () => {
      concurrentCalls++
      maxConcurrent = Math.max(maxConcurrent, concurrentCalls)
      await Promise.resolve()
      concurrentCalls--
      return []
    }
    await fetchCensusSnapshot(list)
    expect(maxConcurrent).toBeGreaterThan(1)
  })
})
