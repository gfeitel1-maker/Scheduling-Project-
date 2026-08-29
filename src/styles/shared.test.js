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
