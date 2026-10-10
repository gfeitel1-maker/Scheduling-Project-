// @vitest-environment node
//
// Pair again, end to end on two REAL nodes and two REAL SQLite databases. Device B joined camp A,
// went offline, and while it was away a third device C was revoked, so the camp's rendezvous
// secrets rotated. B re-pairs with A's code: a director approves, B signs in, and the two documents
// merge both ways. B's offline edit reaches A; A's current secrets reach B.
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomBytes, randomUUID, scryptSync } from 'node:crypto'
import * as A from '@automerge/automerge'
import { openLocalDb } from '../../db/localDb.js'
import { createEmptyDoc, applyWrite, readRecord } from '../../automerge/campDocument.js'
import { seedAllFromSqlite } from '../../automerge/seed.js'
import { ensureHostSigningKey } from '../../auth/localAuth.js'
import { signAuthFields } from '../../auth/authSignature.js'
import { startSyncNode } from './syncNode.js'
import { startJoinSession } from './joinSession.js'
import { getCurrentDoc, setCurrentDoc, setUserDataDirGetter } from './liveDoc.js'
import { mintRendezvousSecrets, readRendezvousSecrets } from './rendezvousNamespace.js'
import { mintJoinSecret } from '../joinCode.js'
import { mintGenesisEntry, mintRevokeEntry } from '../../automerge/authorityLog.js'
import { projectEntity } from '../../automerge/projector.js'
import { runRendezvousRotation } from './rendezvousRotation.js'
import { signTombstone } from '../../automerge/tombstoneSignature.js'
import { CURRENT_SCHEMA_VERSION } from '../../db/localDb.js'
import { DELETE_FIELD } from '../../ops/operations.js'
import { listDeleted } from '../../ops/trash.js'
import { ensureDeviceIdentity } from '../../auth/deviceIdentity.js'

const CAMP_ID = 'camp-pair-again'
const CODE = mintJoinSecret()
// A's clock. Pair again comes long after the first pairing, outside the pairing rate window.
let clock = Date.now()
const later = () => { clock += 60 * 60 * 1000 }

let files = []
let nodes = []
let sessions = []
let aDb, bDb, dDb
function freshDb(tag) {
  const f = path.join(os.tmpdir(), `shoresh-pairagain-${tag}-${Date.now()}-${Math.random()}.sqlite`)
  files.push(f)
  return openLocalDb(f)
}

beforeEach(() => {
  aDb = freshDb('a')
  bDb = freshDb('b')
  aDb.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run(CAMP_ID, 'Camp Kinneret')
  const hostKey = ensureHostSigningKey(aDb)
  aDb.prepare('UPDATE camps SET signing_public_key = ? WHERE id = ?').run(hostKey.public_key, CAMP_ID)
  const salt = randomBytes(16).toString('hex')
  const pin_hash = scryptSync('1234', salt, 64).toString('hex')
  const id = randomUUID()
  const auth_sig = signAuthFields(aDb, { id, role: 'admin', pin_hash, pin_salt: salt, cred_version: 1 })
  aDb.prepare('INSERT INTO users (id, camp_id, name, pin_hash, pin_salt, role, auth_sig, cred_version) VALUES (?, ?, ?, ?, ?, ?, ?, 1)')
    .run(id, CAMP_ID, 'Director', pin_hash, salt, 'admin', auth_sig)
})
afterEach(async () => {
  await Promise.all(sessions.map((s) => s.stop().catch(() => {})))
  await Promise.all(nodes.map((n) => n.stop().catch(() => {})))
  sessions = []
  nodes = []
  for (const db of [aDb, bDb, dDb]) { try { db?.close() } catch { /* closed */ } }
  dDb = null
  for (const f of files) if (fs.existsSync(f)) fs.unlinkSync(f)
  files = []
})

