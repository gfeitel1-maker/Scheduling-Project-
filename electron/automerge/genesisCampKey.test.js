// Amendment 2026-10-13 (docs/adr/2026-10-02-distributed-revocation-authority.md): the founder is the genesis entry
// signed by the camp signing key this device holds locally. Forged genesis entries do not count, and every entry
// point that reads genesis takes the camp root as a required parameter.
import Database from 'better-sqlite3'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as Automerge from '@automerge/automerge'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { initSchema, openLocalDb } from '../db/localDb.js'
import { ensureDeviceIdentity } from '../auth/deviceIdentity.js'
import { ensureHostSigningKey } from '../auth/localAuth.js'
import { setUserDataDirGetter, resetForTests, getCurrentDoc } from '../sync/automerge/liveDoc.js'
import { createEmptyDoc, applyWrite } from './campDocument.js'
import { signAuthorityEntry } from './authorityLogSignature.js'
import { mintGenesisEntry, mintGrantEntry, mintRevokeEntry } from './authorityLog.js'
import { projectAll } from './projector.js'
import { makeTestCamp } from './genesisTestKit.js'
import {
  createAuthorityReplayContext, createVerifiedEntryTrust, currentAuthorityState, currentRevokedDeviceIds,
  isValidAdminAt, resolveAuthorityPeerIds,
} from './authorityReplay.js'
import { revocationDigest } from './authorityRevocationDigest.js'
import { rotatingDiscoveryDigest } from '../sync/automerge/rotatingDiscoveryTag.js'
import { rotatingServiceTag } from '../sync/automerge/discovery.js'
import { electedRotator, checkRendezvousRotation } from '../sync/automerge/rendezvousRotation.js'
import { collectRevocationEvidence, validateRefusalEvidence } from '../sync/automerge/removalEvidence.js'

const files = []
const dirs = []
beforeEach(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shoresh-gencampkey-'))
  dirs.push(dir)
  setUserDataDirGetter(() => dir)
})
afterEach(() => {
  resetForTests()
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
  for (const f of files.splice(0)) for (const s of ['', '-wal', '-shm']) if (fs.existsSync(f + s)) fs.unlinkSync(f + s)
})

function tmpFile(tag) {
  const f = path.join(os.tmpdir(), `shoresh-gencampkey-${tag}-${Date.now()}-${Math.random()}.sqlite`)
  files.push(f)
  return f
}

async function makeDevice() {
  const db = new Database(tmpFile('key'))
  initSchema(db)
  const { peerId } = await ensureDeviceIdentity(db)
  return { db, peerId }
}

function projectionDb(publicKey) {
  const db = openLocalDb(tmpFile('proj'))
  db.prepare('INSERT INTO camps (id, name, signing_public_key) VALUES (?, ?, ?)').run('camp-1', 'Camp One', publicKey ?? null)
  return db
}

function hostDb() {
  const db = openLocalDb(tmpFile('host'))
  db.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run('camp-1', 'Camp One')
  const key = ensureHostSigningKey(db)
  db.prepare('UPDATE camps SET signing_public_key = ? WHERE id = ?').run(key.public_key, 'camp-1')
  for (const id of ['host-dev', 'admin-2', 'laptop']) db.prepare("INSERT INTO devices (id, name, pairing_status) VALUES (?, ?, 'authorized')").run(id, id)
  return { db, publicKey: key.public_key }
}

function put(doc, id, fields) {
  let d = doc
  for (const [field, value] of Object.entries(fields)) d = applyWrite(d, { entity: 'camp_authority_log', entity_id: id, field, value })
  return d
}

function signed(doc, id, kind, { target, signer, signerDb, peer }) {
  const signature = signAuthorityEntry(signerDb, { id, kind, target_device_id: target, signer_device_id: signer })
  return put(doc, id, { kind, target_device_id: target, signer_device_id: signer, ...(peer ? { target_peer_id: peer } : {}), signature })
}

