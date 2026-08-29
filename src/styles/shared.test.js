import { describe, it, expect } from 'vitest'
import { S } from './shared'

describe('S.cautionBanner', () => {
  it('uses the bronze --accent caution role via color-mix, not a hardcoded amber hex', () => {
    expect(S.cautionBanner).toBeDefined()
    expect(S.cautionBanner.background).toMatch(/color-mix\(in srgb, var\(--accent\)/)
    expect(S.cautionBanner.border).toMatch(/var\(--accent\)/)
    expect(S.cautionBanner.color).toMatch(/var\(--accent\)|var\(--text\)/)
    expect(JSON.stringify(S.cautionBanner)).not.toMatch(/#[0-9a-fA-F]{3,6}/)
  })
})

describe('S.chip', () => {
  it('renders a filled pill with white text when selected/on', () => {
    const style = S.chip('var(--primary)', true)
    expect(style.background).toBe('var(--primary)')
    expect(style.color).toBe('#fff')
    expect(style.borderRadius).toBe(20)
  })

  it('renders the unfilled/off state with the surface + text tokens', () => {
    const style = S.chip('var(--primary)', false)
    expect(style.background).toBe('var(--surface)')
    expect(style.color).toBe('var(--text)')
  })

  it('accepts overrides for radius/padding/fontSize/border without re-deriving the fill logic', () => {
    const style = S.chip('var(--warning)', true, { borderRadius: 99, padding: '2px 8px', fontSize: 11, border: 'none' })
    expect(style.borderRadius).toBe(99)
    expect(style.padding).toBe('2px 8px')
    expect(style.fontSize).toBe(11)
    expect(style.border).toBe('none')
    expect(style.background).toBe('var(--warning)')
    expect(style.color).toBe('#fff')
  })

  it('centralizes the filled-chip text color in the primitive (the one place #fff is allowed)', () => {
    // This guards only that the primitive OWNS the #fff literal — the point of
    // consolidation is that call sites reach it through S.chip rather than
    // re-hardcoding. (It does not, and cannot from here, prove no other file
    // hardcodes #fff — that boundary is enforced by review, not this test.)
    expect(S.chip('var(--primary)', true).color).toBe('#fff')
  })
})
