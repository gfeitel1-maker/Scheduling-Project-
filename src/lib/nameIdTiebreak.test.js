import { describe, it, expect } from 'vitest'
import { lowestIdOf } from './nameIdTiebreak'

describe('lowestIdOf', () => {
  it('returns the row with the lowest id regardless of array order', () => {
    const rows = [{ id: 'z2', name: 'Pool' }, { id: 'a1', name: 'Pool' }, { id: 'm5', name: 'Pool' }]
    expect(lowestIdOf(rows).id).toBe('a1')
  })

  it('is order-independent — reversing the input picks the same winner', () => {
    const rows = [{ id: 'a1', name: 'Pool' }, { id: 'z2', name: 'Pool' }]
    const reversed = [...rows].reverse()
    expect(lowestIdOf(rows).id).toBe(lowestIdOf(reversed).id)
    expect(lowestIdOf(rows).id).toBe('a1')
  })

  it('returns the single row unchanged when there is no ambiguity', () => {
    const rows = [{ id: 'only1', name: 'Gym' }]
    expect(lowestIdOf(rows)).toEqual({ id: 'only1', name: 'Gym' })
  })

  it('returns null for an empty array', () => {
    expect(lowestIdOf([])).toBe(null)
  })

  it('returns null for a nullish input', () => {
    expect(lowestIdOf(undefined)).toBe(null)
    expect(lowestIdOf(null)).toBe(null)
  })
})

// The contract is BYTE order, matching SQL `ORDER BY id ASC` on a TEXT column —
// which is what the db-bound precedents (nameMap, seedNameMaps) do. That
// distinction is invisible with hex/uuid ids, so it needs pinning explicitly:
// for ids that LOOK numeric, byte order and numeric order disagree ('10' sorts
// before '9'), and a future reader "fixing" this into a numeric sort would make
// the renderer disagree with the host about which row wins — the two would
// resolve the same name to different rows, which is the whole failure this
// helper exists to remove.
//
// Found by mutation: reversing the comparison was caught, but swapping in a
// numeric sort was caught only incidentally, because Number('a1') is NaN. With
// numeric-looking ids it slipped straight through.
describe('the tie-break is byte order, matching SQL ORDER BY id ASC on TEXT', () => {
  it("picks '10' over '9', because that is what the host's ORDER BY does", () => {
    expect(lowestIdOf([{ id: '9' }, { id: '10' }]).id).toBe('10')
    expect(lowestIdOf([{ id: '10' }, { id: '9' }]).id).toBe('10')
  })

  it('is case-sensitive byte order, not a locale collation', () => {
    // 'B' (0x42) sorts before 'a' (0x61) in byte order; many locale collations
    // would say 'a' first. SQLite's default BINARY collation says 'B'.
    expect(lowestIdOf([{ id: 'a-row' }, { id: 'B-row' }]).id).toBe('B-row')
  })
})
