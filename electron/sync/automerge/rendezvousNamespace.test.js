// @vitest-environment node
import { describe, it, expect } from 'vitest'
import * as A from '@automerge/automerge'
import { createEmptyDoc, recordKey } from '../../automerge/campDocument.js'
import {
  readRendezvousNamespace,
  mintRendezvousNamespace,
  rotateRendezvousNamespace,
} from './rendezvousNamespace.js'
import { readRendezvousAddressKey } from './rendezvousAddressKey.js'

const CAMP_ID = 'camp-1'

function fakeRandomBytesSequence(hexValues) {
  let i = 0
  return () => {
    const hex = hexValues[i] ?? hexValues[hexValues.length - 1]
    i++
    return Buffer.from(hex, 'hex')
  }
}

describe('readRendezvousNamespace', () => {
  it('returns null when rendezvous was never enabled for the camp', () => {
    const doc = createEmptyDoc()
    expect(readRendezvousNamespace(doc, CAMP_ID)).toBeNull()
  })
})

describe('mintRendezvousNamespace', () => {
  it('mints a fresh 32-byte namespace and starts epoch at 1', () => {
    const doc = createEmptyDoc()
    const result = mintRendezvousNamespace(doc, CAMP_ID)
    expect(result.minted).toBe(true)
    expect(result.epoch).toBe(1)
    expect(Buffer.from(result.namespace, 'hex').length).toBe(32)
    expect(readRendezvousNamespace(result.doc, CAMP_ID)).toEqual({ namespace: result.namespace, epoch: 1 })
  })

  it('is idempotent-safe: minting again does not overwrite an existing namespace', () => {
    const doc = createEmptyDoc()
    const first = mintRendezvousNamespace(doc, CAMP_ID, { randomBytes: fakeRandomBytesSequence(['aa'.repeat(32)]) })
    const second = mintRendezvousNamespace(first.doc, CAMP_ID, {
      randomBytes: fakeRandomBytesSequence(['bb'.repeat(32)]),
    })
    expect(second.minted).toBe(false)
    expect(second.namespace).toBe(first.namespace)
    expect(second.epoch).toBe(first.epoch)
    expect(readRendezvousNamespace(second.doc, CAMP_ID)).toEqual({ namespace: first.namespace, epoch: 1 })
  })
})

describe('rotateRendezvousNamespace', () => {
  it('changes the namespace and increments the epoch together', () => {
    const doc = createEmptyDoc()
    const minted = mintRendezvousNamespace(doc, CAMP_ID, { randomBytes: fakeRandomBytesSequence(['11'.repeat(32)]) })
    const rotated = rotateRendezvousNamespace(minted.doc, CAMP_ID, {
      randomBytes: fakeRandomBytesSequence(['22'.repeat(32)]),
    })
    expect(rotated.namespace).not.toBe(minted.namespace)
    expect(rotated.epoch).toBe(minted.epoch + 1)
    expect(readRendezvousNamespace(rotated.doc, CAMP_ID)).toEqual({ namespace: rotated.namespace, epoch: 2 })
  })

  it('rotating from a never-enabled state starts epoch at 1', () => {
    const doc = createEmptyDoc()
    const rotated = rotateRendezvousNamespace(doc, CAMP_ID, { randomBytes: fakeRandomBytesSequence(['33'.repeat(32)]) })
    expect(rotated.epoch).toBe(1)
  })

  it('rotating twice keeps incrementing the epoch monotonically', () => {
    const doc = createEmptyDoc()
    const r1 = rotateRendezvousNamespace(doc, CAMP_ID, { randomBytes: fakeRandomBytesSequence(['44'.repeat(32)]) })
    const r2 = rotateRendezvousNamespace(r1.doc, CAMP_ID, { randomBytes: fakeRandomBytesSequence(['55'.repeat(32)]) })
    expect(r2.epoch).toBe(2)
    expect(r2.namespace).not.toBe(r1.namespace)
  })

  it('does not touch any device-local sequence state (this module never opens that table)', () => {
    // Structural assertion: rotate only ever returns {doc, namespace, epoch} — there is no seq
    // field in its return shape, and no db/table argument for it to have mutated.
    const doc = createEmptyDoc()
    const rotated = rotateRendezvousNamespace(doc, CAMP_ID)
    expect(Object.keys(rotated).sort()).toEqual(['doc', 'epoch', 'namespace'])
  })
})

