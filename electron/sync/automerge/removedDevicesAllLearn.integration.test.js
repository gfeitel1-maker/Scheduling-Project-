// @vitest-environment node
//
// Every device the camp removes learns it was removed, whatever came before it (packaged final audit on 08267102, step 19b:
// the second removed device reportedly stayed signed in). Real handlers on both ends: the host's approveDevice and
// revokeDevice, each joiner's main-process handlers and persistent-node starter, discovery over an in-process tag bus.
// A removed device "relaunches" by starting a fresh starter over its same db and data directory.
import { describe, it, expect, afterEach, vi } from 'vitest'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import * as A from '@automerge/automerge'
import { randomUUID } from 'node:crypto'

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => os.tmpdir()), whenReady: vi.fn(() => Promise.resolve()), on: vi.fn() },
  BrowserWindow: vi.fn(),
  ipcMain: { handle: vi.fn() },
  contextBridge: { exposeInMainWorld: vi.fn() },
  ipcRenderer: { invoke: vi.fn(), on: vi.fn() },
}))

import { AmHost, makeTmpDir, cleanupDirs, waitFor } from '../../../test/integration/harnessAutomerge.js'
import { openTemplatedDb, cleanupTemplatedDbs } from '../../db/testDbTemplate.js'
import { getOrCreateDeviceId } from '../../db/localDb.js'
import { makeHandlers } from '../../main.js'
import { createAutomergeSyncStarter } from './syncStarter.js'
import { startSyncNode } from './syncNode.js'
import { setUserDataDirGetter, setDocCipher, resetForTests } from './liveDoc.js'
import { CURRENT_SCHEMA_VERSION } from '../../db/localDb.js'
import { joinDiscoveryTag } from '../joinCode.js'
import { isRemovedFromCamp } from './selfRemoval.js'
import { applyWrites } from '../../automerge/campDocument.js'
import { hostGenesisSignature } from '../../automerge/genesisTestKit.js'
import { mintRendezvousNamespace } from './rendezvousNamespace.js'
import { mintRendezvousAddressKey } from './rendezvousAddressKey.js'

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
let bus = null

let dirs = []
let nodes = []
let dbs = []
let errors = []
let spy
afterEach(async () => {
  spy?.mockRestore()
  for (const n of nodes) await n.stop?.().catch(() => {})
  nodes = []
  resetForTests()
  for (const d of dbs) { try { d.close() } catch { /* closed */ } }
  dbs = []
  cleanupDirs(dirs)
  dirs = []
  cleanupTemplatedDbs()
})

async function newCamp() {
  errors = []
  spy = vi.spyOn(console, 'error').mockImplementation((...a) => { errors.push(a.join(' ')) })
  const dir = makeTmpDir(); dirs.push(dir)
  resetForTests()
  setUserDataDirGetter(() => `${dir}/host-userdata`)
  setDocCipher(null)
  bus = createTagBus()
  const host = new AmHost(`${dir}/host.db`, { startSyncNode: (opts) => startSyncNode({ ...opts, joinDiscoveryFor: bus, peerDiscovery: [bus(CAMP_TAG)] }) })
  nodes.push(host.node ?? { stop: () => host.stop() })
  await host.start()
  nodes.push({ stop: () => host.stop() })
  await host.bootstrap({})
  await host.node.setJoinCode?.(host.joinSecret)
  const genesisId = randomUUID()
  const fields = (id, f) => Object.entries(f).map(([field, value]) => ({ entity: 'camp_authority_log', entity_id: id, field, value }))
  await host.node.applyLocal(applyWrites(host.node.getDoc(), fields(genesisId, { kind: 'genesis', target_device_id: host.deviceId, target_peer_id: host.node.peerId, signature: hostGenesisSignature(host.db, { id: genesisId, target_device_id: host.deviceId, target_peer_id: host.node.peerId }) })))
  await host.node.applyLocal(mintRendezvousAddressKey(mintRendezvousNamespace(host.node.getDoc(), host.campId).doc, host.campId).doc)
  host.handlers = makeHandlers(host.db, host.deviceId, { getAutomergeSyncNode: () => host.node })
  await host.handlers.chooseMode({ mode: 'host' })
  host.token = (await host.handlers.login({ name: 'admin', pin: '1234' })).token
  return { dir, host }
}

