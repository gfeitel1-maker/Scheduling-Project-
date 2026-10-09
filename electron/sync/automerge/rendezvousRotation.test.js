// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as A from '@automerge/automerge'
import { openLocalDb } from '../../db/localDb.js'
import { createEmptyDoc, applyWrite } from '../../automerge/campDocument.js'
import { signAuthorityEntry } from '../../automerge/authorityLogSignature.js'
import { ensureDeviceIdentity } from '../../auth/deviceIdentity.js'
import { revocationDigest } from '../../automerge/authorityRevocationDigest.js'
import { createVerifiedEntryTrust } from '../../automerge/authorityReplay.js'
import { mintRendezvousNamespace, readRendezvousNamespace, rotateRendezvousNamespace } from './rendezvousNamespace.js'
import { mintRendezvousAddressKey, readRendezvousAddressKey } from './rendezvousAddressKey.js'
import { checkRendezvousRotation, readRotatedFor, electedRotator, runRendezvousRotation } from './rendezvousRotation.js'
import { setCurrentDoc, getCurrentDoc, resetForTests } from './liveDoc.js'

const CAMP = 'camp-1'
let db, file, peerId

beforeEach(async () => {
  file = path.join(os.tmpdir(), `rzv-rotation-${Date.now()}-${Math.random()}.sqlite`)
  db = openLocalDb(file)
  db.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run(CAMP, 'Camp')
  ;({ peerId } = await ensureDeviceIdentity(db))
})
afterEach(() => {
  resetForTests()
  db.close()
  for (const s of ['', '-wal', '-shm']) if (fs.existsSync(file + s)) fs.unlinkSync(file + s)
})

function entry(doc, fields, signed = true) {
  const id = `entry-${Math.random()}`
  let d = doc
  for (const [field, value] of Object.entries(fields)) d = applyWrite(d, { entity: 'camp_authority_log', entity_id: id, field, value })
  if (signed) {
    const signature = signAuthorityEntry(db, { id, kind: fields.kind, target_device_id: fields.target_device_id, signer_device_id: fields.signer_device_id })
    d = applyWrite(d, { entity: 'camp_authority_log', entity_id: id, field: 'signature', value: signature })
  }
  return d
}
const revoke = (doc, target, signer) => entry(doc, { kind: 'revoke', target_device_id: target, signer_device_id: signer })

// Admins dev-f (founder), dev-a, dev-b. Elected rotator = lowest id = dev-a.
function camp({ enabled = true } = {}) {
  let doc = createEmptyDoc()
  doc = entry(doc, { kind: 'genesis', target_device_id: 'dev-f', target_peer_id: peerId.toString() }, false)
  for (const id of ['dev-a', 'dev-b']) doc = entry(doc, { kind: 'grant', target_device_id: id, target_peer_id: peerId.toString(), signer_device_id: 'dev-f' })
  if (enabled) {
    doc = mintRendezvousNamespace(doc, CAMP).doc
    doc = mintRendezvousAddressKey(doc, CAMP).doc
  }
  return doc
}
const digestOf = (doc) => revocationDigest(A, doc, { isEntryTrusted: createVerifiedEntryTrust(A, doc) })

