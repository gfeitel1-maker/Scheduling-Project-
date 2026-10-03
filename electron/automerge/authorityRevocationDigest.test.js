// T335 (docs/work/specs/2026-10-03-t335-key-turning-rotating-discovery-tag-design.md §7) — red-
// before-green tests for the pure revocation digest the rotating discovery tag HMACs against. Same
// doc-construction pattern as authorityReplay.test.js: real Automerge documents through
// createEmptyDoc/applyWrite, no mocks.
import * as Automerge from '@automerge/automerge'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { createEmptyDoc, applyWrite } from './campDocument.js'
import { revocationDigest, encodeRevokedIds } from './authorityRevocationDigest.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

let nextId = 0
function uid() {
  return `e${nextId++}`
}

function initDoc() {
  return createEmptyDoc()
}

function pushEntry(doc, entry) {
  const id = uid()
  let d = doc
  for (const [field, value] of Object.entries(entry)) {
    d = applyWrite(d, { entity: 'camp_authority_log', entity_id: id, field, value })
  }
  return d
}

describe('revocationDigest', () => {
  it('is deterministic across two merge orders of the same change set', () => {
    let base = initDoc()
    base = pushEntry(base, { kind: 'grant', target_device_id: 'A', signer_device_id: 'FOUNDER' })
    base = pushEntry(base, { kind: 'grant', target_device_id: 'B', signer_device_id: 'FOUNDER' })
    let branch1 = Automerge.clone(base)
    let branch2 = Automerge.clone(base)
    branch1 = pushEntry(branch1, { kind: 'revoke', target_device_id: 'A', signer_device_id: 'FOUNDER' })
    branch1 = pushEntry(branch1, { kind: 'revoke', target_device_id: 'A', signer_device_id: 'B' })
    branch2 = pushEntry(branch2, { kind: 'revoke', target_device_id: 'A', signer_device_id: 'FOUNDER' })
    branch2 = pushEntry(branch2, { kind: 'revoke', target_device_id: 'A', signer_device_id: 'B' })

    const mergedOrder1 = Automerge.merge(Automerge.clone(branch1), branch2)
    const mergedOrder2 = Automerge.merge(Automerge.clone(branch2), branch1)
    const d1 = revocationDigest(Automerge, mergedOrder1, { founderDeviceId: 'FOUNDER' })
    const d2 = revocationDigest(Automerge, mergedOrder2, { founderDeviceId: 'FOUNDER' })
    expect(d1).toEqual(d2)
    expect(typeof d1).toBe('string')
    expect(d1.length).toBe(64) // sha256 hex
  })

  it('a revocation changes the digest (red-before-green: today\'s static tag never would)', () => {
    let doc = initDoc()
    doc = pushEntry(doc, { kind: 'grant', target_device_id: 'A', signer_device_id: 'FOUNDER' })
    doc = pushEntry(doc, { kind: 'grant', target_device_id: 'B', signer_device_id: 'FOUNDER' })
    doc = pushEntry(doc, { kind: 'grant', target_device_id: 'C', signer_device_id: 'FOUNDER' })
    const before = revocationDigest(Automerge, doc, { founderDeviceId: 'FOUNDER' })
    doc = pushEntry(doc, { kind: 'revoke', target_device_id: 'C', signer_device_id: 'FOUNDER' })
    doc = pushEntry(doc, { kind: 'revoke', target_device_id: 'C', signer_device_id: 'A' })
    const after = revocationDigest(Automerge, doc, { founderDeviceId: 'FOUNDER' })
    expect(after).not.toEqual(before)
  })

  it('only a trusted (signed) revoke entry changes the digest', () => {
    let doc = initDoc()
    doc = pushEntry(doc, { kind: 'grant', target_device_id: 'A', signer_device_id: 'FOUNDER' })
    doc = pushEntry(doc, { kind: 'grant', target_device_id: 'C', signer_device_id: 'FOUNDER' })
    const before = revocationDigest(Automerge, doc, { founderDeviceId: 'FOUNDER' })
    doc = pushEntry(doc, { kind: 'revoke', target_device_id: 'C', signer_device_id: 'FOUNDER', signature: 'forged' })
    const isEntryTrusted = (entry) => entry.signature !== 'forged'
    const after = revocationDigest(Automerge, doc, { founderDeviceId: 'FOUNDER', isEntryTrusted })
    expect(after).toEqual(before) // untrusted revoke never moved the digest
  })
})

// T335 gate finding (Red Hat LOW, round 2) — a bare `.join(',')` lets two different revoked sets
// collide when a device id itself contains a comma: ['a,b', 'c'] and ['a', 'b,c'] both join to
// "a,b,c". encodeRevokedIds must disambiguate these.
describe('encodeRevokedIds — collision-safe encoding', () => {
  it('does not collide when a device id contains the delimiter character', () => {
    const encodedA = encodeRevokedIds(['a,b', 'c'])
    const encodedB = encodeRevokedIds(['a', 'b,c'])
    expect(encodedA).not.toEqual(encodedB)
  })

  it('is still deterministic for the same sorted input', () => {
    expect(encodeRevokedIds(['A', 'B'])).toEqual(encodeRevokedIds(['A', 'B']))
  })
})

// T335 §7.4 — the structural test that would have caught T329's F1 at design time: assert neither
// new file writes to the document. A grep-based check, not a runtime assertion, because the defect
// class is "a write call exists at all" — no fixture can safely exercise an absent-by-construction
// write path, only reading the source proves it is absent.
describe('structural: no document write in the new derivation files', () => {
  it('authorityRevocationDigest.js contains no A.change / write call', () => {
    const src = fs.readFileSync(path.join(__dirname, 'authorityRevocationDigest.js'), 'utf8')
    expect(src).not.toMatch(/\bA\.change\b/)
    expect(src).not.toMatch(/\bapplyWrite\b/)
    expect(src).not.toMatch(/\.change\(/)
  })

  it('rotatingDiscoveryTag.js contains no A.change / write call', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'sync', 'automerge', 'rotatingDiscoveryTag.js'), 'utf8')
    expect(src).not.toMatch(/\bA\.change\b/)
    expect(src).not.toMatch(/\bapplyWrite\b/)
    expect(src).not.toMatch(/\.change\(/)
  })
})
