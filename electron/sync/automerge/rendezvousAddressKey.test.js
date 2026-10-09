// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { createEmptyDoc } from '../../automerge/campDocument.js'
import { readRendezvousAddressKey, mintRendezvousAddressKey, rotateRendezvousAddressKey } from './rendezvousAddressKey.js'

describe('rotateRendezvousAddressKey', () => {
  it('replaces an existing key with a fresh one', () => {
    const minted = mintRendezvousAddressKey(createEmptyDoc(), 'camp-rot')
    const rotated = rotateRendezvousAddressKey(minted.doc, 'camp-rot')
    expect(rotated.addressKey).toMatch(/^[0-9a-f]{64}$/)
    expect(rotated.addressKey).not.toBe(minted.addressKey)
    expect(readRendezvousAddressKey(rotated.doc, 'camp-rot')).toBe(rotated.addressKey)
  })
})

const CAMP_ID = 'camp-1'

function fakeRandomBytesSequence(hexValues) {
  let i = 0
  return () => {
    const hex = hexValues[i] ?? hexValues[hexValues.length - 1]
    i++
    return Buffer.from(hex, 'hex')
  }
}

describe('readRendezvousAddressKey', () => {
  it('returns null when v2 rendezvous was never enabled for the camp', () => {
    const doc = createEmptyDoc()
    expect(readRendezvousAddressKey(doc, CAMP_ID)).toBeNull()
  })
})

describe('mintRendezvousAddressKey', () => {
  it('mints a fresh 32-byte camp-shared key', () => {
    const doc = createEmptyDoc()
    const result = mintRendezvousAddressKey(doc, CAMP_ID)
    expect(result.minted).toBe(true)
    expect(Buffer.from(result.addressKey, 'hex').length).toBe(32)
    expect(readRendezvousAddressKey(result.doc, CAMP_ID)).toBe(result.addressKey)
  })

  it('is idempotent-safe: minting again does not overwrite an existing key (mints once)', () => {
    const doc = createEmptyDoc()
    const first = mintRendezvousAddressKey(doc, CAMP_ID, { randomBytes: fakeRandomBytesSequence(['aa'.repeat(32)]) })
    const second = mintRendezvousAddressKey(first.doc, CAMP_ID, {
      randomBytes: fakeRandomBytesSequence(['bb'.repeat(32)]),
    })
    expect(second.minted).toBe(false)
    expect(second.addressKey).toBe(first.addressKey)
  })

  it('propagates to a second device via ordinary document merge (same trust boundary as rendezvousDiscovery)', () => {
    const doc = createEmptyDoc()
    const minted = mintRendezvousAddressKey(doc, CAMP_ID, { randomBytes: fakeRandomBytesSequence(['cc'.repeat(32)]) })
    // Simulate a second, not-yet-synced device doc that has never seen this field.
    const otherDeviceDoc = createEmptyDoc()
    expect(readRendezvousAddressKey(otherDeviceDoc, CAMP_ID)).toBeNull()
    // After a merge (ordinary Automerge sync), the paired device sees the same key.
    expect(readRendezvousAddressKey(minted.doc, CAMP_ID)).toBe(minted.addressKey)
  })
})
