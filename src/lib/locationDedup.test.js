import { describe, it, expect, vi } from 'vitest'
import { createLocationRecord, updateLocationCapacityRecord } from './locationDedup'

describe('createLocationRecord', () => {
  it('returns the existing location (no write) on case-insensitive name match', async () => {
    const repository = { createRecord: vi.fn() }
    const existing = [{ id: 'l1', name: 'Pool' }]
    const res = await createLocationRecord({ repository, campId: 'c1', name: 'pool', existing })
    expect(res.created).toBe(false)
    expect(res.location).toEqual({ id: 'l1', name: 'Pool' })
    expect(repository.createRecord).not.toHaveBeenCalled()
  })

  it('creates a new location with name-first field order on no match', async () => {
    const calls = []
    const repository = { createRecord: vi.fn((...args) => { calls.push(args); return Promise.resolve() }) }
    const existing = []
    const res = await createLocationRecord({ repository, campId: 'c1', name: '  New Field  ', existing })
    expect(res.created).toBe(true)
    expect(res.location.name).toBe('New Field')
    expect(res.location.camp_id).toBe('c1')
    expect(res.location.capacity).toBe(1)
    expect(res.location.notes).toBe(null)
    expect(repository.createRecord).toHaveBeenCalledTimes(1)
    const [table, id, fields] = calls[0]
    expect(table).toBe('locations')
    expect(id).toBe(res.location.id)
    expect(Object.keys(fields)[0]).toBe('name')
    expect(fields).toEqual({ name: 'New Field', camp_id: 'c1', capacity: 1, notes: null })
  })

  it('returns null for a blank name without writing', async () => {
    const repository = { createRecord: vi.fn() }
    const res = await createLocationRecord({ repository, campId: 'c1', name: '   ', existing: [] })
    expect(res).toBe(null)
    expect(repository.createRecord).not.toHaveBeenCalled()
  })

  // T255 finding 8: schema v73 permits two same-named locations (e.g. a
  // cross-device merge landed a duplicate). `existing` is the caller's React
  // state array, whose order can change on a reload or a peer's insert — so
  // resolving to "the first match in array order" binds the same typed name
  // to a DIFFERENT row depending on incidental ordering. Must always resolve
  // to the lowest-id row, deterministically.
  it('resolves an ambiguous name to the lowest-id match regardless of array order', async () => {
    const repository = { createRecord: vi.fn() }
    const existing = [{ id: 'z9', name: 'Pool' }, { id: 'a1', name: 'pool' }]
    const res = await createLocationRecord({ repository, campId: 'c1', name: 'Pool', existing })
    expect(res.created).toBe(false)
    expect(res.location.id).toBe('a1')
  })

  it('picks the same lowest-id winner even when the array order is reversed', async () => {
    const repository = { createRecord: vi.fn() }
    const existing = [{ id: 'a1', name: 'pool' }, { id: 'z9', name: 'Pool' }]
    const res = await createLocationRecord({ repository, campId: 'c1', name: 'Pool', existing })
    expect(res.created).toBe(false)
    expect(res.location.id).toBe('a1')
  })
})

describe('updateLocationCapacityRecord', () => {
  it('writes the capacity field through the repository', async () => {
    const repository = { writeFields: vi.fn(() => Promise.resolve()) }
    await updateLocationCapacityRecord({ repository, locationId: 'l1', capacity: 5 })
    expect(repository.writeFields).toHaveBeenCalledWith('locations', 'l1', { capacity: 5 })
  })
})
