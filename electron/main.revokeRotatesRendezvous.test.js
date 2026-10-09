// @vitest-environment node
//
// F1 of docs/work/security/2026-10-09-wan-ladder-assessment.md: a revoked device keeps its copy of
// the camp document, which holds the rendezvous namespace and address key. Revocation must rotate
// both so the departed device can neither find the Worker namespace nor decrypt new records.
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => os.tmpdir()), whenReady: vi.fn(() => Promise.resolve()), on: vi.fn() },
  BrowserWindow: vi.fn(),
  ipcMain: { handle: vi.fn() },
  contextBridge: { exposeInMainWorld: vi.fn() },
  ipcRenderer: { invoke: vi.fn(), on: vi.fn() },
}))

import { openTemplatedDb, cleanupTemplatedDbs } from './db/testDbTemplate.js'
import { getOrCreateDeviceId } from './db/localDb.js'
import { createUser, ensureHostSigningKey } from './auth/localAuth.js'
import { makeHandlers } from './main.js'
import { mintGenesisEntry, mintGrantEntry } from './automerge/authorityLog.js'
import { projectEntity } from './automerge/projector.js'
import * as A from '@automerge/automerge'
import { getCurrentDoc, setUserDataDirGetter, resetForTests as resetLiveDocForTests } from './sync/automerge/liveDoc.js'
import { ensureDeviceIdentity } from './auth/deviceIdentity.js'

let db, founderDeviceId, userDataDir

function localTestWrite(byDeviceId) {
  return async (args) => {
    const { appendOp } = await import('./ops/operations.js')
    return { status: 'applied', op: appendOp(db, { ...args, author_user_id: null, device_id: byDeviceId, parent_op_id: null }) }
  }
}

function insertDevice(id, { authorized = true } = {}) {
  db.prepare(
    "INSERT OR IGNORE INTO devices (id, name, pairing_status, authorized_at) VALUES (?, ?, ?, ?)"
  ).run(id, id, authorized ? 'authorized' : 'pending', authorized ? new Date().toISOString() : null)
}

function projectAuthority() {
  projectEntity(db, getCurrentDoc(db), 'camp_authority_log')
}

async function seedFounderCamp() {
  const campId = randomUUID()
  db.prepare('INSERT INTO camps (id, name, signing_secret) VALUES (?, ?, ?)').run(campId, 'T332 Fix Camp', 'a'.repeat(64))
  const hostKey = ensureHostSigningKey(db)
  db.prepare('UPDATE camps SET signing_public_key = ? WHERE id = ?').run(hostKey.public_key, campId)
  insertDevice(founderDeviceId)
  const founder = await createUser(db, { camp_id: campId, name: 'Founder', pin: '135790', role: 'admin' }, localTestWrite(founderDeviceId))
  db.prepare('UPDATE devices SET authorized_by_user_id = ? WHERE id = ?').run(founder.id, founderDeviceId)
  const { peerId: founderPeerId } = await ensureDeviceIdentity(db)

  mintGenesisEntry(db, { founderDeviceId, founderPeerId })
  projectAuthority()
  return { campId, founder }
}

beforeEach(() => {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shoresh-revrot-'))
  setUserDataDirGetter(() => userDataDir)
  const templated = openTemplatedDb()
  db = templated.db
  founderDeviceId = getOrCreateDeviceId(db)
})

afterEach(() => {
  resetLiveDocForTests()
  try { db.close() } catch { /* already closed */ }
  fs.rmSync(userDataDir, { recursive: true, force: true })
})

afterAll(() => {
  cleanupTemplatedDbs()
})

import { mintRendezvousNamespace, readRendezvousNamespace } from './sync/automerge/rendezvousNamespace.js'
import { mintRendezvousAddressKey, readRendezvousAddressKey } from './sync/automerge/rendezvousAddressKey.js'
import { startRendezvousClient } from './sync/automerge/rendezvousClient.js'
import { verify } from './sync/automerge/rendezvousRecord.js'
import { setCurrentDoc } from './sync/automerge/liveDoc.js'

async function seedWithRendezvous() {
  const { campId } = await seedFounderCamp()
  let doc = getCurrentDoc(db)
  doc = mintRendezvousNamespace(doc, campId).doc
  doc = mintRendezvousAddressKey(doc, campId).doc
  setCurrentDoc(db, doc)
  return campId
}

function fakeNode(calls) {
  return { revokePeer: (p) => calls.push(['revokePeer', p]), broadcastLocalDoc: async () => { calls.push(['broadcastLocalDoc']) } }
}

async function revokeOrdinary(calls) {
  const target = 'device-departed'
  insertDevice(target)
  db.prepare('UPDATE devices SET libp2p_peer_id = ? WHERE id = ?').run('peer-departed', target)
  const handlers = makeHandlers(db, founderDeviceId, { getAutomergeSyncNode: () => fakeNode(calls) })
  await handlers.chooseMode({ mode: 'host' })
  const { token } = await handlers.login({ name: 'Founder', pin: '135790' })
  expect(handlers.revokeDevice({ token, deviceId: target })).toEqual({ deviceId: target, revoked: true })
}

