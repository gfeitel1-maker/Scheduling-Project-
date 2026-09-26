// T257 — resolveFieldWrite's `unit` arm must accept BOTH a legacy bare-string
// value (older/non-ImportScreen callers) and a discriminated token. An
// existing-tier token's id is used DIRECTLY, never re-resolved by name —
// that's what reaches the SECOND of two same-named tiers, since a name
// lookup can only ever resolve to whichever one `tierIdByName` registered
// first. And per the ticket's finding 2 (no id in director-facing copy),
// an unresolved failure's `detail.unresolved` must carry the NAME, never
// the id/token, however it failed.
import { describe, it, expect } from 'vitest'
import { resolveFieldWrite, unitDisplayName } from './fieldUpdate.js'

const maps = (tierIdByName) => ({ groupIdByName: new Map(), tierIdByName, locationIdByName: new Map() })

describe('resolveFieldWrite unit arm — token support (T257)', () => {
  it('an existing-tier token resolves via its id DIRECTLY, bypassing the name lookup entirely', () => {
    // Two same-named tiers; tierIdByName (first-write-wins) can only ever map
    // "aleph" -> the lower id. Picking the id-bearing token for the HIGHER
    // one must still resolve to it, not silently fall back to the lower one.
    const tierIdByName = new Map([['aleph', 'tier-low']])
    const res = resolveFieldWrite('unit', { kind: 'existing', id: 'tier-high', name: 'Aleph' }, maps(tierIdByName))
    expect(res).toEqual({ ok: true, field: 'tier_id', value: 'tier-high' })
  })

  it('a proposed-tier token (no id) resolves by name, same as a legacy bare string', () => {
    const tierIdByName = new Map([['gimel', 'tier-g']])
    const res = resolveFieldWrite('unit', { kind: 'proposed', name: 'Gimel' }, maps(tierIdByName))
    expect(res).toEqual({ ok: true, field: 'tier_id', value: 'tier-g' })
  })

  it('a legacy bare-string unit still resolves by name unchanged (backward compat)', () => {
    const tierIdByName = new Map([['kfar a', 'tier-1']])
    const res = resolveFieldWrite('unit', 'Kfar A', maps(tierIdByName))
    expect(res).toEqual({ ok: true, field: 'tier_id', value: 'tier-1' })
  })

  it('an unresolved token fails with the DISPLAY NAME in detail — never the id/token', () => {
    const res = resolveFieldWrite('unit', { kind: 'proposed', name: 'Nonexistent Division' }, maps(new Map()))
    expect(res.ok).toBe(false)
    expect(res.reason).toBe('unit_unresolved')
    expect(res.detail.unresolved).toEqual(['Nonexistent Division'])
    // Never a uuid-shaped value, and never the token object itself.
    expect(typeof res.detail.unresolved[0]).toBe('string')
    expect(res.detail.unresolved[0]).not.toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/i)
  })

  it('unitDisplayName never surfaces an id: a token yields its name, a string passes through', () => {
    expect(unitDisplayName({ kind: 'existing', id: 'some-uuid-1234', name: 'Bunk B' })).toBe('Bunk B')
    expect(unitDisplayName('Bunk B')).toBe('Bunk B')
    expect(unitDisplayName(null)).toBeNull()
  })
})
