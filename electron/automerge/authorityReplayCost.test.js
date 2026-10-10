// Startup hang on an import-sized camp (2026-10-10, packaged 1e059e95): the rendezvous rotation
// check reached buildEntryChangeIndexFrom, which replayed the WHOLE document one change at a
// time, and did so several times per check. These tests bound that work by counting the
// automerge calls, not wall clock, and check that the faster index is identical to the
// one-change-at-a-time replay it replaces.
import * as Automerge from '@automerge/automerge'
import { describe, expect, it } from 'vitest'
import { createEmptyDoc, applyWrite } from './campDocument.js'
import { createAuthorityReplayContext, createVerifiedEntryTrust, currentRevokedDeviceIds, entryChangeHashIndex, AUTHORITY_LOG_ENTITY, isCompleteEntry } from './authorityReplay.js'
import { listRecordIds, readRecord } from './campDocument.js'

function counting() {
  const calls = { applyChanges: 0, getAllChanges: 0 }
  const am = {
    ...Automerge,
    applyChanges: (...a) => { calls.applyChanges++; return Automerge.applyChanges(...a) },
    getAllChanges: (...a) => { calls.getAllChanges++; return Automerge.getAllChanges(...a) },
  }
  return { am, calls }
}

let n = 0
function entry(doc, fields) {
  const id = `auth${n++}`
  for (const [field, value] of Object.entries(fields)) doc = applyWrite(doc, { entity: AUTHORITY_LOG_ENTITY, entity_id: id, field, value })
  return doc
}

// A camp shaped like an import: thousands of ordinary field writes, a few authority entries
// spread through them (including a re-grant, which makes resolveAuthorityPeerIds compare).
function importSizedDoc(noise = 3000) {
  let doc = createEmptyDoc()
  doc = entry(doc, { kind: 'genesis', target_device_id: 'FOUNDER', target_peer_id: 'pF' })
  for (let i = 0; i < noise; i++) {
    doc = applyWrite(doc, { entity: 'activities', entity_id: `c${i % 400}`, field: 'name', value: `v${i}` })
    if (i === noise / 3) doc = entry(doc, { kind: 'grant', target_device_id: 'A', signer_device_id: 'FOUNDER', target_peer_id: 'pA' })
    if (i === (2 * noise) / 3) doc = entry(doc, { kind: 'grant', target_device_id: 'A', signer_device_id: 'FOUNDER', target_peer_id: 'pA2' })
  }
  return doc
}

// The previous algorithm, kept here as the exactness oracle.
function perChangeIndex(doc) {
  let scratch = Automerge.init()
  const index = new Map()
  for (const change of Automerge.getAllChanges(doc)) {
    const { hash } = Automerge.decodeChange(change)
    ;[scratch] = Automerge.applyChanges(scratch, [change])
    for (const id of listRecordIds(scratch, AUTHORITY_LOG_ENTITY)) {
      if (index.has(id)) continue
      if (isCompleteEntry(readRecord(scratch, AUTHORITY_LOG_ENTITY, id))) index.set(id, hash)
    }
  }
  return index
}

describe('authority replay cost on an import-sized document', () => {
  const doc = importSizedDoc()
  const authorityChanges = 4 + 4 + 4 // three entries, at most four field writes each

  it('a full rotation-style check applies only authority changes and reads the history once', () => {
    const { am, calls } = counting()
    const isEntryTrusted = createVerifiedEntryTrust(am, doc)
    currentRevokedDeviceIds(am, doc, { isEntryTrusted })
    createAuthorityReplayContext(am, doc, { isEntryTrusted: createVerifiedEntryTrust(am, doc) }).currentState()
    expect(calls.applyChanges).toBeLessThanOrEqual(authorityChanges)
    expect(calls.getAllChanges).toBe(1)
  })

  it('the batched index is identical to the one-change-at-a-time replay', () => {
    const small = importSizedDoc(600)
    expect([...entryChangeHashIndex(Automerge, small)].sort()).toEqual([...perChangeIndex(small)].sort())
  })

  it('stays identical when authority entries arrive by merge, concurrent with other edits', () => {
    let base = importSizedDoc(200)
    let left = Automerge.clone(base, { actor: 'aa'.repeat(16) })
    let right = Automerge.clone(base, { actor: 'bb'.repeat(16) })
    right = entry(right, { kind: 'grant', target_device_id: 'B', signer_device_id: 'FOUNDER', target_peer_id: 'pB' })
    for (let i = 0; i < 50; i++) left = applyWrite(left, { entity: 'activities', entity_id: `x${i}`, field: 'name', value: 'n' })
    left = entry(left, { kind: 'revoke', target_device_id: 'A', signer_device_id: 'FOUNDER' })
    const merged = Automerge.merge(left, right)
    expect([...entryChangeHashIndex(Automerge, merged)].sort()).toEqual([...perChangeIndex(merged)].sort())
  })
})
