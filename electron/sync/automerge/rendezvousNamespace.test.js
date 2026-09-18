// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { createEmptyDoc } from '../../automerge/campDocument.js'
import {
  readRendezvousNamespace,
  mintRendezvousNamespace,
  rotateRendezvousNamespace,
} from './rendezvousNamespace.js'

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
