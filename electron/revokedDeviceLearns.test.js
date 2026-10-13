// @vitest-environment node
//
// A device the camp removed must LEARN it was removed.
//
// Packaged E2E on 42275c9f: after A removed B, B's edits stopped reaching A (the cut-off works), but
// B kept working as if nothing had happened — no removed state, no Pair again, its own Devices row
// still "Allowed in" — and its log held one AUTH_ERROR (stream EOF) and "stream is closed" noise.
//
// Same harness as joinThenSync.test.js: the joined device runs the real main-process handlers and
// the real persistent-node starter; the Host is a real sync node. Real libp2p, real SQLite;
// discovery is an in-process tag bus re-announcing every 100ms (so a hot retry loop would show).
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
import { isRemovedFromCamp } from './sync/automerge/selfRemoval.js'
import { signAuthorityEntry } from './automerge/authorityLogSignature.js'

const CAMP_ID = 'camp-revoked-learns'
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
  hostFile = path.join(os.tmpdir(), `shoresh-rdl-host-${Date.now()}-${Math.random()}.sqlite`)
  hostDb = openLocalDb(hostFile)
  hostDb.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run(CAMP_ID, 'Test Camp')
  const hostKey = ensureHostSigningKey(hostDb)
  hostDb.prepare('UPDATE camps SET signing_public_key = ?').run(hostKey.public_key)
  insertUser(hostDb, { name: 'Director', pin: '1234', role: 'admin' })

  joiner = openTemplatedDb()
  joinerId = getOrCreateDeviceId(joiner.db)
  userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'shoresh-rdl-'))
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
  // The camp's authority genesis (main.js bootstrapCamp mints it): the joined device needs it to check a removal for itself.
  const genesisId = randomUUID()
  for (const [field, value] of [['kind', 'genesis'], ['target_device_id', 'host-device'], ['target_peer_id', host.peerId]]) {
    hostDoc = applyWrite(hostDoc, { entity: 'camp_authority_log', entity_id: genesisId, field, value })
  }
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
    userDataPath,
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


const hostAuthAttemptsFrom = (id) =>
  hostDb.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action = 'auth.authenticate' AND device_id = ?").get(id).n

// revokeDevice: stamp the row, sign a T331 revoke entry into the Host's document, evict. The removed device gets the
// signed entry in the refusal (removalEvidence.js) because it can no longer sync it.
async function removeOnHost(node) {
  hostDb.prepare("UPDATE devices SET revoked_at = ?, pairing_status = 'revoked' WHERE id = ?").run(new Date().toISOString(), joinerId)
  host.revokePeer(node.peerId)
  const id = randomUUID()
  const fields = { kind: 'revoke', target_device_id: joinerId, signer_device_id: 'host-device' }
  let doc = host.getDoc()
  for (const [field, value] of Object.entries({ ...fields, signature: signAuthorityEntry(hostDb, { id, ...fields }) })) {
    doc = applyWrite(doc, { entity: 'camp_authority_log', entity_id: id, field, value })
  }
  await host.applyLocal(doc)
}

describe('a removed device learns it was removed', () => {
  it('records the removal durably, surfaces it with Pair again, stops retrying, and keeps its data', async () => {
    const login = await joinAsTheAppDoes()
    const node = await waitFor(() => starter.getNode(), 10_000)
    await editOn(node, 'act-before', 'Hiking')
    expect(await waitFor(() => nameIn(hostDb, 'act-before'), 10_000)).toBe('Hiking')
    expect(isRemovedFromCamp(joiner.db)).toBe(false)

    await removeOnHost(node)

    // B learns it on its next contact attempt.
    expect(await waitFor(() => isRemovedFromCamp(joiner.db), 15_000)).toBe(true)
    expect(handlers.getSyncStatus().removedFromCamp).toBe(true)

    // Durable: a fresh connection to the same file still says so.
    const reopened = openLocalDb(joiner.file)
    try { expect(isRemovedFromCamp(reopened)).toBe(true) } finally { reopened.close() }

    // No hot retry loop: the bus re-announces every 100ms; the Host sees no further attempts.
    const before = hostAuthAttemptsFrom(joinerId)
    await new Promise((r) => setTimeout(r, 2500))
    expect(hostAuthAttemptsFrom(joinerId) - before).toBe(0)

    // Its own Devices row no longer says it is allowed in.
    const self = (await handlers.listDevices({ token: login.token })).find((d) => d.isSelf)
    expect(self.pairing_status).toBe('revoked')

    // Local data kept.
    expect(nameIn(joiner.db, 'act-before')).toBe('Hiking')
  }, 60_000)

  it('a transient failure (the Host going offline) does NOT mark the device removed', async () => {
    await joinAsTheAppDoes()
    const node = await waitFor(() => starter.getNode(), 10_000)
    await editOn(node, 'act-before', 'Hiking')
    expect(await waitFor(() => nameIn(hostDb, 'act-before'), 10_000)).toBe('Hiking')

    await host.stop()
    await editOn(node, 'act-offline', 'Fencing')
    await new Promise((r) => setTimeout(r, 3000))
    expect(isRemovedFromCamp(joiner.db)).toBe(false)
    expect(handlers.getSyncStatus().removedFromCamp).toBeFalsy()
  }, 60_000)
})
