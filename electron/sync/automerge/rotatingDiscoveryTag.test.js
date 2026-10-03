// T335 (docs/work/specs/2026-10-03-t335-key-turning-rotating-discovery-tag-design.md §7) — red-
// before-green tests for the rotating discovery tag: HMAC(campDhtSecret, revocationDigest).
import * as Automerge from '@automerge/automerge'
import { describe, expect, it } from 'vitest'
import { createEmptyDoc, applyWrite } from '../../automerge/campDocument.js'
import { mintRendezvousNamespace } from './rendezvousNamespace.js'
import { rotatingDiscoveryDigest } from './rotatingDiscoveryTag.js'

const CAMP_ID = 'camp-1'

let nextId = 0
function uid() {
  return `e${nextId++}`
}

function pushEntry(doc, entry) {
  const id = uid()
  let d = doc
  for (const [field, value] of Object.entries(entry)) {
    d = applyWrite(d, { entity: 'camp_authority_log', entity_id: id, field, value })
  }
  return d
}

function mintedDoc() {
  const doc = createEmptyDoc()
  const { doc: minted } = mintRendezvousNamespace(doc, CAMP_ID)
  return minted
}

describe('rotatingDiscoveryDigest', () => {
  it('throws when no discovery secret has been minted for the camp', () => {
    const doc = createEmptyDoc()
    expect(() => rotatingDiscoveryDigest(Automerge, doc, CAMP_ID, { founderDeviceId: 'FOUNDER' })).toThrow()
  })

  it('is deterministic for the same document state', () => {
    let doc = mintedDoc()
    doc = pushEntry(doc, { kind: 'grant', target_device_id: 'A', signer_device_id: 'FOUNDER' })
    const tag1 = rotatingDiscoveryDigest(Automerge, doc, CAMP_ID, { founderDeviceId: 'FOUNDER' })
    const tag2 = rotatingDiscoveryDigest(Automerge, doc, CAMP_ID, { founderDeviceId: 'FOUNDER' })
    expect(tag1).toEqual(tag2)
    expect(tag1.length).toBe(32)
  })

  // §7.2 — the literal red-before-green the ADR demands: a revocation must change the tag.
  it('a revocation advances the tag', () => {
    let doc = mintedDoc()
    doc = pushEntry(doc, { kind: 'grant', target_device_id: 'A', signer_device_id: 'FOUNDER' })
    doc = pushEntry(doc, { kind: 'grant', target_device_id: 'C', signer_device_id: 'FOUNDER' })
    const before = rotatingDiscoveryDigest(Automerge, doc, CAMP_ID, { founderDeviceId: 'FOUNDER' })
    doc = pushEntry(doc, { kind: 'revoke', target_device_id: 'C', signer_device_id: 'FOUNDER' })
    doc = pushEntry(doc, { kind: 'revoke', target_device_id: 'C', signer_device_id: 'A' })
    const after = rotatingDiscoveryDigest(Automerge, doc, CAMP_ID, { founderDeviceId: 'FOUNDER' })
    expect(after).not.toEqual(before)
  })

  // §7.3 — a device cut off at a prior causal state cannot derive the post-revocation tag: its
  // frozen replay yields a different revoked-set digest, hence a different tag, than a trusted
  // device holding the full state.
  it('a frozen (cut-off) device computes a different tag than trusted peers once a later revocation lands', () => {
    let doc = mintedDoc()
    doc = pushEntry(doc, { kind: 'grant', target_device_id: 'A', signer_device_id: 'FOUNDER' })
    doc = pushEntry(doc, { kind: 'grant', target_device_id: 'D', signer_device_id: 'FOUNDER' })
    doc = pushEntry(doc, { kind: 'grant', target_device_id: 'C', signer_device_id: 'FOUNDER' })
    const frozenAtD = Automerge.clone(doc) // D's doc is frozen here — cut off from further sync
    doc = pushEntry(doc, { kind: 'revoke', target_device_id: 'C', signer_device_id: 'FOUNDER' })
    doc = pushEntry(doc, { kind: 'revoke', target_device_id: 'C', signer_device_id: 'A' })

    const trustedTag = rotatingDiscoveryDigest(Automerge, doc, CAMP_ID, { founderDeviceId: 'FOUNDER' })
    const frozenTag = rotatingDiscoveryDigest(Automerge, frozenAtD, CAMP_ID, { founderDeviceId: 'FOUNDER' })
    expect(frozenTag).not.toEqual(trustedTag)
  })

  it('only a trusted (signed) revoke entry moves the tag', () => {
    let doc = mintedDoc()
    doc = pushEntry(doc, { kind: 'grant', target_device_id: 'C', signer_device_id: 'FOUNDER' })
    const before = rotatingDiscoveryDigest(Automerge, doc, CAMP_ID, { founderDeviceId: 'FOUNDER' })
    doc = pushEntry(doc, { kind: 'revoke', target_device_id: 'C', signer_device_id: 'FOUNDER', signature: 'forged' })
    const isEntryTrusted = (entry) => entry.signature !== 'forged'
    const after = rotatingDiscoveryDigest(Automerge, doc, CAMP_ID, { founderDeviceId: 'FOUNDER', isEntryTrusted })
    expect(after).toEqual(before)
  })
})
