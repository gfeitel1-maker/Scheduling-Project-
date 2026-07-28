import { describe, it, expect } from 'vitest'
import { normalizeSlots } from './normalizeSlots'

// template_slots.is_anchor / is_span_head / is_released are INTEGER columns
// (electron/db/localDb.js) and localClient.list() returns raw `SELECT *` rows,
// so the renderer only ever receives 0/1. Six readers in ScheduleScreen plus
// one each in ScheduleGroupView/ManualBuildView compare strictly against
// `false`, which no DB-loaded row satisfies without this coercion.
describe('normalizeSlots — INTEGER boolean columns', () => {
  it('turns 0/1 into false/true for is_anchor, is_span_head and is_released', () => {
    const [zeroes, ones] = normalizeSlots([
      { id: 'a', is_anchor: 0, is_span_head: 0, is_released: 0, flags: null },
      { id: 'b', is_anchor: 1, is_span_head: 1, is_released: 1, flags: null },
    ])

    expect(zeroes.is_anchor).toBe(false)
    expect(zeroes.is_span_head).toBe(false)
    expect(zeroes.is_released).toBe(false)

    expect(ones.is_anchor).toBe(true)
    expect(ones.is_span_head).toBe(true)
    expect(ones.is_released).toBe(true)
  })

  it('leaves an already-boolean row (optimistic in-memory state) unchanged', () => {
    const [row] = normalizeSlots([
      { id: 'c', is_anchor: false, is_span_head: true, is_released: false, flags: null },
    ])

    expect(row.is_anchor).toBe(false)
    expect(row.is_span_head).toBe(true)
    expect(row.is_released).toBe(false)
  })

  it('preserves NULL as null — the three columns were added by ALTER TABLE with no NOT NULL and no DEFAULT, so a pre-migration row genuinely has no value, and coercing a NULL is_span_head to false would mark every such slot as a merged tail', () => {
    const [row] = normalizeSlots([
      { id: 'd', is_anchor: null, is_span_head: null, is_released: null, flags: null },
    ])

    expect(row.is_anchor).toBeNull()
    expect(row.is_span_head).toBeNull()
    expect(row.is_released).toBeNull()
    // The readers that matter treat null as "not a tail" / "not released",
    // which is the correct default — unlike `false`, which means "IS a tail".
    expect(row.is_span_head === false).toBe(false)
  })
})

describe('normalizeSlots — flags', () => {
  it('parses a bulk_replace-written JSON string back into an object', () => {
    const [row] = normalizeSlots([{ id: 'a', flags: '{"UNFILLABLE":true}' }])
    expect(row.flags).toEqual({ UNFILLABLE: true })
  })

  it('falls back to an empty object for null, empty-string and malformed flags', () => {
    const [nul, empty, bad] = normalizeSlots([
      { id: 'a', flags: null },
      { id: 'b', flags: '' },
      { id: 'c', flags: '{not valid json' },
    ])
    expect(nul.flags).toEqual({})
    expect(empty.flags).toEqual({})
    expect(bad.flags).toEqual({})
  })
})
