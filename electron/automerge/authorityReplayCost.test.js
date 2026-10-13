// Startup hang on an import-sized camp (2026-10-10, packaged 1e059e95): the rendezvous rotation
// check replayed the WHOLE document one change at a time, and did so several times per check.
// These tests bound that work by counting the automerge calls, not wall clock, and check that
// signedEntries finds each entry in the one change that wrote it, on adversarial document shapes.
import { describe, expect, it, vi } from 'vitest'

const decoded = vi.hoisted(() => ({ largest: 0, calls: 0 }))
vi.mock('@automerge/automerge', async (importOriginal) => {
  const real = await importOriginal()
  return { ...real, decodeChange: (bytes) => { decoded.calls++; decoded.largest = Math.max(decoded.largest, bytes.length); return real.decodeChange(bytes) } }
})

const Automerge = await import('@automerge/automerge')
const { createEmptyDoc, applyWrite } = await import('./campDocument.js')
const { makeTestCamp, writeAuthorityEntry } = await import('./genesisTestKit.js')
const { createAuthorityReplayContext, createVerifiedEntryTrust, currentRevokedDeviceIds, signedEntries, AUTHORITY_LOG_ENTITY } = await import('./authorityReplay.js')

function counting() {
  const calls = { applyChanges: 0, getAllChanges: 0 }
  const am = {
    ...Automerge,
    applyChanges: (...a) => { calls.applyChanges++; return Automerge.applyChanges(...a) },
    getAllChanges: (...a) => { calls.getAllChanges++; return Automerge.getAllChanges(...a) },
  }
  return { am, calls }
}

const camp = makeTestCamp('camp-cost')
const root = camp.root

let n = 0
// Writes one entry as one change and returns [doc, hash of that change].
function entry(doc, fields, fixedId) {
  const id = fixedId ?? `auth${n++}`
  const next = writeAuthorityEntry(doc, id, { target_peer_id: '', signature: 'unsigned', ...fields })
  return [next, Automerge.getHeads(next)[0], id]
}
function genesis(doc, id = 'g-founder') {
  return entry(doc, camp.genesisFields({ id, deviceId: 'FOUNDER', peerId: 'pF' }), id)
}
const indexOf = (am, doc) => new Map(signedEntries(am, doc).map((e) => [e.id, e.changeHash]))

// A camp shaped like an import: thousands of ordinary field writes, a few authority entries
// spread through them (including a re-grant, which makes resolveAuthorityPeerIds compare).
function importSizedDoc(noise = 3000) {
  const expected = new Map()
  let doc = createEmptyDoc()
  let h, id
  ;[doc, h, id] = genesis(doc)
  expected.set(id, h)
  for (let i = 0; i < noise; i++) {
    doc = applyWrite(doc, { entity: 'activities', entity_id: `c${i % 400}`, field: 'name', value: `v${i}` })
    if (i === noise / 3 || i === (2 * noise) / 3) {
      ;[doc, h, id] = entry(doc, { kind: 'grant', target_device_id: 'A', signer_device_id: 'FOUNDER', target_peer_id: i === noise / 3 ? 'pA' : 'pA2' })
      expected.set(id, h)
    }
  }
  return { doc, expected }
}

