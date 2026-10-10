import { describe, it, expect } from 'vitest'
import { DEFAULT_DEVICE_NAME, DEVICE_NAME_MAX, normalizeDeviceName, pairingDeviceName, sanitizePeerDeviceName } from './deviceName.js'

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

describe('Security follow-ups (#886)', () => {
  it('strips bidi overrides and invisible characters, which could spoof a name', () => {
    expect(normalizeDeviceName('Director‮ dapi​﻿')).toBe('Director dapi')
    expect(() => normalizeDeviceName('‮⁦‏')).toThrow(/empty/)
  })

  it('sanitizes a peer-supplied pairing name without throwing: stripped, capped, never empty', () => {
    expect(sanitizePeerDeviceName('Office‮\u0000 iPad', 'abcd1234')).toBe('Office iPad')
    expect(sanitizePeerDeviceName('y'.repeat(500), 'abcd1234')).toHaveLength(DEVICE_NAME_MAX)
    expect(sanitizePeerDeviceName('‮ \u0007', 'abcd1234')).toBe('Device abcd')
    expect(sanitizePeerDeviceName(42, 'abcd1234')).toBe('Device abcd')
  })
})
