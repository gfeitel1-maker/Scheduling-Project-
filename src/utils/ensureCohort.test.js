// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../localClient', () => ({
  localClient: {
    list: vi.fn(),
    write: vi.fn(),
  },
}))

import { ensureCohort } from './ensureCohort'
import { localClient } from '../localClient'

beforeEach(() => {
  vi.stubGlobal('localStorage', {
    getItem: () => 'token-abc',
    setItem: () => {},
    removeItem: () => {},
  })
  vi.stubGlobal('crypto', { randomUUID: () => 'new-cohort-id' })
  localClient.list.mockReset()
  localClient.write.mockReset().mockResolvedValue({ status: 'applied' })
})

describe('ensureCohort', () => {
  it('does nothing when the camp already has a complete cohort', async () => {
    localClient.list.mockResolvedValue([
      {
        id: 'c1',
        camp_id: 'camp-1',
        name: 'Main',
        session_week_start: 1,
        session_week_end: 1,
        capacity_source: 'groups_per_slot',
        anchor_model: 'fixed',
      },
    ])
    await ensureCohort('camp-1')
    expect(localClient.write).not.toHaveBeenCalled()
  })

  it('creates a Main cohort field-by-field, name first, when the camp has none', async () => {
    localClient.list.mockResolvedValue([])
    await ensureCohort('camp-1')
    expect(localClient.write).toHaveBeenCalledTimes(6)
    const calls = localClient.write.mock.calls
    for (const call of calls) {
      expect(call[0]).toBe('token-abc')
      expect(call[1]).toBe('cohorts')
      expect(call[2]).toBe('new-cohort-id')
    }
    // The very first write must be `name` — that's what lets the DB-level
    // UNIQUE(camp_id, name) constraint (electron/db/schema.sql) catch a
    // concurrent creator before any other field is ever written. See the
    // HIGH finding 1/2 fix comment in ensureCohort.js.
    expect(calls[0][3]).toBe('name')
    expect(calls[0][4]).toBe('Main')

    const fields = Object.fromEntries(calls.map((c) => [c[3], c[4]]))
    expect(fields).toEqual({
      camp_id: 'camp-1',
      name: 'Main',
      session_week_start: 1,
      session_week_end: 1,
      capacity_source: 'groups_per_slot',
      anchor_model: 'fixed',
    })
  })

  it('throws if an existing cohort belongs to a different camp than the one passed in', async () => {
    localClient.list.mockResolvedValue([{ id: 'c1', camp_id: 'other-camp' }])
    await expect(ensureCohort('camp-1')).rejects.toThrow()
    expect(localClient.write).not.toHaveBeenCalled()
  })

  it('repairs an incomplete cohort (torn write) by filling only the missing fields on the same id, instead of creating a new one', async () => {
    localClient.list.mockResolvedValue([
      { id: 'existing-id', camp_id: 'camp-1', name: '', session_week_start: null, session_week_end: null, capacity_source: null, anchor_model: null },
    ])
    await ensureCohort('camp-1')
    const calls = localClient.write.mock.calls
    for (const call of calls) {
      expect(call[2]).toBe('existing-id')
    }
    const fields = Object.fromEntries(calls.map((c) => [c[3], c[4]]))
    expect(fields).toEqual({
      name: 'Main',
      session_week_start: 1,
      session_week_end: 1,
      capacity_source: 'groups_per_slot',
      anchor_model: 'fixed',
    })
  })

  it('repairs only the specific fields missing from a partially-torn cohort', async () => {
    localClient.list.mockResolvedValue([
      {
        id: 'existing-id',
        camp_id: 'camp-1',
        name: 'Main',
        session_week_start: 1,
        session_week_end: null,
        capacity_source: null,
        anchor_model: 'fixed',
      },
    ])
    await ensureCohort('camp-1')
    const calls = localClient.write.mock.calls
    const fields = Object.fromEntries(calls.map((c) => [c[3], c[4]]))
    expect(fields).toEqual({
      session_week_end: 1,
      capacity_source: 'groups_per_slot',
    })
  })

  it('swallows a genuine UNIQUE-constraint error thrown by a losing concurrent write', async () => {
    localClient.list.mockResolvedValue([])
    localClient.write.mockRejectedValueOnce(new Error('UNIQUE constraint failed: cohorts.camp_id, cohorts.name'))
    await expect(ensureCohort('camp-1')).resolves.toBeUndefined()
  })

  it('rethrows any error that is NOT a UNIQUE-constraint violation, even if a cohort now happens to exist for the camp (round-2 Security MEDIUM fix: do not infer success from existence alone)', async () => {
    localClient.list.mockResolvedValue([])
    localClient.write.mockRejectedValueOnce(new Error('disk full'))
    await expect(ensureCohort('camp-1')).rejects.toThrow('disk full')
  })

  it('rethrows if the write fails and the camp still has no cohort at all', async () => {
    localClient.list.mockResolvedValue([])
    localClient.write.mockRejectedValueOnce(new Error('some other db error'))
    await expect(ensureCohort('camp-1')).rejects.toThrow('some other db error')
  })
})
