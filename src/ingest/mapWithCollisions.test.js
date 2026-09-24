import { describe, it, expect } from 'vitest'
import { mapWithCollisions } from './mapWithCollisions'

describe('mapWithCollisions', () => {
  it('maps each row under its key when every key is unique', () => {
    const rows = [{ id: 'a1', name: 'Alpha' }, { id: 'a2', name: 'Beta' }]
    const { map, ambiguous } = mapWithCollisions(rows, (r) => r.name, (r) => r.id)

    expect(map.get('Alpha')).toBe('a1')
    expect(map.get('Beta')).toBe('a2')
    expect(ambiguous.size).toBe(0)
  })

  it('collects a colliding key into ambiguous and removes it from the map entirely', () => {
    const rows = [
      { id: 'g1', name: 'Chaverim' },
      { id: 'g2', name: 'Chaverim' },
    ]
    const { map, ambiguous } = mapWithCollisions(rows, (r) => r.name, (r) => r.id)

    expect(ambiguous.has('Chaverim')).toBe(true)
    // Structural refusal: a caller that never checks `ambiguous` still
    // cannot bind to either row, because the key is simply absent.
    expect(map.has('Chaverim')).toBe(false)
    expect(map.get('Chaverim')).toBeUndefined()
  })

  it('a third row sharing an already-ambiguous key stays ambiguous, not a fresh single winner', () => {
    const rows = [
      { id: 'g1', name: 'Chaverim' },
      { id: 'g2', name: 'Chaverim' },
      { id: 'g3', name: 'Chaverim' },
    ]
    const { map, ambiguous } = mapWithCollisions(rows, (r) => r.name, (r) => r.id)

    expect(ambiguous.has('Chaverim')).toBe(true)
    expect(map.has('Chaverim')).toBe(false)
  })

  it('non-vacuity: a caller that ignores `ambiguous` entirely still cannot read a wrong-row value out of `map`', () => {
    // Plants the defect this helper exists to prevent: last-write-wins. If
    // mapWithCollisions regressed to plain last-write-wins, this assertion
    // (not just the `ambiguous` flag) would catch it — map.get would return
    // 'g2' instead of undefined.
    const rows = [
      { id: 'g1', name: 'Chaverim' },
      { id: 'g2', name: 'Chaverim' },
    ]
    const { map } = mapWithCollisions(rows, (r) => r.name, (r) => r.id)

    const valueAWrongCallerWouldGet = map.get('Chaverim')
    expect(valueAWrongCallerWouldGet).not.toBe('g2')
    expect(valueAWrongCallerWouldGet).not.toBe('g1')
    expect(valueAWrongCallerWouldGet).toBeUndefined()
  })

  it('leaves unrelated keys unaffected by a collision elsewhere', () => {
    const rows = [
      { id: 'g1', name: 'Chaverim' },
      { id: 'g2', name: 'Chaverim' },
      { id: 'g3', name: 'Bogrim' },
    ]
    const { map, ambiguous } = mapWithCollisions(rows, (r) => r.name, (r) => r.id)

    expect(map.get('Bogrim')).toBe('g3')
    expect(ambiguous.has('Bogrim')).toBe(false)
  })
})
