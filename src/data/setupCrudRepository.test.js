// Drives the persistence seam with a FAKE localClient (a plain object that
// captures every call) — no React render, no Electron. Mirrors
// scheduleRepository.test.js's fake-collaborator style.
import { describe, it, expect, vi } from 'vitest'
import { createSetupCrudRepository, UNIQUE_FIRST_FIELD, REQUIRED_FIRST_ON_WRITE, orderFieldsForWrite } from './setupCrudRepository'

function makeFakeClient({ writeResult = { status: 'applied' }, deleteResult = { status: 'applied' } } = {}) {
  const calls = { write: [], deleteEntity: [] }
  return {
    calls,
    write: vi.fn((token, entity, id, field, value) => {
      calls.write.push([token, entity, id, field, value])
      return Promise.resolve(writeResult)
    }),
    deleteEntity: vi.fn((token, entity, id) => {
      calls.deleteEntity.push([token, entity, id])
      return Promise.resolve(deleteResult)
    }),
  }
}

const getToken = () => 'tok'

describe('createSetupCrudRepository — writeFields', () => {
  it('writes one field at a time, in insertion order', async () => {
    const client = makeFakeClient()
    const repo = createSetupCrudRepository({ localClient: client, getToken })
    await repo.writeFields('days_of_operation', 'd1', { label: 'Monday', sort_order: 1 })
    expect(client.calls.write.map((c) => c[3])).toEqual(['label', 'sort_order'])
    expect(client.calls.write[0][0]).toBe('tok')
  })

  it('throws on the first non-applied/queued result and does not continue to later fields', async () => {
    const client = makeFakeClient()
    client.write.mockImplementationOnce((token, entity, id, field, value) => {
      client.calls.write.push([token, entity, id, field, value])
      return Promise.resolve({ status: 'rejected' })
    })
    const repo = createSetupCrudRepository({ localClient: client, getToken })
    await expect(repo.writeFields('days_of_operation', 'd1', { label: 'X', sort_order: 1 })).rejects.toThrow(
      /write failed for field "label"/
    )
    expect(client.calls.write).toHaveLength(1)
  })

  it('defaults getToken to reading shoresh-token from localStorage', async () => {
    vi.stubGlobal('localStorage', { getItem: vi.fn(() => 'ls-token') })
    const client = makeFakeClient()
    const repo = createSetupCrudRepository({ localClient: client })
    await repo.writeFields('days_of_operation', 'd1', { label: 'X' })
    expect(globalThis.localStorage.getItem).toHaveBeenCalledWith('shoresh-token')
    expect(client.calls.write[0][0]).toBe('ls-token')
  })
})

// Fixed vs Recurring events (docs/adr/2026-08-28-fixed-vs-recurring-events.md
// §3, Red Hat HIGH): anchor_activities.kind must always be written FIRST,
// automatically, for every caller — not remembered at each call site. This is
// the fast JS-level test for the reordering mechanism itself; see
// electron/anchorKindWriteOrder.integration.test.js for the REAL-SQLite
// proof that the reordered write actually satisfies the CHECK constraint.
describe('orderFieldsForWrite / REQUIRED_FIRST_ON_WRITE', () => {
  it('registers anchor_activities -> kind', () => {
    expect(REQUIRED_FIRST_ON_WRITE.anchor_activities).toBe('kind')
  })

  it('moves the registered field to the front regardless of caller order', () => {
    const ordered = orderFieldsForWrite('anchor_activities', {
      name: 'Lunch', is_all_groups: false, group_ids: '["g1"]', kind: 'recurring', notes: null,
    })
    expect(ordered.map(([field]) => field)).toEqual(['kind', 'name', 'is_all_groups', 'group_ids', 'notes'])
  })

  it('is a no-op when the registered field is absent from this particular write', () => {
    const ordered = orderFieldsForWrite('anchor_activities', { notes: 'updated' })
    expect(ordered.map(([field]) => field)).toEqual(['notes'])
  })

  it('is a no-op for an entity not registered in REQUIRED_FIRST_ON_WRITE', () => {
    const ordered = orderFieldsForWrite('days_of_operation', { sort_order: 1, label: 'Monday' })
    expect(ordered.map(([field]) => field)).toEqual(['sort_order', 'label'])
  })

  it('writeFields writes kind first even when the caller built the object with kind last (the exact shape the XLSX import bug had)', async () => {
    const client = makeFakeClient()
    const repo = createSetupCrudRepository({ localClient: client, getToken })
    await repo.writeFields('anchor_activities', 'a1', {
      name: 'Lunch A', day_id: 'd1', time_block_id: 'b1', is_all_groups: false, group_ids: '["g1"]', kind: 'recurring', notes: null,
    })
    expect(client.calls.write.map((c) => c[3])).toEqual([
      'kind', 'name', 'day_id', 'time_block_id', 'is_all_groups', 'group_ids', 'notes',
    ])
  })
})