const status = (db, id) => db.prepare('SELECT status FROM authority_cache WHERE device_id = ?').get(id)?.status ?? null
const appliedIds = (db) => db.prepare('SELECT entry_id FROM applied_authority_log').all().map((r) => r.entry_id)

describe('forged genesis', () => {
  it('a counselor genesis sorting first does not make the counselor founder; its revoke of the real founder has no effect', async () => {
    const camp = makeTestCamp('camp-1')
    const founder = await makeDevice()
    const counselor = await makeDevice()
    let doc = createEmptyDoc()
    doc = put(doc, 'f-real', camp.genesisFields({ id: 'f-real', deviceId: 'founder', peerId: founder.peerId }))
    doc = put(doc, '0000-forged', { kind: 'genesis', target_device_id: 'counselor', target_peer_id: counselor.peerId })
    doc = signed(doc, 'r1', 'revoke', { target: 'founder', signer: 'counselor', signerDb: counselor.db })
    const db = projectionDb(camp.publicKey)
    projectAll(db, doc)
    expect(status(db, 'counselor')).not.toBe('admin')
    expect(status(db, 'founder')).toBe('admin')
    expect(appliedIds(db)).toEqual(['f-real'])
  })

  it('a self-signed genesis (valid signature under a key that is not the camp key) does not count', async () => {
    const camp = makeTestCamp('camp-1')
    const attackerCamp = makeTestCamp('camp-1')
    const founder = await makeDevice()
    const counselor = await makeDevice()
    let doc = createEmptyDoc()
    doc = put(doc, 'f-real', camp.genesisFields({ id: 'f-real', deviceId: 'founder', peerId: founder.peerId }))
    doc = put(doc, '0000-forged', attackerCamp.genesisFields({ id: '0000-forged', deviceId: 'counselor', peerId: counselor.peerId }))
    const db = projectionDb(camp.publicKey)
    projectAll(db, doc)
    expect(status(db, 'counselor')).toBe(null)
    expect(status(db, 'founder')).toBe('admin')
  })

  it('a camp-signed genesis cannot be replayed under another id or with another target', async () => {
    const camp = makeTestCamp('camp-1')
    const founder = await makeDevice()
    const fields = camp.genesisFields({ id: 'g1', deviceId: 'founder', peerId: founder.peerId })
    let doc = put(createEmptyDoc(), 'g0', { ...fields, target_device_id: 'counselor' })
    doc = put(doc, 'g2', fields)
    const db = projectionDb(camp.publicKey)
    projectAll(db, doc)
    expect(status(db, 'counselor')).toBe(null)
    expect(status(db, 'founder')).toBe(null)
  })

  it('an unsigned genesis alone yields no founder and no admin, and projection does not throw', async () => {
    const camp = makeTestCamp('camp-1')
    const founder = await makeDevice()
    const doc = put(createEmptyDoc(), 'g', { kind: 'genesis', target_device_id: 'founder', target_peer_id: founder.peerId })
    const db = projectionDb(camp.publicKey)
    expect(() => projectAll(db, doc)).not.toThrow()
    expect(db.prepare('SELECT COUNT(*) AS n FROM authority_cache').get().n).toBe(0)
    expect(appliedIds(db)).toEqual([])
  })

  it('a device with no camp key yet resolves no founder and projects no authority rows', async () => {
    const camp = makeTestCamp('camp-1')
    const founder = await makeDevice()
    const doc = put(createEmptyDoc(), 'g', camp.genesisFields({ id: 'g', deviceId: 'founder', peerId: founder.peerId }))
    const db = projectionDb(null)
    expect(() => projectAll(db, doc)).not.toThrow()
    expect(db.prepare('SELECT COUNT(*) AS n FROM authority_cache').get().n).toBe(0)
  })

  it('when several genesis entries verify, the lowest id wins on every device', async () => {
    const camp = makeTestCamp('camp-1')
    let doc = put(createEmptyDoc(), 'b', camp.genesisFields({ id: 'b', deviceId: 'dev-b', peerId: 'pb' }))
    doc = put(doc, 'a', camp.genesisFields({ id: 'a', deviceId: 'dev-a', peerId: 'pa' }))
    expect(createAuthorityReplayContext(Automerge, doc, { root: camp.root }).founderDeviceId).toBe('dev-a')
  })
})