describe('authority replay cost on an import-sized document', () => {
  const { doc, expected } = importSizedDoc()

  it('a full rotation-style check never replays, decodes or re-reads the history', () => {
    const { am, calls } = counting()
    const isEntryTrusted = createVerifiedEntryTrust(am, doc, root)
    currentRevokedDeviceIds(am, doc, { root, isEntryTrusted })
    createAuthorityReplayContext(am, doc, { root, isEntryTrusted: createVerifiedEntryTrust(am, doc, root) }).currentState()
    expect(calls.applyChanges).toBe(0)
    expect(calls.getAllChanges).toBe(0)
  })

  it('each entry is found at the change that wrote it', () => {
    expect([...indexOf(Automerge, doc)].sort()).toEqual([...expected].sort())
  })

  it('stays exact when authority entries arrive by merge, concurrent with other edits', () => {
    const { doc: base, expected: want } = importSizedDoc(200)
    let left = Automerge.clone(base, { actor: 'aa'.repeat(16) })
    let right = Automerge.clone(base, { actor: 'bb'.repeat(16) })
    let h, id
    ;[right, h, id] = entry(right, { kind: 'grant', target_device_id: 'B', signer_device_id: 'FOUNDER', target_peer_id: 'pB' })
    want.set(id, h)
    for (let i = 0; i < 50; i++) left = applyWrite(left, { entity: 'activities', entity_id: `x${i}`, field: 'name', value: 'n' })
    ;[left, h, id] = entry(left, { kind: 'revoke', target_device_id: 'A', signer_device_id: 'FOUNDER' })
    want.set(id, h)
    const merged = Automerge.merge(left, right)
    expect([...indexOf(Automerge, merged)].sort()).toEqual([...want].sort())
    expect([...indexOf(Automerge, Automerge.merge(Automerge.clone(right), left))].sort()).toEqual([...want].sort())
  })

  it('an import-sized change is never decoded, and the entries are still found', () => {
    let d = createEmptyDoc()
    let h, id
    const want = new Map()
    ;[d, h, id] = genesis(d)
    want.set(id, h)
    d = applyWrite(d, { entity: 'activities', entity_id: 'big', field: 'name', value: 'x'.repeat(200_000) })
    ;[d, h, id] = entry(d, { kind: 'grant', target_device_id: 'A', signer_device_id: 'FOUNDER', target_peer_id: 'pA' })
    want.set(id, h)
    decoded.largest = 0
    expect([...indexOf(Automerge, d)].sort()).toEqual([...want].sort())
    expect(decoded.largest).toBeLessThanOrEqual(16 * 1024)
  })

  it('a pile of junk records that never complete costs no replay and changes nothing', () => {
    let d = genesis(createEmptyDoc())[0]
    for (let i = 0; i < 300; i++) d = applyWrite(d, { entity: AUTHORITY_LOG_ENTITY, entity_id: `junk${i}`, field: 'kind', value: 'grant' })
    const { am, calls } = counting()
    expect(indexOf(am, d).size).toBe(1)
    expect(calls.applyChanges + calls.getAllChanges).toBe(0)
  })
})

