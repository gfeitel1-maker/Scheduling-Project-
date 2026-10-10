// Startup hang on an import-sized camp (2026-10-10, packaged 1e059e95): the rendezvous rotation
// check reached buildEntryChangeIndexFrom, which replayed the WHOLE document one change at a
// time, and did so several times per check. These tests bound that work by counting the
// automerge calls, not wall clock, and check that the faster index is identical to the
// one-change-at-a-time replay it replaces.
import { describe, expect, it, vi } from 'vitest'

const decoded = vi.hoisted(() => ({ largest: 0, calls: 0 }))
vi.mock('@automerge/automerge', async (importOriginal) => {
  const real = await importOriginal()
  return { ...real, decodeChange: (bytes) => { decoded.calls++; decoded.largest = Math.max(decoded.largest, bytes.length); return real.decodeChange(bytes) } }
})

const Automerge = await import('@automerge/automerge')
const { createEmptyDoc, applyWrite, listRecordIds, readRecord } = await import('./campDocument.js')
const { createAuthorityReplayContext, createVerifiedEntryTrust, currentRevokedDeviceIds, entryChangeHashIndex, AUTHORITY_LOG_ENTITY, isCompleteEntry } = await import('./authorityReplay.js')

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

  it('a full rotation-style check never replays, decodes or re-reads the history', () => {
    const { am, calls } = counting()
    const isEntryTrusted = createVerifiedEntryTrust(am, doc)
    currentRevokedDeviceIds(am, doc, { isEntryTrusted })
    createAuthorityReplayContext(am, doc, { isEntryTrusted: createVerifiedEntryTrust(am, doc) }).currentState()
    expect(calls.applyChanges).toBe(0)
    expect(calls.getAllChanges).toBe(0)
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

  it('an import-sized change is never decoded, and the index still matches', () => {
    let doc = createEmptyDoc()
    doc = entry(doc, { kind: 'genesis', target_device_id: 'FOUNDER', target_peer_id: 'pF' })
    doc = applyWrite(doc, { entity: 'activities', entity_id: 'big', field: 'name', value: 'x'.repeat(200_000) })
    doc = entry(doc, { kind: 'grant', target_device_id: 'A', signer_device_id: 'FOUNDER', target_peer_id: 'pA' })
    const oracle = perChangeIndex(doc)
    decoded.largest = 0
    expect([...entryChangeHashIndex(Automerge, doc)].sort()).toEqual([...oracle].sort())
    expect(decoded.largest).toBeLessThanOrEqual(16 * 1024)
  })
})

// Shapes from the Security review of the first round: each is checked against the
// one-change-at-a-time replay.
describe('batched index equals the per-change replay on adversarial shapes', () => {
  const same = (doc) => expect([...entryChangeHashIndex(Automerge, doc)].sort()).toEqual([...perChangeIndex(doc)].sort())
  const raw = (doc, fn, opts) => Automerge.change(doc, opts ?? {}, fn)

  it('a large change creates an entry and a later small change completes it', () => {
    let doc = createEmptyDoc()
    doc = raw(doc, (d) => {
      if (!d[AUTHORITY_LOG_ENTITY]) d[AUTHORITY_LOG_ENTITY] = {}
      d[AUTHORITY_LOG_ENTITY]['big\u0000kind'] = 'grant'
      d[AUTHORITY_LOG_ENTITY]['big\u0000signer_device_id'] = 'F'
      d[AUTHORITY_LOG_ENTITY]['big\u0000target_device_id'] = ''
      d.padding = 'p'.repeat(40_000)
    })
    doc = raw(doc, (d) => { Automerge.splice(d, [AUTHORITY_LOG_ENTITY, 'big\u0000target_device_id'], 0, 0, 'T') })
    same(doc)
  })

  it('a concurrent re-creation of the collection by another actor, merged both ways', () => {
    const base = entry(createEmptyDoc(), { kind: 'genesis', target_device_id: 'F' })
    let left = Automerge.clone(base, { actor: 'aa'.repeat(16) })
    let right = Automerge.clone(base, { actor: 'ff'.repeat(16) })
    right = raw(right, (d) => { d[AUTHORITY_LOG_ENTITY] = { 'z\u0000kind': 'genesis', 'z\u0000target_device_id': 'Z' } })
    left = entry(left, { kind: 'grant', target_device_id: 'A', signer_device_id: 'F' })
    same(Automerge.merge(Automerge.clone(left), right))
    same(Automerge.merge(Automerge.clone(right), left))
  })

  it('a decoy collection key on another object, and delete then re-create of the collection', () => {
    let doc = entry(createEmptyDoc(), { kind: 'genesis', target_device_id: 'F' })
    doc = raw(doc, (d) => { d.decoy = { [AUTHORITY_LOG_ENTITY]: 'x' } })
    doc = raw(doc, (d) => { delete d[AUTHORITY_LOG_ENTITY] })
    doc = raw(doc, (d) => { d[AUTHORITY_LOG_ENTITY] = { 'n\u0000kind': 'genesis', 'n\u0000target_device_id': 'N' } })
    same(doc)
  })

  for (const field of ['kind', 'target_device_id', 'signer_device_id']) {
    it(`a ${field} written as a raw string or a counter, later rewritten as text`, () => {
      for (const odd of [() => new Automerge.RawString('X'), () => new Automerge.Counter(0), () => new Automerge.Counter(5)]) {
        let doc = entry(createEmptyDoc(), { kind: 'genesis', target_device_id: 'F' })
        doc = raw(doc, (d) => {
          d[AUTHORITY_LOG_ENTITY]['o\u0000kind'] = 'grant'
          d[AUTHORITY_LOG_ENTITY]['o\u0000target_device_id'] = 'T'
          d[AUTHORITY_LOG_ENTITY]['o\u0000signer_device_id'] = 'F'
          d[AUTHORITY_LOG_ENTITY][`o\u0000${field}`] = odd()
        })
        doc = raw(doc, (d) => { d[AUTHORITY_LOG_ENTITY][`o\u0000${field}`] = field === 'kind' ? 'grant' : 'Y' })
        same(doc)
      }
    })
  }

  it('concurrent writes of different types to the same field, merged both ways', () => {
    const base = entry(createEmptyDoc(), { kind: 'genesis', target_device_id: 'F' })
    let a = Automerge.clone(base, { actor: '11'.repeat(16) })
    let b = Automerge.clone(base, { actor: 'ee'.repeat(16) })
    a = entry(a, { kind: 'grant', target_device_id: 'A', signer_device_id: 'F' })
    b = raw(b, (d) => {
      const log = d[AUTHORITY_LOG_ENTITY]
      for (const [i, v] of [new Automerge.Counter(0), {}, 7].entries()) {
        log[`f${i}\u0000kind`] = v
        log[`f${i}\u0000target_device_id`] = 'T'
        log[`f${i}\u0000signer_device_id`] = 'F'
      }
    })
    const ids = Object.keys(a[AUTHORITY_LOG_ENTITY]).map((k) => k.split('\u0000')[0])
    b = raw(b, (d) => { for (const id of ids) d[AUTHORITY_LOG_ENTITY][`${id}\u0000kind`] = new Automerge.Counter(0) })
    same(Automerge.merge(Automerge.clone(a), b))
    same(Automerge.merge(Automerge.clone(b), a))
  })
})

