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
import { getCurrentDoc, setCurrentDoc } from './liveDoc.js'
import { mintRendezvousSecrets, rotateRendezvousSecrets, readRendezvousSecrets } from './rendezvousNamespace.js'
import { mintJoinSecret } from '../joinCode.js'

const CAMP_ID = 'camp-pair-again'
const CODE = mintJoinSecret()
// A's clock. Pair again comes long after the first pairing, outside the pairing rate window.
let clock = Date.now()
const later = () => { clock += 60 * 60 * 1000 }

let files = []
let nodes = []
let sessions = []
let aDb, bDb
function freshDb(tag) {
  const f = path.join(os.tmpdir(), `shoresh-pairagain-${tag}-${Date.now()}-${Math.random()}.sqlite`)
  files.push(f)
  return openLocalDb(f)
}

beforeEach(() => {
  aDb = freshDb('a')
  bDb = freshDb('b')
  aDb.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run(CAMP_ID, 'Camp Kinneret')
  ensureHostSigningKey(aDb)
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
  for (const db of [aDb, bDb]) { try { db.close() } catch { /* closed */ } }
  for (const f of files) if (fs.existsSync(f)) fs.unlinkSync(f)
  files = []
})

async function startA() {
  const seeded = seedAllFromSqlite(aDb, A.clone(createEmptyDoc()))
  const a = await startSyncNode({
    deviceId: 'device-a', db: aDb,
    doc: mintRendezvousSecrets(seeded, CAMP_ID).doc,
    onPairingRequest: () => {},
    getJoinSecret: () => CODE,
    now: () => clock,
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
    const oldSecret = await pairB(a)
    const bSecretsBefore = readRendezvousSecrets(getCurrentDoc(bDb), CAMP_ID)
    expect(bSecretsBefore.namespace).toBe(readRendezvousSecrets(a.getDoc(), CAMP_ID).namespace)

    // B is offline. It edits locally.
    setCurrentDoc(bDb, applyWrite(getCurrentDoc(bDb), { entity: 'activities', entity_id: 'act-offline', field: 'name', value: 'Pottery' }), { persist: false })

    // Meanwhile on A: device C is revoked, and the camp's rendezvous secrets rotate (the elected
    // rotator's write; its trigger is pinned by rendezvousRotation.test.js).
    aDb.prepare("INSERT INTO devices (id, name, authorized_at, revoked_at, pairing_status) VALUES ('device-c', 'C', ?, ?, 'revoked')")
      .run(new Date().toISOString(), new Date().toISOString())
    await a.applyLocal(rotateRendezvousSecrets(a.getDoc(), CAMP_ID).doc)
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

  it('pair again needs a device that already has a camp', async () => {
    await expect(startJoinSession({ db: bDb, deviceId: 'device-b', code: CODE, rejoin: true, doc: A.clone(createEmptyDoc()) }))
      .rejects.toThrow(/already belongs to a camp/)
  })
})
