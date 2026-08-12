// Drives the persistence seam with a FAKE localClient (a plain object that
// captures every call) — no React render, no Electron. Mirrors
// scheduleRepository.test.js's fake-collaborator style.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createSetupCrudRepository } from './setupCrudRepository'

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