describe('createSetupCrudRepository — createRecord', () => {
  it('writes ordered fields, no cleanup on success', async () => {
    const client = makeFakeClient()
    const repo = createSetupCrudRepository({ localClient: client, getToken })
    await repo.createRecord('days_of_operation', 'd1', { label: 'Monday', sort_order: 1 })
    expect(client.calls.write.map((c) => c[3])).toEqual(['label', 'sort_order'])
    expect(client.calls.deleteEntity).toHaveLength(0)
  })

  it('best-effort deletes the partial row on failure, then rethrows the ORIGINAL error', async () => {
    const client = makeFakeClient()
    client.write.mockImplementation((token, entity, id, field, value) => {
      client.calls.write.push([token, entity, id, field, value])
      return Promise.resolve(field === 'sort_order' ? { status: 'rejected' } : { status: 'applied' })
    })
    const repo = createSetupCrudRepository({ localClient: client, getToken })
    await expect(
      repo.createRecord('days_of_operation', 'd1', { label: 'Monday', sort_order: 1 })
    ).rejects.toThrow(/write failed for field "sort_order"/)
    expect(client.calls.deleteEntity).toEqual([['tok', 'days_of_operation', 'd1']])
  })

  it('swallows a cleanup failure — does not mask the original error or throw a second exception', async () => {
    const client = makeFakeClient()
    client.write.mockResolvedValue({ status: 'rejected' })
    client.deleteEntity.mockRejectedValue(new Error('cleanup boom'))
    const repo = createSetupCrudRepository({ localClient: client, getToken })
    await expect(repo.createRecord('days_of_operation', 'd1', { label: 'Monday' })).rejects.toThrow(
      /write failed for field "label"/
    )
  })

  it('a locations UNIQUE-collision rejected write (D3 shape: status+reason+existing) throws and stops before later fields — zero setupCrudRepository changes needed (docs/adr/2026-08-15-locations-concurrent-create-collision.md T5)', async () => {
    const client = makeFakeClient()
    client.write.mockImplementationOnce((token, entity, id, field, value) => {
      client.calls.write.push([token, entity, id, field, value])
      return Promise.resolve({
        status: 'rejected',
        reason: 'unique_field',
        existing: { id: 'loc-existing', name: 'Pool', capacity: 2, notes: null },
      })
    })
    const repo = createSetupCrudRepository({ localClient: client, getToken })
    await expect(
      repo.createRecord('locations', 'loc-new', { name: 'Pool', camp_id: 'camp-1', capacity: 1, notes: null })
    ).rejects.toThrow(/write failed for field "name"/)
    // Stopped after the first (name) write — camp_id/capacity/notes never sent.
    expect(client.calls.write).toHaveLength(1)
    // Best-effort cleanup still fires (createRecord's existing contract).
    expect(client.calls.deleteEntity).toEqual([['tok', 'locations', 'loc-new']])
  })

  // T9 (docs/adr/2026-08-15-locations-concurrent-create-collision.md
  // addendum, Decision B): a programmer-error guard, not a user-facing path.
  it('UNIQUE_FIRST_FIELD guard: throws synchronously, before any write, when the registered unique field is not first', async () => {
    expect(UNIQUE_FIRST_FIELD.locations).toBe('name')
    const client = makeFakeClient()
    const repo = createSetupCrudRepository({ localClient: client, getToken })
    await expect(
      repo.createRecord('locations', 'loc-new', { camp_id: 'camp-1', name: 'Pool', capacity: 1 })
    ).rejects.toThrow(/"name" must be the first field — got "camp_id"/)
    // Zero writes and zero cleanup attempts — the guard fires before
    // writeFields is ever called, so nothing was created to clean up.
    expect(client.calls.write).toHaveLength(0)
    expect(client.calls.deleteEntity).toHaveLength(0)
  })

  it('UNIQUE_FIRST_FIELD guard: does not fire for an entity absent from the registry', async () => {
    const client = makeFakeClient()
    const repo = createSetupCrudRepository({ localClient: client, getToken })
    await repo.createRecord('days_of_operation', 'd1', { sort_order: 1, label: 'Monday' })
    expect(client.calls.write.map((c) => c[3])).toEqual(['sort_order', 'label'])
  })
})

describe('createSetupCrudRepository — deleteAllRecords', () => {
  it('deletes each id, tallying succeeded/failed', async () => {
    const client = makeFakeClient()
    const repo = createSetupCrudRepository({ localClient: client, getToken })
    const result = await repo.deleteAllRecords('days_of_operation', ['d1', 'd2'])
    expect(result).toEqual({ succeeded: 2, failed: 0, failedDueToRole: false })
    expect(client.calls.deleteEntity).toEqual([
      ['tok', 'days_of_operation', 'd1'],
      ['tok', 'days_of_operation', 'd2'],
    ])
  })

  it('flags failedDueToRole and counts failures when deleteEntity rejects with admin role required', async () => {
    const client = makeFakeClient()
    client.deleteEntity.mockRejectedValue(new Error('admin role required'))
    const repo = createSetupCrudRepository({ localClient: client, getToken })
    const result = await repo.deleteAllRecords('days_of_operation', ['d1', 'd2'])
    expect(result).toEqual({ succeeded: 0, failed: 2, failedDueToRole: true })
  })

  it('counts a non-applied/queued result as a failure without throwing', async () => {
    const client = makeFakeClient({ deleteResult: { status: 'rejected' } })
    const repo = createSetupCrudRepository({ localClient: client, getToken })
    const result = await repo.deleteAllRecords('days_of_operation', ['d1'])
    expect(result).toEqual({ succeeded: 0, failed: 1, failedDueToRole: false })
  })
})
