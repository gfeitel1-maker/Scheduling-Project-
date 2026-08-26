import { describe, it, expect } from 'vitest'
import {
  primaryMapId,
  resolveLocationMapId,
  locationsOnMap,
  mapSlotLabel,
  hasMapPair,
  defaultActiveMapId,
} from './mapPairModel'

const CAMP = 'camp1'

describe('mapPairModel — the map-pair resolution seam (ADR 2026-08-26 D2)', () => {
  describe('primaryMapId', () => {
    it('is null with no maps', () => {
      expect(primaryMapId([], CAMP)).toBeNull()
      expect(primaryMapId(undefined, CAMP)).toBeNull()
    })
    it('is the sole map when there is one (id === camp_id, the pre-v50 shape)', () => {
      expect(primaryMapId([{ id: CAMP, kind: null }], CAMP)).toBe(CAMP)
    })
    it('is the original (id === camp_id) even when a second minted map exists', () => {
      const maps = [{ id: 'minted-2', kind: 'outdoor' }, { id: CAMP, kind: 'indoor' }]
      expect(primaryMapId(maps, CAMP)).toBe(CAMP)
    })
    it('falls back to the first row if none has id === camp_id (defensive)', () => {
      expect(primaryMapId([{ id: 'a' }, { id: 'b' }], CAMP)).toBe('a')
    })
  })

  describe('resolveLocationMapId — the no-backfill invariant', () => {
    const maps = [{ id: CAMP, kind: 'indoor' }, { id: 'minted-2', kind: 'outdoor' }]
    it('an explicit map_id wins', () => {
      expect(resolveLocationMapId({ map_id: 'minted-2' }, maps, CAMP)).toBe('minted-2')
    })
    it('a NULL map_id resolves to the original map — existing markers never need rewriting when a 2nd map is added', () => {
      expect(resolveLocationMapId({ map_id: null }, maps, CAMP)).toBe(CAMP)
      expect(resolveLocationMapId({}, maps, CAMP)).toBe(CAMP)
    })
  })

  describe('locationsOnMap', () => {
    const maps = [{ id: CAMP, kind: 'indoor' }, { id: 'out', kind: 'outdoor' }]
    const locs = [
      { id: 'l1', map_id: null },       // → primary (indoor)
      { id: 'l2', map_id: CAMP },        // → indoor (explicit)
      { id: 'l3', map_id: 'out' },       // → outdoor
      { id: 'l4', map_id: 'stale-gone' },// → a deleted map id (stays put, not on either real map)
    ]
    it('scopes markers to the indoor map (incl. NULL map_id legacy markers)', () => {
      expect(locationsOnMap(locs, CAMP, maps, CAMP).map((l) => l.id)).toEqual(['l1', 'l2'])
    })
    it('scopes markers to the outdoor map', () => {
      expect(locationsOnMap(locs, 'out', maps, CAMP).map((l) => l.id)).toEqual(['l3'])
    })
    it('a location pointing at a deleted map shows on neither real map (no crash, just absent)', () => {
      const ids = [...locationsOnMap(locs, CAMP, maps, CAMP), ...locationsOnMap(locs, 'out', maps, CAMP)].map((l) => l.id)
      expect(ids).not.toContain('l4')
    })
  })

  describe('mapSlotLabel', () => {
    it('maps kind → director vocabulary', () => {
      expect(mapSlotLabel({ kind: 'indoor' })).toBe('Buildings')
      expect(mapSlotLabel({ kind: 'outdoor' })).toBe('Grounds')
      expect(mapSlotLabel({ kind: null })).toBe('Map')
      expect(mapSlotLabel(undefined)).toBe('Map')
    })
  })

  describe('hasMapPair / defaultActiveMapId', () => {
    it('single map (or none) is not a pair — no toggle', () => {
      expect(hasMapPair([])).toBe(false)
      expect(hasMapPair([{ id: CAMP }])).toBe(false)
    })
    it('two maps is a pair', () => {
      expect(hasMapPair([{ id: CAMP }, { id: 'x' }])).toBe(true)
    })
    it('default active map is the primary', () => {
      expect(defaultActiveMapId([{ id: 'x', kind: 'outdoor' }, { id: CAMP, kind: 'indoor' }], CAMP)).toBe(CAMP)
    })
  })
})
