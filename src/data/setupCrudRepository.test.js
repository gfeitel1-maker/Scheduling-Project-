// Drives the persistence seam with a FAKE localClient (a plain object that
// captures every call) — no React render, no Electron. Mirrors
// scheduleRepository.test.js's fake-collaborator style.
import { describe, it, expect, vi } from 'vitest'
import { createSetupCrudRepository, UNIQUE_FIRST_FIELD, REQUIRED_FIRST_ON_WRITE, orderFieldsForWrite, orderFieldsForCreate } from './setupCrudRepository'

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

  // T238 regression guard. Six screens turn a duplicate-name rejection into the
  // specific "a <thing> with this name already exists" message by testing the
  // thrown message against /UNIQUE/i. Before v73 those entities were
  // unregistered, so a duplicate threw a raw SQLITE_CONSTRAINT_UNIQUE and that
  // matched for free; T238 registered six more, converting the same collision
  // into a STRUCTURED {status:'rejected', reason:'unique_field'} that RESOLVES.
  // A bare "write failed" therefore downgraded every one of those messages to
  // the generic fallback — the create was still blocked, but the director was
  // told less. The word UNIQUE below is load-bearing, not decoration.
  it('a unique_field rejection throws an error the screens\' /UNIQUE/i check still matches', async () => {
    const client = makeFakeClient({
      writeResult: { status: 'rejected', reason: 'unique_field', existing: { id: 'g-other', name: 'Bunk 1' } },
    })
    const repo = createSetupCrudRepository({ localClient: client, getToken })

    const err = await repo.writeFields('groups', 'g1', { name: 'Bunk 1' }).catch((e) => e)

    expect(err).toBeInstanceOf(Error)
    // The assertion the screens actually depend on.
    expect(err.message).toMatch(/UNIQUE/i)
    expect(err.message).toMatch(/name/)
    // Structured alternative, so a future caller can branch on the value
    // rather than on the wording.
    expect(err.reason).toBe('unique_field')
    expect(err.existing).toEqual({ id: 'g-other', name: 'Bunk 1' })
  })

  // Non-vacuity: the guard above must not match a rejection it was NOT written
  // for. A blanket "put UNIQUE in every failure message" would pass the test
  // above while making every unrelated failure read as a duplicate-name
  // collision to all six screens — strictly worse than the bug being fixed.
  it('a NON-unique rejection does NOT mention UNIQUE (so other failures keep the generic message)', async () => {
    const client = makeFakeClient({ writeResult: { status: 'rejected', reason: 'role_required' } })
    const repo = createSetupCrudRepository({ localClient: client, getToken })

    const err = await repo.writeFields('groups', 'g1', { name: 'Bunk 1' }).catch((e) => e)

    expect(err.message).toMatch(/write failed for field "name"/)
    expect(err.message).not.toMatch(/UNIQUE/i)
    expect(err.reason).toBe('role_required')
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
    await repo.createRecord('anchor_activities', 'tb1', { label: 'Monday', sort_order: 1 })
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
      repo.createRecord('anchor_activities', 'tb1', { label: 'Monday', sort_order: 1 })
    ).rejects.toThrow(/write failed for field "sort_order"/)
    expect(client.calls.deleteEntity).toEqual([['tok', 'anchor_activities', 'tb1']])
  })

  it('swallows a cleanup failure — does not mask the original error or throw a second exception', async () => {
    const client = makeFakeClient()
    client.write.mockResolvedValue({ status: 'rejected' })
    client.deleteEntity.mockRejectedValue(new Error('cleanup boom'))
    const repo = createSetupCrudRepository({ localClient: client, getToken })
    await expect(repo.createRecord('anchor_activities', 'tb1', { label: 'Monday' })).rejects.toThrow(
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
  // T205 round 2 FIX 4 (Code Reviewer nit): a direct assertion for this specific
  // mapping, not just coverage-by-inclusion in the parity test
  // (electron/uniqueFirstFieldRegistryParity.test.js).
  it('registers days_of_operation on day_of_week (T205)', () => {
    expect(UNIQUE_FIRST_FIELD.days_of_operation).toBe('day_of_week')
  })

  // Reversal (2026-09-18): see docs/adr/2026-08-15-locations-concurrent-create-collision.md
  // "Reversal" section. createRecord now auto-reorders the registered unique
  // field to the front instead of throwing when it's out of order.
  it('UNIQUE_FIRST_FIELD auto-reorder: moves the registered unique field to the front instead of throwing when it is not first', async () => {
    expect(UNIQUE_FIRST_FIELD.locations).toBe('name')
    const client = makeFakeClient()
    const repo = createSetupCrudRepository({ localClient: client, getToken })
    await repo.createRecord('locations', 'loc-new', { camp_id: 'camp-1', name: 'Pool', capacity: 1 })
    expect(client.calls.write.map((c) => c[3])).toEqual(['name', 'camp_id', 'capacity'])
  })

  it('UNIQUE_FIRST_FIELD auto-reorder: moves the unique field to the front even when built last, not just out of position by one', async () => {
    const client = makeFakeClient()
    const repo = createSetupCrudRepository({ localClient: client, getToken })
    await repo.createRecord('locations', 'loc-new', { camp_id: 'camp-1', capacity: 1, notes: null, name: 'Pool' })
    expect(client.calls.write[0][3]).toBe('name')
    expect(client.calls.write.map((c) => c[3])).toEqual(['name', 'camp_id', 'capacity', 'notes'])
  })

  it('UNIQUE_FIRST_FIELD: throws when the registered unique field is ABSENT from the create object, before any write', async () => {
    const client = makeFakeClient()
    const repo = createSetupCrudRepository({ localClient: client, getToken })
    await expect(
      repo.createRecord('locations', 'loc-new', { camp_id: 'camp-1', capacity: 1 })
    ).rejects.toThrow(/must include "name"/)
    expect(client.calls.write).toHaveLength(0)
    expect(client.calls.deleteEntity).toHaveLength(0)
  })

  it('days_of_operation: auto-reorders day_of_week to the front when built out of order', async () => {
    const client = makeFakeClient()
    const repo = createSetupCrudRepository({ localClient: client, getToken })
    await repo.createRecord('days_of_operation', 'd-new', { label: 'Monday', day_of_week: 1, sort_order: 1 })
    expect(client.calls.write.map((c) => c[3])).toEqual(['day_of_week', 'label', 'sort_order'])
  })

  it('days_of_operation: throws when day_of_week is absent from the create object', async () => {
    const client = makeFakeClient()
    const repo = createSetupCrudRepository({ localClient: client, getToken })
    await expect(
      repo.createRecord('days_of_operation', 'd-new', { label: 'Monday', sort_order: 1 })
    ).rejects.toThrow(/must include "day_of_week"/)
    expect(client.calls.write).toHaveLength(0)
  })

  it('UNIQUE_FIRST_FIELD guard: does not fire for an entity absent from the registry', async () => {
    const client = makeFakeClient()
    const repo = createSetupCrudRepository({ localClient: client, getToken })
    await repo.createRecord('anchor_activities', 'tb1', { sort_order: 1, label: 'Monday' })
    expect(client.calls.write.map((c) => c[3])).toEqual(['sort_order', 'label'])
  })
})

describe('orderFieldsForCreate', () => {
  it('is a no-op for an entity not registered in UNIQUE_FIRST_FIELD', () => {
    // anchor_activities is registered in REQUIRED_FIRST_ON_WRITE (a different
    // registry, orderFieldsForWrite's concern) but not in UNIQUE_FIRST_FIELD,
    // so orderFieldsForCreate must leave its field order untouched.
    expect(orderFieldsForCreate('anchor_activities', { sort_order: 1, label: 'Monday' })).toEqual([
      ['sort_order', 1], ['label', 'Monday'],
    ])
  })

  // T238: tiers/time_blocks are UNIQUE(camp_id, cohort_id, name) — a
  // COMPOSITE scope. orderFieldsForCreate must place the extra scope column
  // (cohort_id) BEFORE the unique field (name) so that, by the time `name`'s
  // write reaches detectUniqueFieldCollision (electron/ops/operations.js),
  // cohort_id is already on the row for it to read.
  it('places a composite entity\'s extra scope column before its unique field, ahead of everything else', () => {
    expect(
      orderFieldsForCreate('tiers', { name: 'A', camp_id: 'camp-1', cohort_id: 'cohort-1', sort_order: 1 })
    ).toEqual([
      ['cohort_id', 'cohort-1'],
      ['name', 'A'],
      ['camp_id', 'camp-1'],
      ['sort_order', 1],
    ])
  })

  it('places time_blocks\' extra scope column (cohort_id) before its unique field the same way', () => {
    expect(
      orderFieldsForCreate('time_blocks', { name: 'AM', camp_id: 'camp-1', cohort_id: 'cohort-1', start_time: '09:00' })
    ).toEqual([
      ['cohort_id', 'cohort-1'],
      ['name', 'AM'],
      ['camp_id', 'camp-1'],
      ['start_time', '09:00'],
    ])
  })

  it('does not reorder a single-scope entity (locations has no extra scope column)', () => {
    expect(orderFieldsForCreate('locations', { camp_id: 'camp-1', name: 'Pool', capacity: 20 })).toEqual([
      ['name', 'Pool'],
      ['camp_id', 'camp-1'],
      ['capacity', 20],
    ])
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
