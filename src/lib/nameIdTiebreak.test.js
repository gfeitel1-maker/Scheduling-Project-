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

// The divergence that made the contract above a claim rather than a fact.
// JS `<` is UTF-16 CODE UNIT order; SQLite's BINARY collation is UTF-8 byte
// order, which is code-point order. They disagree for exactly one shape: a
// surrogate pair (code point >= U+10000) against a BMP character in
// U+E000..U+FFFF. Plain `<` sees only the high surrogate (0xD83D here) and puts
// the astral character FIRST; SQLite puts it LAST.
//
// Not reachable through today's two call sites — ids are hex uuids or
// deriveLocationId output, and same-named rows share that derived base — but
// this helper advertises the SQL equivalence to every future caller, and an id
// derived from a director-typed name needs only an emoji to reach it.
describe('the ordering is code-point order, as SQLite BINARY is — not JS UTF-16 order', () => {
  const ASTRAL = '\u{1F600}' // U+1F600, surrogate pair D83D DE00
  const BMP = '' // U+E000, one code unit, numerically LOWER code point

  it('demonstrates that plain JS `<` would get this backwards', () => {
    // Pinning the premise, so this test cannot quietly stop testing anything
    // if a future JS engine changed string comparison.
    expect(ASTRAL < BMP).toBe(true)
    expect(ASTRAL.codePointAt(0) < BMP.codePointAt(0)).toBe(false)
  })

  it('picks the BMP id, because SQLite ORDER BY id ASC would', () => {
    expect(lowestIdOf([{ id: `x${ASTRAL}` }, { id: `x${BMP}` }]).id).toBe(`x${BMP}`)
    expect(lowestIdOf([{ id: `x${BMP}` }, { id: `x${ASTRAL}` }]).id).toBe(`x${BMP}`)
  })

  it('still orders a shared prefix by length, as a byte comparison does', () => {
    expect(lowestIdOf([{ id: 'loc' }, { id: 'loc:2' }]).id).toBe('loc')
  })
})
