// @vitest-environment node
//
// After join by code, the two devices must keep syncing — both ways, with no restart.
//
// Found by the packaged two-instance run on 2dd5fb7a: the join itself worked (approved, signed in
// once, camp + fixed events arrived), but afterwards nothing moved in either direction. The joined
// device's persistent sync node logged NO_TOKEN against the Host and never tried again; the Host
// only ever re-dialed the joiner's dead join-time address.
//
// This drives the JOINING device through the real main-process handlers the IPC layer calls
// (makeHandlers: joinStart -> joinFindHost -> joinRequestPairing -> joinAwaitPairingDecision ->
// joinLogin -> joinAwaitData), the real persistent-node starter (createAutomergeSyncStarter, as
// main.js's onCampJoined fires it), and then the renderer's completeJoin -> init sequence
// (verifySession, chooseMode({ mode: 'client', token })) exactly as useDeviceMode runs it — right
// after joinAwaitData returns, without waiting for the node. Real libp2p, real SQLite. The only
// stand-in is discovery: an in-process tag bus instead of mDNS (CI has no multicast).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomBytes, randomUUID, scryptSync } from 'node:crypto'

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => os.tmpdir()), whenReady: vi.fn(() => Promise.resolve()), on: vi.fn() },
  BrowserWindow: vi.fn(),
  ipcMain: { handle: vi.fn() },
  contextBridge: { exposeInMainWorld: vi.fn() },
  ipcRenderer: { invoke: vi.fn(), on: vi.fn() },
}))

import * as A from '@automerge/automerge'
import { openLocalDb, getOrCreateDeviceId } from './db/localDb.js'
import { openTemplatedDb, cleanupTemplatedDbs } from './db/testDbTemplate.js'
import { createEmptyDoc, applyWrite } from './automerge/campDocument.js'
import { seedAllFromSqlite } from './automerge/seed.js'
import { ensureHostSigningKey } from './auth/localAuth.js'
import { buildRosterWrites } from './automerge/deviceRoster.js'
import { signAuthFields } from './auth/authSignature.js'
import { makeHandlers } from './main.js'
import { createAutomergeSyncStarter } from './sync/automerge/syncStarter.js'
import { startSyncNode } from './sync/automerge/syncNode.js'
import { setUserDataDirGetter, setDocCipher, resetForTests } from './sync/automerge/liveDoc.js'
import { mintJoinSecret, joinDiscoveryTag } from './sync/joinCode.js'

const CAMP_ID = 'camp-join-then-sync'
const CAMP_TAG = 'camp-discovery-stand-in'

function createTagBus() {
  const live = new Map()
  const info = (c) => ({ id: c.peerId, multiaddrs: c.addressManager.getAddresses() })
  return (tag) => (components) => {
    const service = new EventTarget()
    const me = { service, components }
    let timer = null
    service.start = () => {
      const peers = live.get(tag) ?? new Set()
      live.set(tag, peers)
      peers.add(me)
      timer = setInterval(() => {
        for (const other of live.get(tag) ?? []) {
          if (other !== me) me.service.dispatchEvent(new CustomEvent('peer', { detail: info(other.components) }))
        }
      }, 100)
    }
    service.stop = () => { clearInterval(timer); live.get(tag)?.delete(me) }
    return service
  }
}

function insertUser(db, { name, pin, role }) {
  const id = randomUUID()
  const salt = randomBytes(16).toString('hex')
  const pin_hash = scryptSync(pin, salt, 64).toString('hex')
  const auth_sig = signAuthFields(db, { id, role, pin_hash, pin_salt: salt, cred_version: 1 })
  db.prepare(
    'INSERT INTO users (id, camp_id, name, pin_hash, pin_salt, role, auth_sig, cred_version) VALUES (?, ?, ?, ?, ?, ?, ?, 1)'
  ).run(id, CAMP_ID, name, pin_hash, salt, role, auth_sig)
}

async function waitFor(fn, ms) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    const v = fn()
    if (v) return v
    await new Promise((r) => setTimeout(r, 50))
  }
  return fn()
}