async function joinReal(dir, host, name) {
  const joiner = openTemplatedDb()
  const db = joiner.db
  dbs.push(db)
  const deviceId = getOrCreateDeviceId(db)
  const userDataPath = fs.mkdtempSync(path.join(dir, `${name}-`))
  const j = { name, db, deviceId, userDataPath, file: joiner.file }
  j.makeStarter = () => createAutomergeSyncStarter({
    deviceId, db, userDataPath, docCipher: null, getMainWindow: () => null, getLiveHandlers: () => j.handlers,
    startSyncNodeImpl: async () => (opts) => startSyncNode({ ...opts, inboundConnectionThreshold: 1000, peerDiscovery: [bus(CAMP_TAG)], listen: ['/ip4/127.0.0.1/tcp/0'] }),
  })
  j.starter = j.makeStarter()
  j.handlers = makeHandlers(db, deviceId, {
    userDataPath,
    getAutomergeSyncNode: () => j.starter.getNode(),
    getAutomergeStartupAttempted: () => j.starter.getStartupAttempted(),
    onCampJoined: () => j.starter.start(),
    retrySync: () => j.starter.start(),
    stopSync: async () => {},
  })
  nodes.push({ stop: () => j.starter.getNode()?.stop?.() })
  await j.handlers.chooseMode({ mode: 'client' })
  expect((await j.handlers.joinStart({ code: host.joinSecret, deviceName: name, peerDiscovery: [bus(joinDiscoveryTag(host.joinSecret))] })).status).toBe('started')
  expect((await j.handlers.joinFindHost()).status).toBe('found')
  await j.handlers.joinRequestPairing()
  await waitFor(() => host.db.prepare('SELECT 1 FROM devices WHERE id = ?').get(deviceId), 8000)
  const decision = j.handlers.joinAwaitPairingDecision()
  const out = await host.handlers.approveDevice({ token: host.token, deviceId })
  expect(out.authorized).toBe(true)
  const approved = await decision
  expect(approved.status).toBe('approved')
  const login = await j.handlers.joinLogin({ name: 'admin', pin: '1234', deviceSecretIdentifier: approved.deviceSecretIdentifier })
  expect(login.status).toBe('ok')
  expect((await j.handlers.joinAwaitData()).status).toBe('ok')
  expect((await j.handlers.verifySession({ token: login.token }))?.valid).toBe(true)
  await j.handlers.chooseMode({ mode: 'client', token: login.token })
  await waitFor(() => j.starter.getNode(), 10000)
  return j
}

async function removeAndExpectLearn(host, j) {
  errors.length = 0
  const out = host.handlers.revokeDevice({ token: host.token, deviceId: j.deviceId })
  expect(out.revoked).toBe(true)
  try { await j.starter.getNode()?.stop?.() } catch { /* stopped */ }
  j.starter = j.makeStarter()
  await j.starter.start()
  const learned = await waitFor(() => isRemovedFromCamp(j.db), 20000).then(() => true, () => false)
  if (!learned) throw new Error(`${j.name} did not learn. cache=${JSON.stringify(j.db.prepare('SELECT * FROM authority_cache').all())} self=${j.deviceId} hostCache=${JSON.stringify(host.db.prepare('SELECT device_id,status FROM authority_cache').all())} hostDev=${JSON.stringify(host.db.prepare('SELECT id,pairing_status,revoked_at FROM devices WHERE id=?').get(j.deviceId))} log: ${errors.map((e) => e.replace(/"evidence":.*/, '').slice(0, 200)).join('\n')}`)
}

describe('every removed device learns it was removed (real handlers on both ends)', () => {
  it('S paired AFTER R was removed', async () => {
    const { dir, host } = await newCamp()
    const r = await joinReal(dir, host, 'R')
    await removeAndExpectLearn(host, r)
    const s = await joinReal(dir, host, 'S')
    await removeAndExpectLearn(host, s)
  }, 180000)

  it('both paired first', async () => {
    const { dir, host } = await newCamp()
    const r = await joinReal(dir, host, 'R')
    const s = await joinReal(dir, host, 'S')
    await removeAndExpectLearn(host, r)
    await removeAndExpectLearn(host, s)
  }, 180000)
})

describe('three devices removed in turn', () => {
  it('each relaunches into its refusal and learns', async () => {
    const { dir, host } = await newCamp()
    const a = await joinReal(dir, host, 'A')
    await removeAndExpectLearn(host, a)
    const b = await joinReal(dir, host, 'B')
    const c = await joinReal(dir, host, 'C')
    await removeAndExpectLearn(host, b)
    await removeAndExpectLearn(host, c)
  }, 180000)
})
