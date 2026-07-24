// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../localClient', () => ({
  localClient: {
    list: vi.fn(),
    write: vi.fn(),
  },
}))

import { seedDays } from './seedDays'
import { localClient } from '../localClient'

const COMPLETE_DAYS = [
  { id: 'd1', camp_id: 'camp-1', label: 'Monday', day_of_week: 1, sort_order: 1 },
  { id: 'd2', camp_id: 'camp-1', label: 'Tuesday', day_of_week: 2, sort_order: 2 },
  { id: 'd3', camp_id: 'camp-1', label: 'Wednesday', day_of_week: 3, sort_order: 3 },
  { id: 'd4', camp_id: 'camp-1', label: 'Thursday', day_of_week: 4, sort_order: 4 },
  { id: 'd5', camp_id: 'camp-1', label: 'Friday', day_of_week: 5, sort_order: 5 },
]

let uuidCounter
beforeEach(() => {
  vi.stubGlobal('localStorage', {
    getItem: () => 'token-abc',
    setItem: () => {},
    removeItem: () => {},
  })
  uuidCounter = 0
  vi.stubGlobal('crypto', { randomUUID: () => `new-id-${++uuidCounter}` })
  localClient.list.mockReset()
  localClient.write.mockReset().mockResolvedValue({ status: 'applied' })
})

describe('seedDays', () => {
  it('creates all 5 weekday rows when the camp has none', async () => {
    localClient.list.mockResolvedValue([])
    await seedDays('camp-1')

    expect(localClient.write).toHaveBeenCalledTimes(20) // 5 rows x 4 fields
    const calls = localClient.write.mock.calls
    const byRow = {}
    for (const [token, table, id, field, value] of calls) {
      expect(token).toBe('token-abc')
      expect(table).toBe('days_of_operation')
      byRow[id] = byRow[id] || {}
      byRow[id][field] = value
    }
    const rows = Object.values(byRow)
    expect(rows).toHaveLength(5)
    const dayOfWeeks = rows.map((r) => r.day_of_week).sort()
    expect(dayOfWeeks).toEqual([1, 2, 3, 4, 5])
    for (const row of rows) {
      expect(row.camp_id).toBe('camp-1')
      expect(row.label).toBeTruthy()
      expect(row.sort_order).toBeTruthy()
    }
  })

  it('does nothing when all 5 weekday rows already exist and are complete', async () => {
    localClient.list.mockResolvedValue(COMPLETE_DAYS)
    await seedDays('camp-1')
    expect(localClient.write).not.toHaveBeenCalled()
  })

  it('repairs only the missing/incomplete weekdays without duplicating an existing complete one', async () => {
    // Only Monday exists and is complete; Tuesday-Friday are missing entirely.
    localClient.list.mockResolvedValue([COMPLETE_DAYS[0]])
    await seedDays('camp-1')

    const calls = localClient.write.mock.calls
    const byRow = {}
    for (const [, , id, field, value] of calls) {
      byRow[id] = byRow[id] || {}
      byRow[id][field] = value
    }
    // Monday's existing id must never be written to again.
    expect(byRow['d1']).toBeUndefined()

    const rows = Object.values(byRow)
    expect(rows).toHaveLength(4)
    const dayOfWeeks = rows.map((r) => r.day_of_week).sort()
    expect(dayOfWeeks).toEqual([2, 3, 4, 5])
  })

  it('repairs an incomplete weekday row (torn write) in place, reusing its id, instead of creating a duplicate', async () => {
    const torn = { id: 'existing-monday', camp_id: 'camp-1', label: null, day_of_week: 1, sort_order: null }
    localClient.list.mockResolvedValue([torn, ...COMPLETE_DAYS.slice(1)])
    await seedDays('camp-1')

    const calls = localClient.write.mock.calls
    for (const [, , id] of calls) {
      expect(id).toBe('existing-monday')
    }
    const fields = Object.fromEntries(calls.map((c) => [c[3], c[4]]))
    expect(fields).toEqual({ label: 'Monday', sort_order: 1 })
    // day_of_week was already present on the torn row, so it should not be rewritten.
    expect(fields.day_of_week).toBeUndefined()
  })

  it('throws if an existing days_of_operation row belongs to a different camp than the one passed in', async () => {
    localClient.list.mockResolvedValue([{ id: 'd1', camp_id: 'other-camp', day_of_week: 1 }])
    await expect(seedDays('camp-1')).rejects.toThrow()
    expect(localClient.write).not.toHaveBeenCalled()
  })
})
