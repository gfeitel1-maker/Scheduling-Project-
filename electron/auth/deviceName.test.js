import { describe, it, expect } from 'vitest'
import { DEFAULT_DEVICE_NAME, normalizeDeviceName, pairingDeviceName } from './deviceName.js'

describe('normalizeDeviceName', () => {
  it('trims and strips control characters', () => {
    expect(normalizeDeviceName('  Front\u0000 Office\n ')).toBe('Front Office')
  })
  it('rejects empty and overlong names', () => {
    expect(() => normalizeDeviceName('   ')).toThrow(/empty/)
    expect(() => normalizeDeviceName('\u0007')).toThrow(/empty/)
    expect(() => normalizeDeviceName('x'.repeat(41))).toThrow(/40/)
    expect(normalizeDeviceName('x'.repeat(40))).toHaveLength(40)
  })
})

describe('pairingDeviceName', () => {
  it('replaces the seeded default with Device <first 4 of id>', () => {
    expect(pairingDeviceName(DEFAULT_DEVICE_NAME, 'abcd1234-x')).toBe('Device abcd')
  })
  it('sends a chosen name as chosen', () => {
    expect(pairingDeviceName('Office laptop', 'abcd1234')).toBe('Office laptop')
  })
})
