// @vitest-environment node
//
// T359 slice 2 wiring: this device publishes its mapped TCP address FIRST in its signed gossip entry, and
// remembers a CONNECTED peer's verified mapped address. Fake node, real gossip signing and verification.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as A from '@automerge/automerge'
import { openTemplatedDb, cleanupTemplatedDbs } from '../../db/testDbTemplate.js'
import { getOrCreateDeviceId } from '../../db/localDb.js'
import { ensureDeviceIdentity } from '../../auth/deviceIdentity.js'
import { wirePunchReconnect, createRoutedSignalChannel } from './punchReconnectWiring.js'
import { ensurePunchIdentity, rememberOwnReflexive } from './punchIdentity.js'
import { createHighWaterStore, readReflexive, publishReflexive } from './punchGossip.js'
import { makeDevice, cleanupDevices } from '../../../test/punchRung2Support.js'

let db, dbFile, userDataPath, deviceId, peerDev
beforeEach(async () => {
  const templated = openTemplatedDb()
  db = templated.db
  dbFile = templated.file
  deviceId = getOrCreateDeviceId(db)
  userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'mapped-wiring-'))
  peerDev = await makeDevice('device-p')
  db.prepare("INSERT INTO devices (id, name, authorized_at, pairing_status, libp2p_peer_id) VALUES ('device-p', 'p', ?, 'authorized', ?)").run(new Date().toISOString(), peerDev.peerId)
})
afterEach(() => {
  db.close()
  if (fs.existsSync(dbFile)) fs.unlinkSync(dbFile)
  fs.rmSync(userDataPath, { recursive: true, force: true })
  cleanupTemplatedDbs()
  cleanupDevices([peerDev])
})

const readyDoc = () => A.change(A.from({ camps: {} }), (d) => { d.camps.id = 'camp-1' })
function fakeNode({ peers = [] } = {}) {
  const listeners = []
  return {
    peerId: '12D3KooWFake',
    getPeers: () => peers,
    dial: vi.fn(async () => {}),
    isPeerAuthenticated: () => true,
    broadcastLocalDoc: vi.fn(),
    onPeersChanged: (cb) => listeners.push(cb),
    fire: () => listeners.forEach((cb) => cb()),
  }
}
const base = (extra = {}) => ({
  db, deviceId, campId: 'camp-1', userDataPath, channel: createRoutedSignalChannel(),
  getTransport: () => ({}), getUpgrader: () => ({}), rendezvous: null, emit: vi.fn(),
  getDoc: () => readyDoc(), setDoc: vi.fn(),
  coordinatorOptions: { setTimer: () => ({ unref() {} }), clearTimer: () => {} },
  ...extra,
})
const peerRows = () => db.prepare('SELECT multiaddr FROM peer_last_addresses WHERE peer_id = ?').all(peerDev.peerId).map((r) => r.multiaddr)
const MAPPED = '/ip4/34.120.1.7/tcp/50000'

describe('publishing this device\'s mapped address', () => {
  async function publishWith(getMappedAddress, udp = ['candidate:1 1 UDP 1686052607 9.9.9.9 50001 typ srflx']) {
    ensurePunchIdentity(db)
    const { peerId } = await ensureDeviceIdentity(db)
    if (udp) rememberOwnReflexive(db, udp)
    let current = readyDoc()
    const wiring = await wirePunchReconnect({ ...base({ getDoc: () => current, setDoc: (d) => { current = d }, getMappedAddress }), node: { ...fakeNode({ peers: ['peer-b'] }), peerId } })
    wiring.publishOwnReflexive()
    const highWater = createHighWaterStore({ filePath: path.join(userDataPath, 'check-hw.json') })
    const entry = readReflexive(current, { campId: 'camp-1', registry: { peerIdForDevice: (id) => (id === deviceId ? peerId : null) }, highWater, now: () => Date.now() }).get(deviceId)
    await wiring.stop()
    return entry
  }

  it('the mapped TCP address comes FIRST, ahead of the UDP candidates', async () => {
    expect((await publishWith(() => MAPPED)).candidates).toEqual([MAPPED, '/ip4/9.9.9.9/udp/50001'])
  })

  it('a mapped address alone is enough to publish', async () => {
    expect((await publishWith(() => MAPPED, null)).candidates).toEqual([MAPPED])
  })

  it('production default (no mapper source): no TCP candidate is ever published', async () => {
    const entry = await publishWith(undefined)
    expect(entry.candidates.some((c) => c.includes('/tcp/'))).toBe(false)
  })

  it('a non-public mapped address is not published (the filter is the same as for UDP)', async () => {
    ensurePunchIdentity(db)
    const setDoc = vi.fn()
    const wiring = await wirePunchReconnect({ ...base({ setDoc, getMappedAddress: () => '/ip4/192.168.1.5/tcp/50000' }), node: fakeNode({ peers: ['peer-b'] }) })
    wiring.publishOwnReflexive()
    expect(setDoc).not.toHaveBeenCalled()
    await wiring.stop()
  })
})

describe('remembering a connected peer\'s verified mapped address', () => {
  const peerDoc = (candidates) => publishReflexive(readyDoc(), peerDev.db, { campId: 'camp-1', deviceId: 'device-p', peerId: peerDev.peerId, candidates })

  it('writes it as .../tcp/<port>/p2p/<peerId> while the peer is connected', async () => {
    const doc = peerDoc([MAPPED, '/ip4/9.9.9.9/udp/50001'])
    const node = fakeNode({ peers: [peerDev.peerId] })
    const wiring = await wirePunchReconnect({ ...base({ getDoc: () => doc }), node })
    node.fire()
    expect(peerRows()).toEqual([`${MAPPED}/p2p/${peerDev.peerId}`])
    await wiring.stop()
  })

  it('does not write it for a peer that is not connected', async () => {
    const doc = peerDoc([MAPPED])
    const node = fakeNode({ peers: [] })
    const wiring = await wirePunchReconnect({ ...base({ getDoc: () => doc }), node })
    node.fire()
    expect(peerRows()).toEqual([])
    await wiring.stop()
  })

  it('an entry that fails verification (forged by another device) writes nothing', async () => {
    const mallory = await makeDevice('device-p')
    const doc = publishReflexive(readyDoc(), mallory.db, { campId: 'camp-1', deviceId: 'device-p', peerId: peerDev.peerId, candidates: [MAPPED] })
    const node = fakeNode({ peers: [peerDev.peerId] })
    const wiring = await wirePunchReconnect({ ...base({ getDoc: () => doc }), node })
    node.fire()
    expect(peerRows()).toEqual([])
    await wiring.stop()
    cleanupDevices([mallory])
  })
})