// T210 round 2, item 1: concurrent rotation must never split the namespace/epoch pair. Real
// Automerge fork/merge, in the style of electron/automerge/reconcile.test.js's `diverge` helper —
// not a mock — because the property under test is what Automerge's own per-key conflict
// resolution actually does to two concurrent writes.
describe('concurrent rotation is atomic (namespace and epoch can never split)', () => {
  it('a merge of two concurrent rotations yields one ORIGINAL pair, never a mix', () => {
    const base = mintRendezvousNamespace(createEmptyDoc(), CAMP_ID, {
      randomBytes: () => Buffer.from('00'.repeat(32), 'hex'),
    }).doc

    const rotatedA = rotateRendezvousNamespace(A.clone(base), CAMP_ID, {
      randomBytes: () => Buffer.from('aa'.repeat(32), 'hex'),
    })
    const rotatedB = rotateRendezvousNamespace(A.clone(base), CAMP_ID, {
      randomBytes: () => Buffer.from('bb'.repeat(32), 'hex'),
    })

    const merged = A.merge(A.clone(rotatedA.doc), rotatedB.doc)
    const survivor = readRendezvousNamespace(merged, CAMP_ID)

    // The survivor must be exactly one of the two whole pairs a device actually produced —
    // never A's namespace with B's epoch or vice versa.
    const validPairs = [
      { namespace: rotatedA.namespace, epoch: rotatedA.epoch },
      { namespace: rotatedB.namespace, epoch: rotatedB.epoch },
    ]
    expect(validPairs).toContainEqual(survivor)
  })

  it('rejects a malformed stored value instead of silently parsing it', () => {
    const minted = mintRendezvousNamespace(createEmptyDoc(), CAMP_ID)
    const corrupted = A.change(minted.doc, (d) => {
      d.camps[recordKey(CAMP_ID, 'rendezvousSecrets')] = 'garbage'
    })
    expect(() => readRendezvousNamespace(corrupted, CAMP_ID)).toThrow(/malformed/i)
  })
})

describe('one atomic rendezvous tuple, with a legacy fallback (WAN-ladder F1 round 2)', () => {
  const raw = (doc, field, value) => A.change(doc, (d) => {
    if (!d.camps) d.camps = {}
    d.camps[recordKey('camp-1', field)] = value
  })
  const legacyNs = 'c'.repeat(64)
  const legacyKey = 'd'.repeat(64)
  const legacyDoc = () => raw(raw(createEmptyDoc(), 'rendezvousDiscovery', `v1:4:${legacyNs}`), 'rendezvousAddressKey', legacyKey)

  it('reads the legacy fields as the current tuple when the new field is absent', () => {
    const doc = legacyDoc()
    expect(readRendezvousNamespace(doc, 'camp-1')).toEqual({ epoch: 4, namespace: legacyNs })
    expect(readRendezvousAddressKey(doc, 'camp-1')).toBe(legacyKey)
    expect(mintRendezvousNamespace(doc, 'camp-1').minted).toBe(false)
  })

  it('the next rotation writes ONE new field and never touches the legacy fields', () => {
    const doc = legacyDoc()
    const rotated = rotateRendezvousNamespace(doc, 'camp-1').doc
    const read = readRendezvousNamespace(rotated, 'camp-1')
    expect(read.epoch).toBe(5)
    expect(read.namespace).not.toBe(legacyNs)
    expect(readRendezvousAddressKey(rotated, 'camp-1')).not.toBe(legacyKey)
    expect(rotated.camps[recordKey('camp-1', 'rendezvousSecrets')]).toMatch(/^v2:5:[0-9a-f]{64}:[0-9a-f]{64}:/)
    expect(rotated.camps[recordKey('camp-1', 'rendezvousDiscovery')]).toBe(`v1:4:${legacyNs}`)
    expect(rotated.camps[recordKey('camp-1', 'rendezvousAddressKey')]).toBe(legacyKey)
  })

  it('a fresh mint writes only the new field', () => {
    const minted = mintRendezvousNamespace(createEmptyDoc(), 'camp-1').doc
    expect(Object.keys(minted.camps).map((k) => k.split('\u0000')[1])).toEqual(['rendezvousSecrets'])
  })
})
