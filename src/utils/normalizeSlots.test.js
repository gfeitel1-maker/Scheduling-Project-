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

  // Snapshots saved before the flag/findings reshape carry old-shape
  // UNDERSERVED/DISTRIBUTION/WEATHER_RISK (and their _reason/_dismissed
  // siblings) stamped per-slot. These are no longer meaningful — the engine
  // now emits them as aggregate `findings`, not per-slot stamps — so the
  // load-time adapter strips them rather than re-deriving them (Architect's
  // decision, docs/adr/2026-07-28-schedule-flag-findings-reshape.md).
  // UNFILLABLE and its _reason/_dismissed siblings must pass through
  // untouched since its shape is unchanged.
  it('strips stale UNDERSERVED/DISTRIBUTION/WEATHER_RISK keys (and their _reason/_dismissed siblings) from a legacy-shape flags JSON string, leaving UNFILLABLE untouched', () => {
    const legacyFlags = JSON.stringify({
      UNFILLABLE: true,
      UNFILLABLE_reason: 'No eligible activity could be placed in this slot',
      UNDERSERVED: true,
      UNDERSERVED_reason: 'Goal: 3×/wk — scheduled 1×',
      UNDERSERVED_dismissed: true,
      DISTRIBUTION: true,
      DISTRIBUTION_reason: 'Goal: 2× before day 3 — only 0× placed',
      WEATHER_RISK: true,
      WEATHER_RISK_reason: 'Outdoor activity scheduled in this slot',
    })
    const [row] = normalizeSlots([{ id: 'legacy', flags: legacyFlags }])
    expect(row.flags).toEqual({
      UNFILLABLE: true,
      UNFILLABLE_reason: 'No eligible activity could be placed in this slot',
    })
  })

  it('also strips stale keys when flags is already a plain object (field-at-a-time write path)', () => {
    const [row] = normalizeSlots([{
      id: 'legacy-obj',
      flags: { UNFILLABLE: true, DISTRIBUTION: true, DISTRIBUTION_reason: 'x' },
    }])
    expect(row.flags).toEqual({ UNFILLABLE: true })
  })

  // Round 2 B4: template_slots.flags crosses the LAN op-log sync boundary as
  // JSON.parse'd input from another device. JSON.parse makes "__proto__" an
  // own enumerable key (it does not trigger the special-form prototype-setter
  // behavior object literals do), so the old `next[k] = v` loop would swap
  // the returned object's prototype — a malicious peer could plant a spoofed
  // UNFILLABLE flag with attacker-chosen reason text that isn't even visible
  // via Object.keys(next), while ScheduleScreen's plain `s.flags?.UNFILLABLE`
  // reads would pick it up as if it were real.
  it('does not let a __proto__ key in flags JSON pollute the returned object\'s prototype (malicious sync payload)', () => {
    // Deliberately a raw JSON string literal, not JSON.stringify({ __proto__: ... })
    // — an object literal's `__proto__: value` key is a prototype-setter, not
    // an own property, so stringifying it would just produce "{}" and miss
    // the real bug. JSON.parse, by contrast, creates "__proto__" as a genuine
    // own enumerable property — that's the actual attack surface here.
    const malicious = '{"__proto__":{"UNFILLABLE":true,"UNFILLABLE_reason":"spoofed by attacker"}}'
    const [row] = normalizeSlots([{ id: 'evil', flags: malicious }])

    // The polluted own-property surface is empty — nothing to iterate.
    expect(Object.keys(row.flags)).toEqual([])
    // And critically: an unrelated fresh object must NOT have picked up the
    // spoofed flags via a polluted Object.prototype.
    expect(({}).UNFILLABLE).toBeUndefined()
    expect(row.flags.UNFILLABLE).toBeUndefined()
    expect(row.flags.UNFILLABLE_reason).toBeUndefined()
  })

  it('drops constructor/prototype keys too, without throwing', () => {
    const malicious = JSON.stringify({ constructor: { polluted: true }, prototype: { polluted: true }, UNFILLABLE: true })
    const [row] = normalizeSlots([{ id: 'evil2', flags: malicious }])
    expect(row.flags.UNFILLABLE).toBe(true)
    expect(Object.keys(row.flags)).toEqual(['UNFILLABLE'])
  })
})
