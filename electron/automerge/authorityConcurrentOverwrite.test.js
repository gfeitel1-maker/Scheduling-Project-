// Round 3 of the genesis-camp-key review: authority is a function of the SET of changes. An entry is the one change that
// wrote every one of its fields; a concurrent write to the same record by another change (a partial overwrite of a
// signed field, or a full forgery under the same id) can neither change an entry nor erase it, whichever order the two
// histories are merged in.
import Database from 'better-sqlite3'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import * as Automerge from '@automerge/automerge'
import { initSchema } from '../db/localDb.js'
import { ensureDeviceIdentity } from '../auth/deviceIdentity.js'
import { createEmptyDoc, applyWrite } from './campDocument.js'
import { makeTestCamp, writeAuthorityEntry } from './genesisTestKit.js'
import { signAuthorityEntry } from './authorityLogSignature.js'
import { createVerifiedEntryTrust, currentAuthorityState, currentRevokedDeviceIds, campGenesis, resolveAuthorityPeerIds, AUTHORITY_LOG_ENTITY } from './authorityReplay.js'

const files = []
afterEach(() => {
  for (const f of files.splice(0)) for (const suffix of ['', '-wal', '-shm']) if (fs.existsSync(f + suffix)) fs.unlinkSync(f + suffix)
})

async function makeDevice() {
  const file = path.join(os.tmpdir(), `shoresh-authconc-${Date.now()}-${Math.random()}.sqlite`)
  files.push(file)
  const db = new Database(file)
  initSchema(db)
  const { peerId } = await ensureDeviceIdentity(db)
  return { db, peerId }
}

const camp = makeTestCamp('camp-1')
const root = camp.root

function genesis(doc, id, { deviceId, peerId }) {
  return writeAuthorityEntry(doc, id, camp.genesisFields({ id, deviceId, peerId }))
}
function grant(doc, id, { target, targetPeerId, signer, signerDb }) {
  const signature = signAuthorityEntry(signerDb, { id, kind: 'grant', target_device_id: target, target_peer_id: targetPeerId, signer_device_id: signer })
  return writeAuthorityEntry(doc, id, { kind: 'grant', target_device_id: target, target_peer_id: targetPeerId, signer_device_id: signer, signature })
}
function revoke(doc, id, { target, signer, signerDb }) {
  const signature = signAuthorityEntry(signerDb, { id, kind: 'revoke', target_device_id: target, signer_device_id: signer })
  return writeAuthorityEntry(doc, id, { kind: 'revoke', target_device_id: target, signer_device_id: signer, signature })
}
const overwrite = (doc, id, field, value) => applyWrite(doc, { entity: AUTHORITY_LOG_ENTITY, entity_id: id, field, value })

function stateOf(doc) {
  const isEntryTrusted = createVerifiedEntryTrust(Automerge, doc, root)
  return {
    founder: campGenesis(Automerge, doc, root)?.deviceId ?? null,
    admins: [...currentAuthorityState(Automerge, doc, { root, isEntryTrusted }).admins].sort(),
    revoked: currentRevokedDeviceIds(Automerge, doc, { root, isEntryTrusted }),
    peers: [...resolveAuthorityPeerIds(Automerge, doc, root)].sort(),
  }
}

function bothOrders(left, right) {
  const a = stateOf(Automerge.merge(Automerge.clone(left), Automerge.clone(right)))
  const b = stateOf(Automerge.merge(Automerge.clone(right), Automerge.clone(left)))
  return [a, b]
}

const fork = (doc, actor) => Automerge.clone(doc, { actor: actor.repeat(16) })