describe('applied_authority_log', () => {
  it('a revoke signed by an admin who was already removed gets no applied row', async () => {
    const camp = makeTestCamp('camp-1')
    const founder = await makeDevice()
    const exAdmin = await makeDevice()
    let doc = put(createEmptyDoc(), 'g', camp.genesisFields({ id: 'g', deviceId: 'founder', peerId: founder.peerId }))
    doc = signed(doc, 'grant-a', 'grant', { target: 'ex-admin', signer: 'founder', signerDb: founder.db, peer: exAdmin.peerId })
    doc = signed(doc, 'revoke-a', 'revoke', { target: 'ex-admin', signer: 'founder', signerDb: founder.db })
    doc = signed(doc, 'late-revoke', 'revoke', { target: 'bystander', signer: 'ex-admin', signerDb: exAdmin.db })
    const db = projectionDb(camp.publicKey)
    projectAll(db, doc)
    expect(appliedIds(db).sort()).toEqual(['g', 'grant-a', 'revoke-a'])
    expect(status(db, 'bystander')).toBe(null)
  })
})

describe('genuine flow', () => {
  it('bootstrap mints a camp-signed genesis; a joiner holding the same camp key resolves the same founder and applies founder grants and revokes', async () => {
    const host = hostDb()
    const { peerId } = await ensureDeviceIdentity(host.db)
    mintGenesisEntry(host.db, { founderDeviceId: 'host-dev', founderPeerId: peerId, campId: 'camp-1' })
    mintGrantEntry(host.db, { targetDeviceId: 'admin-2', targetPeerId: 'peer-2', signerDeviceId: 'host-dev' })
    mintRevokeEntry(host.db, { targetDeviceId: 'laptop', signerDeviceId: 'host-dev' })
    const doc = getCurrentDoc(host.db)
    const joiner = projectionDb(host.publicKey)
    projectAll(joiner, doc)
    expect(status(joiner, 'host-dev')).toBe('admin')
    expect(status(joiner, 'admin-2')).toBe('admin')
    expect(status(joiner, 'laptop')).toBe('revoked')
    expect(createAuthorityReplayContext(Automerge, doc, { root: { campId: 'camp-1', publicKey: host.publicKey } }).founderDeviceId).toBe('host-dev')
  })

  it('a device holding a different camp key does not accept the genesis', async () => {
    const host = hostDb()
    const { peerId } = await ensureDeviceIdentity(host.db)
    mintGenesisEntry(host.db, { founderDeviceId: 'host-dev', founderPeerId: peerId, campId: 'camp-1' })
    const other = projectionDb(makeTestCamp('camp-1').publicKey)
    projectAll(other, getCurrentDoc(host.db))
    expect(status(other, 'host-dev')).toBe(null)
  })
})

describe('the camp root is a required parameter', () => {
  const doc = createEmptyDoc()
  const noRoot = /camp root/
  it('every entry point that reads genesis throws without one', () => {
    const calls = [
      () => createVerifiedEntryTrust(Automerge, doc),
      () => createAuthorityReplayContext(Automerge, doc, {}),
      () => createAuthorityReplayContext(Automerge, doc),
      () => currentRevokedDeviceIds(Automerge, doc, {}),
      () => currentAuthorityState(Automerge, doc, {}),
      () => isValidAdminAt(Automerge, doc, 'd', 'h', {}),
      () => resolveAuthorityPeerIds(Automerge, doc),
      () => revocationDigest(Automerge, doc, {}),
      () => rotatingDiscoveryDigest(Automerge, doc, 'camp-1', {}),
      () => rotatingServiceTag(Automerge, doc, 'camp-1', {}),
      () => electedRotator(doc),
      () => checkRendezvousRotation(doc, { campId: 'camp-1', deviceId: 'd' }),
      () => collectRevocationEvidence(doc, 'd', []),
      () => validateRefusalEvidence(doc, 'd', { changes: [] }),
    ]
    for (const call of calls) expect(call).toThrow(noRoot)
  })
})