async function startA({ doc, localSchemaVersion } = {}) {
  const seeded = doc ?? mintRendezvousSecrets(seedAllFromSqlite(aDb, A.clone(createEmptyDoc())), CAMP_ID).doc
  const a = await startSyncNode({
    deviceId: 'device-a', db: aDb,
    doc: seeded,
    onPairingRequest: () => {},
    getJoinSecret: () => CODE,
    now: () => clock,
    ...(localSchemaVersion ? { localSchemaVersion } : {}),
  })
  nodes.push(a)
  return a
}

// What approveDevice does: stamp the row with a NEW secret, then deliver the decision.
async function approve(a, deviceId) {
  const secret = randomBytes(32).toString('hex')
  aDb.prepare("UPDATE devices SET authorized_at = ?, pairing_status = 'authorized', device_secret_identifier = ? WHERE id = ?")
    .run(new Date().toISOString(), secret, deviceId)
  expect(await a.sendPairingApproved(deviceId, secret)).toBe(true)
  return secret
}

async function join(a, { rejoin = false } = {}) {
  const started = await startJoinSession({
    db: bDb, deviceId: 'device-b', deviceName: 'Laptop B', code: CODE, knownHost: a.getMultiaddrs()[0],
    ...(rejoin ? { rejoin: true, doc: getCurrentDoc(bDb) } : {}),
  })
  sessions.push(started.session)
  return started.session
}

async function pairB(a) {
  const s = await join(a)
  await s.findHost()
  expect((await s.requestPairing()).status).toBe('pending')
  const decision = s.waitForPairingDecision()
  const secret = await approve(a, 'device-b')
  expect((await decision).status).toBe('approved')
  expect((await s.login({ name: 'Director', pin: '1234', deviceSecretIdentifier: secret })).status).toBe('ok')
  expect(await s.waitForCamp()).not.toBeNull()
  await s.stop()
  later()
  return secret
}

async function eventually(fn, ms = 10_000) {
  const until = Date.now() + ms
  for (;;) {
    if (fn()) return true
    if (Date.now() > until) return false
    await new Promise((r) => setTimeout(r, 50))
  }
}