describe('digest-keyed, elected rendezvous rotation', () => {
  it('a camp that never enabled rendezvous is skipped, nothing minted', () => {
    const doc = revoke(camp({ enabled: false }), 'dev-x', 'dev-f')
    const r = checkRendezvousRotation(doc, { campId: CAMP, deviceId: 'dev-a' })
    expect(r).toMatchObject({ rotated: false, reason: 'never-enabled' })
    expect(readRendezvousNamespace(r.doc, CAMP)).toBeNull()
  })

  it('no revocation: no rotation (no needless churn on startup)', () => {
    expect(checkRendezvousRotation(camp(), { campId: CAMP, deviceId: 'dev-a' })).toMatchObject({ rotated: false, reason: 'current' })
  })

  it('the elected rotator is the lowest currently granted admin', () => {
    expect(electedRotator(camp())).toBe('dev-a')
  })

  it('a non-elected admin does not rotate; the elected one does, once', () => {
    const doc = revoke(camp(), 'dev-x', 'dev-f')
    expect(checkRendezvousRotation(doc, { campId: CAMP, deviceId: 'dev-f' })).toMatchObject({ rotated: false, reason: 'not-elected' })
    const r = checkRendezvousRotation(doc, { campId: CAMP, deviceId: 'dev-a' })
    expect(r.rotated).toBe(true)
    expect(readRendezvousNamespace(r.doc, CAMP).epoch).toBe(readRendezvousNamespace(doc, CAMP).epoch + 1)
    expect(readRendezvousAddressKey(r.doc, CAMP)).not.toBe(readRendezvousAddressKey(doc, CAMP))
    expect(readRotatedFor(r.doc, CAMP)).toBe(digestOf(doc))
    expect(checkRendezvousRotation(r.doc, { campId: CAMP, deviceId: 'dev-a' })).toMatchObject({ rotated: false, reason: 'current' })
  })

  it('a quorum completed only by a MERGE rotates on the elected device only', () => {
    const base = camp()
    // Removing admin dev-b needs 2 of the other 2 admins. Each vote lands on a different device.
    const voteF = revoke(A.clone(base), 'dev-b', 'dev-f')
    const voteA = revoke(A.clone(base), 'dev-b', 'dev-a')
    expect(checkRendezvousRotation(voteF, { campId: CAMP, deviceId: 'dev-a' }).rotated).toBe(false)
    expect(checkRendezvousRotation(voteA, { campId: CAMP, deviceId: 'dev-a' }).rotated).toBe(false)

    const merged = A.merge(voteF, voteA)
    expect(checkRendezvousRotation(merged, { campId: CAMP, deviceId: 'dev-f' }).rotated).toBe(false)
    const r = checkRendezvousRotation(merged, { campId: CAMP, deviceId: 'dev-a' })
    expect(r.rotated).toBe(true)
    expect(readRotatedFor(r.doc, CAMP)).toBe(digestOf(merged))
  })

  it('concurrent revokes of X and Y: after the merge the final secret is minted for a digest covering BOTH', () => {
    const base = camp()
    const sideX = checkRendezvousRotation(revoke(A.clone(base), 'dev-x', 'dev-f'), { campId: CAMP, deviceId: 'dev-a' })
    const sideY = checkRendezvousRotation(revoke(A.clone(base), 'dev-y', 'dev-f'), { campId: CAMP, deviceId: 'dev-a' })
    expect(sideX.rotated && sideY.rotated).toBe(true)

    const merged = A.merge(sideX.doc, sideY.doc)
    const both = digestOf(merged)
    expect(both).not.toBe(readRotatedFor(sideX.doc, CAMP))
    expect(both).not.toBe(readRotatedFor(sideY.doc, CAMP))
    const r = checkRendezvousRotation(merged, { campId: CAMP, deviceId: 'dev-a' })
    expect(r.rotated).toBe(true)
    expect(readRotatedFor(r.doc, CAMP)).toBe(both)
    const keyBefore = readRendezvousAddressKey(merged, CAMP)
    expect(readRendezvousAddressKey(r.doc, CAMP)).not.toBe(keyBefore)
  })

  it('runRendezvousRotation stores and broadcasts a rotation; a missing broadcast is a recorded failure, not silence', () => {
    setCurrentDoc(db, revoke(camp(), 'dev-x', 'dev-f'), { persist: false })
    const calls = []
    expect(runRendezvousRotation(db, { deviceId: 'dev-a', broadcast: () => calls.push('b') }).rotated).toBe(true)
    expect(calls).toEqual(['b'])
    expect(readRotatedFor(getCurrentDoc(db), CAMP)).toBe(digestOf(getCurrentDoc(db)))

    setCurrentDoc(db, revoke(getCurrentDoc(db), 'dev-z', 'dev-f'), { persist: false })
    const r = runRendezvousRotation(db, { deviceId: 'dev-a', broadcast: undefined })
    expect(r).toMatchObject({ rotated: false, reason: 'failed' })
    const row = db.prepare("SELECT kind FROM device_health_events WHERE kind = 'rendezvous_rotation_failed'").get()
    expect(row).toBeTruthy()
  })
})

// Red Hat round-2 reproduction: namespace and key must never come from different rotations.
describe('the rotation is one atomic tuple', () => {
  const pair = (doc) => `${readRendezvousNamespace(doc, CAMP).namespace}|${readRendezvousAddressKey(doc, CAMP)}`

  it('busy side (200 edits + 1 rotation) vs quiet side (2 rotations): the merged namespace and key come from the SAME rotation', () => {
    for (let round = 0; round < 6; round++) {
      const base = revoke(camp(), 'dev-x', 'dev-f')
      const produced = new Set()

      let busy = A.clone(base)
      for (let i = 0; i < 200; i++) busy = applyWrite(busy, { entity: 'activities', entity_id: `act-${i}`, field: 'name', value: `A${i}` })
      busy = checkRendezvousRotation(busy, { campId: CAMP, deviceId: 'dev-a' }).doc
      produced.add(pair(busy))

      let quiet = checkRendezvousRotation(A.clone(base), { campId: CAMP, deviceId: 'dev-a' }).doc
      produced.add(pair(quiet))
      quiet = rotateRendezvousNamespace(quiet, CAMP).doc
      produced.add(pair(quiet))

      for (const merged of [A.merge(A.clone(busy), A.clone(quiet)), A.merge(A.clone(quiet), A.clone(busy))]) {
        expect(produced.has(pair(merged))).toBe(true)
      }
    }
  })
})