describe('F1 (2026-10-09 WAN-ladder assessment) — revoking a device rotates the rendezvous namespace AND address key', () => {
  it('after a revoke, the namespace, epoch and address key all differ', async () => {
    const campId = await seedWithRendezvous()
    const before = { ns: readRendezvousNamespace(getCurrentDoc(db), campId), key: readRendezvousAddressKey(getCurrentDoc(db), campId) }

    await revokeOrdinary([])

    const after = { ns: readRendezvousNamespace(getCurrentDoc(db), campId), key: readRendezvousAddressKey(getCurrentDoc(db), campId) }
    expect(after.ns.namespace).not.toBe(before.ns.namespace)
    expect(after.ns.epoch).toBe(before.ns.epoch + 1)
    expect(after.key).toMatch(/^[0-9a-f]{64}$/)
    expect(after.key).not.toBe(before.key)
  })

  it('remaining peers converge on the new values; the revoked device, evicted BEFORE the broadcast, keeps only the old ones', async () => {
    const campId = await seedWithRendezvous()
    const remainingPeer = A.clone(getCurrentDoc(db))
    const revokedView = A.clone(getCurrentDoc(db))
    const oldKey = readRendezvousAddressKey(revokedView, campId)
    const calls = []

    await revokeOrdinary(calls)

    const names = calls.map((c) => c[0])
    expect(names).toContain('broadcastLocalDoc')
    expect(names.indexOf('revokePeer')).toBeLessThan(names.indexOf('broadcastLocalDoc'))

    const merged = A.merge(remainingPeer, A.clone(getCurrentDoc(db)))
    expect(readRendezvousNamespace(merged, campId)).toEqual(readRendezvousNamespace(getCurrentDoc(db), campId))
    expect(readRendezvousAddressKey(merged, campId)).toBe(readRendezvousAddressKey(getCurrentDoc(db), campId))
    expect(readRendezvousAddressKey(revokedView, campId)).toBe(oldKey)
    expect(readRendezvousAddressKey(merged, campId)).not.toBe(oldKey)
  })

  it('after the revoke, the rendezvous client publishes and polls only the NEW namespace, and the old key cannot decrypt what it publishes', async () => {
    const campId = await seedWithRendezvous()
    const oldNs = readRendezvousNamespace(getCurrentDoc(db), campId).namespace
    const oldKey = readRendezvousAddressKey(getCurrentDoc(db), campId)
    await revokeOrdinary([])
    const newNs = readRendezvousNamespace(getCurrentDoc(db), campId).namespace

    const { generateKeyPair } = await import('@libp2p/crypto/keys')
    const { peerIdFromPrivateKey } = await import('@libp2p/peer-id')
    const privateKey = await generateKeyPair('Ed25519')
    const urls = []
    let published = null
    const fetchImpl = async (url, init) => {
      urls.push(url)
      if (url.includes('/v1/register')) {
        published = JSON.parse(init.body)
        return { ok: true, status: 200, json: async () => ({}) }
      }
      return { ok: true, status: 200, json: async () => ({ peers: [] }) }
    }
    const client = startRendezvousClient({
      baseUrl: 'https://rendezvous.example', campId, doc: () => getCurrentDoc(db),
      getPrivateKey: async () => privateKey, peerId: peerIdFromPrivateKey(privateKey).toString(),
      fetchImpl, intervalMs: 0, getAddresses: () => ['/ip4/8.8.8.8/udp/4000'],
    })
    await client.tick()
    client.stop()

    expect(urls.length).toBeGreaterThan(0)
    for (const url of urls) {
      expect(url).not.toContain(oldNs)
    }
    expect(urls.some((u) => u.includes(newNs))).toBe(true)
    expect(published.namespace).toBe(newNs)
    const bytes = Buffer.from(published.record, 'base64')
    expect(verify(bytes, { addressKey: oldKey }).addressBodyDecrypted).toBe(false)
    expect(verify(bytes, { addressKey: readRendezvousAddressKey(getCurrentDoc(db), campId) }).addressBodyDecrypted).toBe(true)
  })

  it('round 2: a revoke on an admin device that is NOT the elected rotator does not rotate locally', async () => {
    const campId = await seedWithRendezvous()
    const { peerId } = await ensureDeviceIdentity(db)
    insertDevice('0-elected-admin')
    mintGrantEntry(db, { targetDeviceId: '0-elected-admin', targetPeerId: peerId, signerDeviceId: founderDeviceId })
    projectAuthority()
    const before = readRendezvousNamespace(getCurrentDoc(db), campId)

    const calls = []
    await revokeOrdinary(calls)

    expect(readRendezvousNamespace(getCurrentDoc(db), campId)).toEqual(before)
    expect(calls.map((c) => c[0])).not.toContain('broadcastLocalDoc')
  })
})