let hostDb, hostFile, joiner, joinerId, userDataPath, bus, host, starter, handlers, code
beforeEach(async () => {
  hostFile = path.join(os.tmpdir(), `shoresh-jts-host-${Date.now()}-${Math.random()}.sqlite`)
  hostDb = openLocalDb(hostFile)
  hostDb.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run(CAMP_ID, 'Test Camp')
  const hostKey = ensureHostSigningKey(hostDb)
  hostDb.prepare('UPDATE camps SET signing_public_key = ?').run(hostKey.public_key)
  insertUser(hostDb, { name: 'Director', pin: '1234', role: 'admin' })

  joiner = openTemplatedDb()
  joinerId = getOrCreateDeviceId(joiner.db)
  userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'shoresh-jts-'))
  resetForTests()
  setUserDataDirGetter(() => userDataPath)
  setDocCipher(null)

  bus = createTagBus()
  code = mintJoinSecret()
  host = await startSyncNode({
    deviceId: 'host-device',
    db: hostDb,
    doc: seedAllFromSqlite(hostDb, A.clone(createEmptyDoc())),
    onPairingRequest: () => {},
    isJoinWindowOpen: () => true,
    getJoinSecret: () => code,
    joinDiscoveryFor: bus,
    peerDiscovery: [bus(CAMP_TAG)],
  })
  await host.setJoinCode?.(code)
  // A real Host enrolls itself in the signed device roster at bootstrap (main.js bootstrapCamp), so every device it
  // pairs can admit it with no Host-issued token (docs/adr/2026-10-12-shared-signed-device-roster.md).
  let hostDoc = host.getDoc()
  for (const w of buildRosterWrites(hostDb, { deviceId: 'host-device', peerId: host.peerId })) hostDoc = applyWrite(hostDoc, w)
  await host.applyLocal(hostDoc)

  // The joined device's persistent node: the REAL starter, with only discovery swapped for the bus
  // and listening on loopback.
  starter = createAutomergeSyncStarter({
    deviceId: joinerId,
    db: joiner.db,
    userDataPath,
    docCipher: null,
    getMainWindow: () => null,
    getLiveHandlers: () => handlers,
    startSyncNodeImpl: async () => (opts) => startSyncNode({ ...opts, peerDiscovery: [bus(CAMP_TAG)], listen: ['/ip4/127.0.0.1/tcp/0'] }),
  })
  handlers = makeHandlers(joiner.db, joinerId, {
    getAutomergeSyncNode: () => starter.getNode(),
    getAutomergeStartupAttempted: () => starter.getStartupAttempted(),
    onCampJoined: () => starter.start(),
    retrySync: () => starter.start(),
    stopSync: async () => {},
  })
})

afterEach(async () => {
  await starter.getNode()?.stop?.().catch(() => {})
  await host.stop().catch(() => {})
  resetForTests()
  for (const db of [hostDb, joiner.db]) { try { db.close() } catch { /* closed */ } }
  for (const f of [hostFile, joiner.file]) if (fs.existsSync(f)) fs.unlinkSync(f)
  fs.rmSync(userDataPath, { recursive: true, force: true })
  cleanupTemplatedDbs()
})

// The whole join as JoinByCodeScreen + useDeviceMode drive it, through the main-process handlers.
async function joinAsTheAppDoes() {
  await handlers.chooseMode({ mode: 'client' })
  expect((await handlers.joinStart({ code, deviceName: 'New Laptop', peerDiscovery: [bus(joinDiscoveryTag(code))] })).status).toBe('started')
  expect((await handlers.joinFindHost()).status).toBe('found')
  await handlers.joinRequestPairing()
  // The director approves on the Host.
  const secret = randomBytes(32).toString('hex')
  await waitFor(() => hostDb.prepare('SELECT 1 FROM devices WHERE id = ?').get(joinerId), 5000)
  hostDb.prepare(
    "UPDATE devices SET authorized_at = ?, pairing_status = 'authorized', device_secret_identifier = ? WHERE id = ?"
  ).run(new Date().toISOString(), secret, joinerId)
  const decision = handlers.joinAwaitPairingDecision()
  await host.sendPairingApproved(joinerId, secret)
  const approved = await decision
  expect(approved.status).toBe('approved')
  const login = await handlers.joinLogin({ name: 'Director', pin: '1234', deviceSecretIdentifier: approved.deviceSecretIdentifier })
  expect(login.status).toBe('ok')
  expect((await handlers.joinAwaitData()).status).toBe('ok')
  // completeJoin -> retry -> init: verify the adopted token, then chooseMode with it. The renderer
  // does NOT wait for the persistent node to finish starting.
  const verified = await handlers.verifySession({ token: login.token })
  expect(verified?.valid).toBe(true)
  await handlers.chooseMode({ mode: 'client', token: login.token })
  return login
}

async function editOn(node, id, name) {
  await node.applyLocal(applyWrite(node.getDoc(), { entity: 'activities', entity_id: id, field: 'name', value: name }))
  await node.broadcastLocalDoc?.()
}
const nameIn = (db, id) => db.prepare('SELECT name FROM activities WHERE id = ?').get(id)?.name

describe('after join by code, sync keeps running both ways without a restart', () => {
  it('an edit on the Host reaches the joined device, and an edit on the joined device reaches the Host', async () => {
    await joinAsTheAppDoes()
    const node = await waitFor(() => starter.getNode(), 10_000)
    expect(node).toBeTruthy()

    await editOn(host, 'act-from-host', 'Archery')
    expect(await waitFor(() => nameIn(joiner.db, 'act-from-host'), 10_000)).toBe('Archery')

    await editOn(node, 'act-from-joiner', 'Canoeing')
    expect(await waitFor(() => nameIn(hostDb, 'act-from-joiner'), 10_000)).toBe('Canoeing')
  }, 60_000)

  it('non-vacuous: once the Host revokes the joined device, its edits no longer arrive', async () => {
    await joinAsTheAppDoes()
    const node = await waitFor(() => starter.getNode(), 10_000)
    await editOn(node, 'act-before', 'Hiking')
    expect(await waitFor(() => nameIn(hostDb, 'act-before'), 10_000)).toBe('Hiking')

    hostDb.prepare("UPDATE devices SET revoked_at = ?, pairing_status = 'revoked' WHERE id = ?").run(new Date().toISOString(), joinerId)
    host.revokePeer(node.peerId)
    await editOn(node, 'act-after', 'Fencing')
    await new Promise((r) => setTimeout(r, 3000))
    expect(nameIn(hostDb, 'act-after')).toBeUndefined()
  }, 60_000)
})
