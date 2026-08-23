import { describe, it, expect } from 'vitest'
import { fetchCensusSnapshot } from './existingSnapshot.js'
import { CHILD_OF, DOMAIN_OF } from '../components/reconciliation/domainRollup.js'

function fakeList(byEntity) {
  return async (entity) => byEntity[entity] ?? []
}

describe('fetchCensusSnapshot', () => {
  it('returns the CHILD_OF/DOMAIN_OF keys plus the Context-only key (Slice 3) — the R1 regression test', async () => {
    const snapshot = await fetchCensusSnapshot(fakeList({}))
    const expectedKeys = [...Object.keys(CHILD_OF), 'field_trips'].sort()
    expect(Object.keys(snapshot).sort()).toEqual(expectedKeys)
    expect(Object.keys(snapshot).sort()).toEqual([...Object.keys(DOMAIN_OF), 'field_trips'].sort())
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

  // ── Context wiring (Slice 3, docs/adr/2026-08-19-roots-census-and-persistent-inspector.md §(e)/(g)) ──

  it('field_trips is filtered to PRESET_STAMPS-labeled template_overlays rows only', async () => {
    const snapshot = await fetchCensusSnapshot(fakeList({
      template_overlays: [
        { id: 'o1', label: 'Field Trip', template_id: 't1', day_id: null },
        { id: 'o2', label: 'Special Event', template_id: 't1', day_id: null },
        { id: 'o3', label: 'Service Project', template_id: 't1', day_id: null },
        { id: 'o4', label: 'Not A Stamp', template_id: 't1', day_id: null },
      ],
    }))
    expect(snapshot.field_trips.map((r) => r.id).sort()).toEqual(['o1', 'o2', 'o3'])
  })

  it('field_trips rows carry the day name in their display name when the overlay has a day_id', async () => {
    const snapshot = await fetchCensusSnapshot(fakeList({
      days_of_operation: [{ id: 'd1', label: 'Monday' }],
      template_overlays: [{ id: 'o1', label: 'Field Trip', template_id: 't1', day_id: 'd1' }],
    }))
    expect(snapshot.field_trips[0].name).toBe('Field Trip — Monday')
  })

  it('field_trips rows resolve their route from the overlay\'s template_id -> schedule_templates.kind', async () => {
    const snapshot = await fetchCensusSnapshot(fakeList({
      schedule_templates: [{ id: 't1', kind: 'manual' }, { id: 't2', kind: 'generated' }],
      template_overlays: [
        { id: 'o1', label: 'Field Trip', template_id: 't1', day_id: null },
        { id: 'o2', label: 'Field Trip', template_id: 't2', day_id: null },
      ],
    }))
    expect(snapshot.field_trips.find((r) => r.id === 'o1').route).toBe('schedule:manual')
    expect(snapshot.field_trips.find((r) => r.id === 'o2').route).toBe('schedule:generated')
  })

  it('field_trips is null (not []) when the template_overlays fetch itself fails', async () => {
    const list = async (entity) => { if (entity === 'template_overlays') throw new Error('boom'); return [] }
    const snapshot = await fetchCensusSnapshot(list)
    expect(snapshot.field_trips).toBeNull()
  })

})
