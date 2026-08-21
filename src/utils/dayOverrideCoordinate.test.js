import { describe, it, expect } from 'vitest'
import { findOverrideId, upsertDayOverride } from './dayOverrideCoordinate.js'

const COORD = { weekId: 'week-1', dayId: 'day-1', groupId: 'grp-1', blockId: 'block-1' }
const row = (overrides = {}) => ({
  id: 'ovr-A', schedule_week_id: 'week-1', day_id: 'day-1', group_id: 'grp-1', time_block_id: 'block-1',
  activity_id: 'act-art', kind: 'swap', note: null,
  ...overrides,
})

describe('findOverrideId', () => {
  it('returns the existing row id for a coordinate that already has an override', () => {
    expect(findOverrideId([row()], COORD)).toBe('ovr-A')
  })

  it('returns null when no override exists for the coordinate', () => {
    expect(findOverrideId([row({ time_block_id: 'block-OTHER' })], COORD)).toBeNull()
  })

  it('returns null for an empty/undefined list', () => {
    expect(findOverrideId([], COORD)).toBeNull()
    expect(findOverrideId(undefined, COORD)).toBeNull()
  })

  it('distinguishes coordinates that differ by day_id only', () => {
    expect(findOverrideId([row({ day_id: 'day-OTHER' })], COORD)).toBeNull()
  })
})

describe('upsertDayOverride', () => {
  it('appends when no entry exists for the coordinate', () => {
    const result = upsertDayOverride([], row())
    expect(result).toEqual([row()])
  })

  it('REPLACES the existing entry for the same coordinate — one entry, new content, not two', () => {
    const original = row({ id: 'ovr-A', activity_id: 'act-art' })
    const reauthored = row({ id: 'ovr-A', activity_id: 'act-boat' })
    const result = upsertDayOverride([original], reauthored)
    expect(result).toHaveLength(1)
    expect(result[0].activity_id).toBe('act-boat')
  })

  it('does not mutate the input array', () => {
    const original = row()
    const prev = [original]
    upsertDayOverride(prev, row({ activity_id: 'act-boat' }))
    expect(prev[0].activity_id).toBe('act-art')
  })

  it('leaves other coordinates untouched', () => {
    const other = row({ id: 'ovr-other', time_block_id: 'block-2' })
    const result = upsertDayOverride([other], row({ activity_id: 'act-boat' }))
    expect(result).toHaveLength(2)
    expect(result.find((o) => o.id === 'ovr-other')).toEqual(other)
  })
})