describe('a concurrent write to an authority record cannot change or erase the entry', () => {
  it('genesis: a concurrent overwrite of target_peer_id (partial, or a whole forged record) leaves the founder in both merge orders', async () => {
    const founder = await makeDevice()
    const base = createEmptyDoc()
    for (const attack of [
      (d) => overwrite(d, 'g1', 'target_peer_id', 'evil-peer'),
      (d) => writeAuthorityEntry(d, 'g1', { kind: 'genesis', target_device_id: 'founder', target_peer_id: 'evil-peer', signature: 'forged' }),
    ]) {
      const minted = genesis(fork(base, 'aa'), 'g1', { deviceId: 'founder', peerId: founder.peerId })
      const attacked = attack(fork(base, 'bb'))
      const [a, b] = bothOrders(minted, attacked)
      expect(a).toEqual(b)
      expect(a.founder).toBe('founder')
      expect(a.peers).toEqual([['founder', founder.peerId]])
    }
  })

  it('grant: a concurrent overwrite of target_peer_id cannot rebind the device to the attacker\'s peer id', async () => {
    const founder = await makeDevice()
    const other = await makeDevice()
    let base = genesis(createEmptyDoc(), 'g1', { deviceId: 'founder', peerId: founder.peerId })
    const minted = grant(fork(base, 'aa'), 'gr1', { target: 'other', targetPeerId: other.peerId, signer: 'founder', signerDb: founder.db })
    const attacked = overwrite(fork(base, 'bb'), 'gr1', 'target_peer_id', 'evil-peer')
    const [a, b] = bothOrders(minted, attacked)
    expect(a).toEqual(b)
    expect(a.admins).toEqual(['founder', 'other'])
    expect(a.peers).toContainEqual(['other', other.peerId])
    expect(a.peers.flat()).not.toContain('evil-peer')
  })

  it('revoke: a concurrent overwrite of the target cannot drop the revocation, in either merge order', async () => {
    const founder = await makeDevice()
    const other = await makeDevice()
    let base = genesis(createEmptyDoc(), 'g1', { deviceId: 'founder', peerId: founder.peerId })
    base = grant(base, 'gr1', { target: 'other', targetPeerId: other.peerId, signer: 'founder', signerDb: founder.db })
    const minted = revoke(fork(base, 'aa'), 'rv1', { target: 'other', signer: 'founder', signerDb: founder.db })
    for (const [field, value] of [['target_device_id', 'someone-else'], ['signer_device_id', 'other'], ['kind', 'grant']]) {
      const attacked = overwrite(fork(base, 'bb'), 'rv1', field, value)
      const [a, b] = bothOrders(minted, attacked)
      expect(a).toEqual(b)
      expect(a.revoked).toEqual(['other'])
      expect(a.admins).toEqual(['founder'])
    }
  })

  it('an overwrite made AFTER the entry (a descendant) does not change it either', async () => {
    const founder = await makeDevice()
    const other = await makeDevice()
    let doc = genesis(createEmptyDoc(), 'g1', { deviceId: 'founder', peerId: founder.peerId })
    doc = grant(doc, 'gr1', { target: 'other', targetPeerId: other.peerId, signer: 'founder', signerDb: founder.db })
    doc = revoke(doc, 'rv1', { target: 'other', signer: 'founder', signerDb: founder.db })
    doc = overwrite(doc, 'rv1', 'target_device_id', 'someone-else')
    doc = overwrite(doc, 'g1', 'target_peer_id', 'evil-peer')
    expect(stateOf(doc)).toMatchObject({ founder: 'founder', admins: ['founder'], revoked: ['other'] })
  })
})

describe('a record whose kind names an Object.prototype member is ignored, never thrown on', () => {
  for (const kind of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
    it(`kind ${kind}`, async () => {
      const founder = await makeDevice()
      let doc = genesis(createEmptyDoc(), 'g1', { deviceId: 'founder', peerId: founder.peerId })
      const before = stateOf(doc)
      doc = writeAuthorityEntry(doc, 'junk', { kind, target_device_id: 'x', target_peer_id: 'p', signer_device_id: 'founder', signature: 's' })
      expect(() => stateOf(doc)).not.toThrow()
      expect(stateOf(doc)).toEqual(before)
    })
  }
})