describe('Pair again: two devices', () => {
  it('a stale device re-pairs with a director\'s approval, its offline edit merges in, and it ends with the current secrets', async () => {
    const a = await startA()
    // The authority log is written through appendOp, which mirrors into the live document only
    // once a userData directory is configured (as main.js does at startup).
    const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'shoresh-pairagain-ud-'))
    setUserDataDirGetter(() => userData)
    aDb.prepare("INSERT OR IGNORE INTO devices (id, name, authorized_at, pairing_status) VALUES ('device-a', 'A', ?, 'authorized')").run(new Date().toISOString())
    mintGenesisEntry(aDb, { founderDeviceId: 'device-a', founderPeerId: (await ensureDeviceIdentity(aDb)).peerId })
    const oldSecret = await pairB(a)
    const bSecretsBefore = readRendezvousSecrets(getCurrentDoc(bDb), CAMP_ID)
    expect(bSecretsBefore.namespace).toBe(readRendezvousSecrets(a.getDoc(), CAMP_ID).namespace)

    // B is offline. It edits locally.
    setCurrentDoc(bDb, applyWrite(getCurrentDoc(bDb), { entity: 'activities', entity_id: 'act-offline', field: 'name', value: 'Pottery' }), { persist: false })

    // Meanwhile on A: device C is revoked through the real path (what revokeDevice does: a signed
    // revoke entry, projected, then the elected rotator rotates the rendezvous secrets).
    aDb.prepare("INSERT INTO devices (id, name, authorized_at, revoked_at, pairing_status) VALUES ('device-c', 'C', ?, ?, 'revoked')")
      .run(new Date().toISOString(), new Date().toISOString())
    mintRevokeEntry(aDb, { targetDeviceId: 'device-c', signerDeviceId: 'device-a' })
    projectEntity(aDb, getCurrentDoc(aDb), 'camp_authority_log')
    expect(runRendezvousRotation(aDb, { deviceId: 'device-a', broadcast: null }).reason).toBe('rotated')
    setUserDataDirGetter(null)
    fs.rmSync(userData, { recursive: true, force: true })
    const current = readRendezvousSecrets(a.getDoc(), CAMP_ID)
    expect(current.namespace).not.toBe(bSecretsBefore.namespace)

    // B pairs again with A's code. A director must approve: no silent re-delivery of the old secret.
    const s = await join(a, { rejoin: true })
    await s.findHost()
    expect((await s.requestPairing()).status).toBe('pending')
    expect(aDb.prepare('SELECT pairing_status FROM devices WHERE id = ?').get('device-b').pairing_status).toBe('rejoin_pending')
    const decision = s.waitForPairingDecision()
    const newSecret = await approve(a, 'device-b')
    expect(newSecret).not.toBe(oldSecret)
    expect((await decision).status).toBe('approved')
    expect((await s.login({ name: 'Director', pin: '1234', deviceSecretIdentifier: newSecret })).status).toBe('ok')
    expect(await s.waitForCamp()).toMatchObject({ id: CAMP_ID })

    // B now holds the camp's current secrets...
    expect(await eventually(() => readRendezvousSecrets(getCurrentDoc(bDb), CAMP_ID)?.namespace === current.namespace)).toBe(true)
    expect(readRendezvousSecrets(getCurrentDoc(bDb), CAMP_ID)).toEqual(current)
    // ...and its offline edit reached A, in the document and in A's SQLite.
    expect(await eventually(() => readRecord(a.getDoc(), 'activities', 'act-offline')?.name === 'Pottery')).toBe(true)
    expect(await eventually(() => aDb.prepare('SELECT name FROM activities WHERE id = ?').get('act-offline')?.name === 'Pottery')).toBe(true)
    // B kept its own camp row (same camp), nothing replaced.
    expect(bDb.prepare('SELECT id FROM camps').all()).toEqual([{ id: CAMP_ID }])
  })

  it('a revoked device cannot pair again: refused before any director sees it, and stays revoked', async () => {
    const a = await startA()
    await pairB(a)
    aDb.prepare('UPDATE devices SET revoked_at = ? WHERE id = ?').run(new Date().toISOString(), 'device-b')
    const s = await join(a, { rejoin: true })
    await s.findHost()
    expect(await s.requestPairing()).toEqual({ status: 'denied', reason: 'device_revoked' })
    expect(aDb.prepare('SELECT revoked_at FROM devices WHERE id = ?').get('device-b').revoked_at).not.toBeNull()
  })

  it('a different camp\'s code is refused with a plain answer before any PIN is sent, and the device is unchanged', async () => {
    const a = await startA()
    // B belongs to some other camp; A has never seen it.
    bDb.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run('camp-elsewhere', 'Elsewhere')
    setCurrentDoc(bDb, A.clone(createEmptyDoc()), { persist: false })
    const s = await join(a, { rejoin: true })
    await s.findHost()
    expect(await s.requestPairing()).toEqual({ status: 'not_this_camp' })
    expect(aDb.prepare('SELECT id FROM devices WHERE id = ?').get('device-b')).toBeUndefined()
    expect(bDb.prepare('SELECT id FROM camps').all()).toEqual([{ id: 'camp-elsewhere' }])
  })

  // Red Hat #844 R3: the code was read off a camp device that never approved B. Same camp, so
  // the answer is not "different camp".
  it('a camp device that never approved this one answers "not known here", not "different camp"', async () => {
    const a = await startA()
    await pairB(a)
    dDb = freshDb('d')
    dDb.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run(CAMP_ID, 'Camp Kinneret')
    const d = await startSyncNode({ deviceId: 'device-d', db: dDb, doc: A.clone(createEmptyDoc()), onPairingRequest: () => {}, getJoinSecret: () => CODE })
    nodes.push(d)
    const started = await startJoinSession({ db: bDb, deviceId: 'device-b', deviceName: 'Laptop B', code: CODE, knownHost: d.getMultiaddrs()[0], rejoin: true, doc: getCurrentDoc(bDb) })
    sessions.push(started.session)
    await started.session.findHost()
    expect(await started.session.requestPairing()).toEqual({ status: 'not_known_here' })
  })

  // Red Hat #844 R4c: a schema gap is caught before any director is asked.
  it('a schema gap is refused before approval, with both versions, and nothing is pending', async () => {
    let a = await startA()
    await pairB(a)
    await a.stop()
    a = await startA({ doc: getCurrentDoc(aDb), localSchemaVersion: CURRENT_SCHEMA_VERSION + 1 })
    const s = await join(a, { rejoin: true })
    await s.findHost()
    expect(await s.requestPairing()).toEqual({ status: 'update_needed', hostSchemaVersion: CURRENT_SCHEMA_VERSION + 1, localSchemaVersion: CURRENT_SCHEMA_VERSION })
    expect(aDb.prepare('SELECT pairing_status FROM devices WHERE id = ?').get('device-b').pairing_status).toBe('authorized')
  })

  // Keeper ruling on #844 R4a: the camp's signed tombstones are applied to the stranded device's
  // own document FIRST, then it merges. A camper purged while B was away stays purged everywhere.
  it('a camper purged while the device was away is not resurrected; its other offline edits still merge', async () => {
    aDb.prepare("INSERT INTO campers (id, camp_id, display_name, is_active) VALUES ('camper-x', ?, 'Purged Child', 1)").run(CAMP_ID)
    let a = await startA()
    await pairB(a)
    expect(readRecord(getCurrentDoc(bDb), 'campers', 'camper-x')?.display_name).toBe('Purged Child')

    // B goes offline and edits something unrelated.
    setCurrentDoc(bDb, applyWrite(getCurrentDoc(bDb), { entity: 'activities', entity_id: 'act-offline', field: 'name', value: 'Pottery' }), { persist: false })

    // On A, the purge (what purgeCamperRecord does): delete the rows, mint the signed tombstone,
    // regenerate the document from SQLite, and come back up on it.
    await a.stop()
    aDb.prepare("DELETE FROM campers WHERE id = 'camper-x'").run()
    const sig = signTombstone(aDb, { id: 'camper-x', entity: 'campers', version: 1 })
    aDb.prepare("INSERT INTO tombstones (id, entity, version, sig, created_at) VALUES ('camper-x', 'campers', 1, ?, ?)").run(sig, new Date().toISOString())
    a = await startA({ doc: mintRendezvousSecrets(seedAllFromSqlite(aDb, A.clone(createEmptyDoc())), CAMP_ID).doc })
    expect(readRecord(a.getDoc(), 'campers', 'camper-x')).toBeNull()

    const s = await join(a, { rejoin: true })
    await s.findHost()
    expect((await s.requestPairing()).status).toBe('pending')
    const decision = s.waitForPairingDecision()
    const secret = await approve(a, 'device-b')
    await decision
    expect((await s.login({ name: 'Director', pin: '1234', deviceSecretIdentifier: secret })).status).toBe('ok')
    expect(await s.waitForCamp()).not.toBeNull()

    expect(await eventually(() => aDb.prepare('SELECT name FROM activities WHERE id = ?').get('act-offline')?.name === 'Pottery')).toBe(true)
    expect(readRecord(a.getDoc(), 'campers', 'camper-x')).toBeNull()
    expect(readRecord(getCurrentDoc(bDb), 'campers', 'camper-x')).toBeNull()
    expect(aDb.prepare("SELECT id FROM campers WHERE id = 'camper-x'").get()).toBeUndefined()
    expect(await eventually(() => !bDb.prepare("SELECT id FROM campers WHERE id = 'camper-x'").get())).toBe(true)
  })

  // Keeper ruling: on Pair again a camp-side DELETE wins over the stranded device's offline field
  // edit to the same record — no half-record on either side, and no conflict for a director.
  it('a record deleted on the camp while the device was away stays deleted despite an offline edit; other offline edits merge', async () => {
    aDb.prepare("INSERT INTO activities (id, camp_id, name, notes) VALUES ('act-r', ?, 'Swim', 'Lake')").run(CAMP_ID)
    const a = await startA()
    await pairB(a)
    expect(readRecord(getCurrentDoc(bDb), 'activities', 'act-r')?.name).toBe('Swim')

    // B is offline: it edits a field of R, and a different record.
    setCurrentDoc(bDb, applyWrite(getCurrentDoc(bDb), { entity: 'activities', entity_id: 'act-r', field: 'notes', value: 'Bring towels' }), { persist: false })
    setCurrentDoc(bDb, applyWrite(getCurrentDoc(bDb), { entity: 'activities', entity_id: 'act-offline', field: 'name', value: 'Pottery' }), { persist: false })

    // Meanwhile A deletes R.
    const directorId = aDb.prepare("SELECT id FROM users WHERE name = 'Director'").get().id
    await a.applyLocal(applyWrite(a.getDoc(), { entity: 'activities', entity_id: 'act-r', field: DELETE_FIELD, value: null, author_user_id: directorId }))
    expect(aDb.prepare("SELECT id FROM activities WHERE id = 'act-r'").get()).toBeUndefined()

    const s = await join(a, { rejoin: true })
    await s.findHost()
    expect((await s.requestPairing()).status).toBe('pending')
    const decision = s.waitForPairingDecision()
    const secret = await approve(a, 'device-b')
    await decision
    expect((await s.login({ name: 'Director', pin: '1234', deviceSecretIdentifier: secret })).status).toBe('ok')
    expect(await s.waitForCamp()).not.toBeNull()

    expect(await eventually(() => aDb.prepare('SELECT name FROM activities WHERE id = ?').get('act-offline')?.name === 'Pottery')).toBe(true)
    expect(readRecord(getCurrentDoc(bDb), 'activities', 'act-r')).toBeNull()
    expect(await eventually(() => readRecord(a.getDoc(), 'activities', 'act-r') === null)).toBe(true)
    expect(aDb.prepare("SELECT id FROM activities WHERE id = 'act-r'").get()).toBeUndefined()
    expect(bDb.prepare("SELECT id FROM activities WHERE id = 'act-r'").get()).toBeUndefined()
    expect(readRecord(getCurrentDoc(bDb), 'activities', 'act-offline')).toEqual({ name: 'Pottery' })
    for (const db of [aDb, bDb]) expect(db.prepare("SELECT id FROM conflicts WHERE entity_id = 'act-r'").all()).toEqual([])
    // B's Trash lists R as deleted by the camp's director, on the camp's device.
    expect(listDeleted(bDb).find((r) => r.entity_id === 'act-r')).toMatchObject({ deleted_by_user_id: directorId, deleted_on_device_id: 'device-a' })
  })

  it('a settle that throws still reports the camp, so Pair again never hangs', async () => {
    const a = await startA()
    await pairB(a)
    await a.applyLocal(applyWrite(a.getDoc(), { entity: 'activities', entity_id: 'act-new', field: 'name', value: 'Archery' }))
    const started = await startJoinSession({
      db: bDb, deviceId: 'device-b', deviceName: 'Laptop B', code: CODE, knownHost: a.getMultiaddrs()[0],
      rejoin: true, doc: getCurrentDoc(bDb), settleDeletes: () => { throw new Error('planted') },
    })
    const s = started.session
    sessions.push(s)
    await s.findHost()
    expect((await s.requestPairing()).status).toBe('pending')
    const decision = s.waitForPairingDecision()
    const secret = await approve(a, 'device-b')
    await decision
    expect((await s.login({ name: 'Director', pin: '1234', deviceSecretIdentifier: secret })).status).toBe('ok')
    expect(await s.waitForCamp()).toMatchObject({ id: CAMP_ID })
  })

  it('pair again needs a device that already has a camp', async () => {
    await expect(startJoinSession({ db: bDb, deviceId: 'device-b', code: CODE, rejoin: true, doc: A.clone(createEmptyDoc()) }))
      .rejects.toThrow(/already belongs to a camp/)
  })
})