describe('a paired non-admin cannot rewrite who holds authority', () => {
  const trusted = (doc, root) => ({ root, isEntryTrusted: createVerifiedEntryTrust(Automerge, doc, root) })

  it('an unsigned grant rebinding the founder to the attacker key does not let the attacker revoke or promote anyone', async () => {
    const camp = makeTestCamp('camp-1')
    const founder = await makeDevice()
    const attacker = await makeDevice()
    let doc = put(createEmptyDoc(), 'g', camp.genesisFields({ id: 'g', deviceId: 'founder', peerId: founder.peerId }))
    doc = put(doc, 'rebind', { kind: 'grant', target_device_id: 'founder', target_peer_id: attacker.peerId, signer_device_id: 'counselor' })
    doc = signed(doc, 'evil-revoke', 'revoke', { target: 'victim', signer: 'founder', signerDb: attacker.db })
    doc = signed(doc, 'evil-grant', 'grant', { target: 'counselor', signer: 'founder', signerDb: attacker.db, peer: attacker.peerId })
    expect(currentRevokedDeviceIds(Automerge, doc, trusted(doc, camp.root))).toEqual([])
    expect([...currentAuthorityState(Automerge, doc, trusted(doc, camp.root)).admins]).toEqual(['founder'])
  })

  it('a grant by a non-admin cannot rebind an admin the founder genuinely granted', async () => {
    const camp = makeTestCamp('camp-1')
    const founder = await makeDevice()
    const admin2 = await makeDevice()
    const attacker = await makeDevice()
    let doc = put(createEmptyDoc(), 'g', camp.genesisFields({ id: 'g', deviceId: 'founder', peerId: founder.peerId }))
    doc = signed(doc, 'grant-a2', 'grant', { target: 'admin-2', signer: 'founder', signerDb: founder.db, peer: admin2.peerId })
    doc = signed(doc, 'rebind', 'grant', { target: 'admin-2', signer: 'attacker', signerDb: attacker.db, peer: attacker.peerId })
    expect(resolveAuthorityPeerIds(Automerge, doc, camp.root).get('admin-2')).toBe(admin2.peerId)
  })

  it('overwriting fields of the genuine genesis or of a genuine grant afterwards changes nothing', async () => {
    const camp = makeTestCamp('camp-1')
    const founder = await makeDevice()
    const admin2 = await makeDevice()
    const attacker = await makeDevice()
    let doc = put(createEmptyDoc(), 'g', camp.genesisFields({ id: 'g', deviceId: 'founder', peerId: founder.peerId }))
    doc = signed(doc, 'grant-a2', 'grant', { target: 'admin-2', signer: 'founder', signerDb: founder.db, peer: admin2.peerId })
    doc = signed(doc, 'r-c', 'revoke', { target: 'c', signer: 'founder', signerDb: founder.db })
    const before = currentRevokedDeviceIds(Automerge, doc, trusted(doc, camp.root))
    expect(before).toEqual(['c'])
    for (const [id, field, value] of [['g', 'kind', 'revoke'], ['g', 'target_peer_id', 'x'], ['g', 'signature', 'x'], ['grant-a2', 'target_peer_id', attacker.peerId]]) {
      doc = applyWrite(doc, { entity: 'camp_authority_log', entity_id: id, field, value })
    }
    expect(createAuthorityReplayContext(Automerge, doc, { root: camp.root }).founderDeviceId).toBe('founder')
    expect(currentRevokedDeviceIds(Automerge, doc, trusted(doc, camp.root))).toEqual(before)
    expect(resolveAuthorityPeerIds(Automerge, doc, camp.root).get('admin-2')).toBe(admin2.peerId)
  })
})