// Shapes from the Security review of the first round.
describe('signedEntries on adversarial shapes', () => {
  const raw = (doc, fn, opts) => Automerge.change(doc, opts ?? {}, fn)
  const ids = (doc) => [...indexOf(Automerge, doc).keys()].sort()

  it('fields written by separate changes never form an entry, however they are completed', () => {
    let doc = createEmptyDoc()
    for (const [field, value] of Object.entries({ kind: 'grant', target_device_id: 'T', target_peer_id: '', signer_device_id: 'F', signature: 'sig' })) {
      doc = applyWrite(doc, { entity: AUTHORITY_LOG_ENTITY, entity_id: 'split', field, value })
    }
    expect(ids(doc)).toEqual([])
  })

  it('a large change with an entry beside it still finds the entry, and a later small change cannot complete a partial one', () => {
    let doc = createEmptyDoc()
    doc = raw(doc, (d) => {
      if (!d[AUTHORITY_LOG_ENTITY]) d[AUTHORITY_LOG_ENTITY] = {}
      d[AUTHORITY_LOG_ENTITY]['big\u0000kind'] = 'grant'
      d[AUTHORITY_LOG_ENTITY]['big\u0000signer_device_id'] = 'F'
      d[AUTHORITY_LOG_ENTITY]['big\u0000target_device_id'] = ''
      d.padding = 'p'.repeat(40_000)
    })
    doc = raw(doc, (d) => { Automerge.splice(d, [AUTHORITY_LOG_ENTITY, 'big\u0000target_device_id'], 0, 0, 'T') })
    expect(ids(doc)).toEqual([])
    const [withEntry, , id] = entry(doc, { kind: 'grant', target_device_id: 'A', signer_device_id: 'F' })
    expect(ids(withEntry)).toEqual([id])
  })

  it('a concurrent re-creation of the collection by another actor, merged both ways, keeps the entry', () => {
    const [base] = entry(createEmptyDoc(), { kind: 'genesis', target_device_id: 'F' }, 'g')
    let left = Automerge.clone(base, { actor: 'aa'.repeat(16) })
    let right = Automerge.clone(base, { actor: 'ff'.repeat(16) })
    right = raw(right, (d) => { d[AUTHORITY_LOG_ENTITY] = { 'z\u0000kind': 'genesis', 'z\u0000target_device_id': 'Z' } })
    ;[left] = entry(left, { kind: 'grant', target_device_id: 'A', signer_device_id: 'F' }, 'gr')
    expect(ids(Automerge.merge(Automerge.clone(left), right))).toEqual(['g', 'gr'])
    expect(ids(Automerge.merge(Automerge.clone(right), left))).toEqual(['g', 'gr'])
  })

  it('a decoy collection key on another object, and delete then re-create of the collection', () => {
    let doc = entry(createEmptyDoc(), { kind: 'genesis', target_device_id: 'F' }, 'g')[0]
    doc = raw(doc, (d) => { d.decoy = { [AUTHORITY_LOG_ENTITY]: 'x' } })
    doc = raw(doc, (d) => { delete d[AUTHORITY_LOG_ENTITY] })
    doc = raw(doc, (d) => { d[AUTHORITY_LOG_ENTITY] = { 'n\u0000kind': 'genesis', 'n\u0000target_device_id': 'N' } })
    expect(ids(doc)).toEqual(['g'])
  })

  for (const field of ['kind', 'target_device_id', 'signer_device_id']) {
    it(`a ${field} written as a raw string or a counter is not an entry`, () => {
      for (const odd of [() => new Automerge.Counter(0), () => new Automerge.Counter(5), () => 7, () => ({})]) {
        let doc = entry(createEmptyDoc(), { kind: 'genesis', target_device_id: 'F' }, 'g')[0]
        doc = raw(doc, (d) => {
          d[AUTHORITY_LOG_ENTITY]['o\u0000kind'] = 'grant'
          d[AUTHORITY_LOG_ENTITY]['o\u0000target_device_id'] = 'T'
          d[AUTHORITY_LOG_ENTITY]['o\u0000target_peer_id'] = ''
          d[AUTHORITY_LOG_ENTITY]['o\u0000signer_device_id'] = 'F'
          d[AUTHORITY_LOG_ENTITY]['o\u0000signature'] = 'sig'
          d[AUTHORITY_LOG_ENTITY][`o\u0000${field}`] = odd()
        })
        expect(ids(doc)).toEqual(['g'])
      }
    })
  }

  it('a copy of an entry re-published later is dropped; a concurrent copy is kept', () => {
    const [base, , id] = entry(createEmptyDoc(), { kind: 'grant', target_device_id: 'A', signer_device_id: 'F', signature: 'same' }, 'dup')
    const replayAfter = writeAuthorityEntry(base, id, { kind: 'grant', target_device_id: 'A', target_peer_id: '', signer_device_id: 'F', signature: 'same' })
    expect(signedEntries(Automerge, replayAfter)).toHaveLength(1)
    const empty = createEmptyDoc()
    const a = writeAuthorityEntry(Automerge.clone(empty, { actor: 'aa'.repeat(16) }), 'dup', { kind: 'grant', target_device_id: 'A', target_peer_id: '', signer_device_id: 'F', signature: 'same' })
    const b = writeAuthorityEntry(Automerge.clone(empty, { actor: 'bb'.repeat(16) }), 'dup', { kind: 'grant', target_device_id: 'A', target_peer_id: '', signer_device_id: 'F', signature: 'same' })
    const merged = Automerge.merge(a, b)
    expect(signedEntries(Automerge, merged)).toHaveLength(2)
    expect(signedEntries(Automerge, Automerge.merge(Automerge.clone(b), a)).map((e) => e.changeHash)).toEqual(signedEntries(Automerge, merged).map((e) => e.changeHash))
  })

  // signedEntries reads through getBackend/getWithType/keys/getAll/text. If an Automerge upgrade changes
  // their shape, entries stop being found and revocations are silently ignored: fail here instead.
  it('the backend calls signedEntries relies on still return the shapes it reads', () => {
    const [doc] = entry(createEmptyDoc(), { kind: 'genesis', target_device_id: 'F' })
    const heads = Automerge.getHeads(doc)
    const backend = Automerge.getBackend(doc)
    const logRoot = backend.getWithType('_root', AUTHORITY_LOG_ENTITY, heads)
    expect(logRoot[0]).toBe('map')
    const keys = backend.keys(logRoot[1], heads)
    expect(keys.length).toBeGreaterThan(0)
    const [type, objId] = backend.getAll(logRoot[1], keys.find((k) => k.endsWith('\u0000kind')), heads)[0]
    expect(type).toBe('text')
    expect(backend.text(objId, heads)).toBe('genesis')
    const meta = Automerge.getChangesMetaSince(doc, []).at(-1)
    expect(objId.endsWith(`@${meta.actor}`)).toBe(true)
    expect(Number(objId.split('@')[0])).toBeGreaterThanOrEqual(meta.startOp)
    expect(signedEntries(Automerge, doc)).toHaveLength(1)
  })
})
