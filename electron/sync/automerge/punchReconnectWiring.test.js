// @vitest-environment node
//
// S4c: the production callers for the ladder, driven with a fake node (no libp2p, no native module).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as A from '@automerge/automerge'
import { openTemplatedDb, cleanupTemplatedDbs } from '../../db/testDbTemplate.js'
import { getOrCreateDeviceId } from '../../db/localDb.js'
import { ensureDeviceIdentity } from '../../auth/deviceIdentity.js'
import { wirePunchReconnect, createRoutedSignalChannel } from './punchReconnectWiring.js'
import { EVENTS } from './connectivityEvents.js'
import { ensurePunchIdentity, rememberOwnReflexive } from './punchIdentity.js'
import { createHighWaterStore, readReflexive } from './punchGossip.js'

let db, dbFile, userDataPath, deviceId
beforeEach(() => {
  const templated = openTemplatedDb()
  db = templated.db
  dbFile = templated.file
  deviceId = getOrCreateDeviceId(db)
  userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'punchrw-'))
})
afterEach(() => {
  db.close()
  if (fs.existsSync(dbFile)) fs.unlinkSync(dbFile)
  fs.rmSync(userDataPath, { recursive: true, force: true })
  cleanupTemplatedDbs()
})

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
  getDoc: () => A.from({ camps: { id: 'camp-1' } }), setDoc: vi.fn(),
  coordinatorOptions: { setTimer: () => ({ unref() {} }), clearTimer: () => {} },
  ...extra,
})

describe('store failures are surfaced, never silent', () => {
  it('a corrupt high-water file emits PUNCH_STORE_FAILED {store:"high-water"} and no path', async () => {
    fs.writeFileSync(path.join(userDataPath, 'punch-gossip-highwater.json'), '{not json')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const args = base()
    const wiring = await wirePunchReconnect({ ...args, node: fakeNode() })
    warn.mockRestore()
    expect(args.emit).toHaveBeenCalledWith(EVENTS.PUNCH_STORE_FAILED, { store: 'high-water' })
    expect(JSON.stringify(args.emit.mock.calls)).not.toContain(userDataPath)
    await wiring.stop()
  })

  it('a corrupt replay file emits PUNCH_STORE_FAILED {store:"replay"}', async () => {
    fs.writeFileSync(path.join(userDataPath, 'punch-signal-replay.json'), '{not json')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const args = base()
    const wiring = await wirePunchReconnect({ ...args, node: fakeNode() })
    warn.mockRestore()
    expect(args.emit).toHaveBeenCalledWith(EVENTS.PUNCH_STORE_FAILED, { store: 'replay' })
    await wiring.stop()
  })

  it('healthy stores emit nothing', async () => {
    const args = base()
    const wiring = await wirePunchReconnect({ ...args, node: fakeNode() })
    expect(args.emit).not.toHaveBeenCalled()
    await wiring.stop()
  })
})

describe('a dependency that is not ready is a rung error, not "unreachable"', () => {
  it('no transport/upgrader and no signaling: PUNCH_RUNG_ERROR for rungs 1 and 2, no SAME_NETWORK_REQUIRED, no rung 3', async () => {
    const rendezvous = { request: vi.fn(), release: vi.fn() }
    const args = base({ getTransport: () => null, getUpgrader: () => null, rendezvous, coordinatorOptions: { lanGraceMs: 0, setTimer: () => ({ unref() {} }), clearTimer: () => {} } })
    const wiring = await wirePunchReconnect({ ...args, node: fakeNode() })
    const result = await wiring.coordinator.reconnect({ peerId: '12D3KooWOther', deviceId: 'dev-x' })
    expect(result).toEqual({ ok: false, reason: 'rung-error' })
    expect(args.emit.mock.calls.filter((c) => c[0] === EVENTS.PUNCH_RUNG_ERROR).map((c) => c[1].rung)).toEqual([1, 2])
    expect(args.emit).not.toHaveBeenCalledWith(EVENTS.SAME_NETWORK_REQUIRED, expect.anything())
    expect(rendezvous.request).not.toHaveBeenCalled()
    await wiring.stop()
  })
})

describe('gossip publishing of this device\'s own reflexive candidates', () => {
  function readyDoc() {
    return A.change(A.from({ camps: {} }), (d) => { d.camps.id = 'camp-1' })
  }

  it('publishes a public candidate to the camp document and broadcasts it', async () => {
    ensurePunchIdentity(db)
    const { peerId } = await ensureDeviceIdentity(db)
    rememberOwnReflexive(db, ['candidate:1 1 UDP 1686052607 9.9.9.9 50001 typ srflx'])
    let current = readyDoc()
    const node = { ...fakeNode({ peers: ['peer-b'] }), peerId }
    const args = base({ getDoc: () => current, setDoc: (d) => { current = d } })
    const wiring = await wirePunchReconnect({ ...args, node })
    wiring.publishOwnReflexive()
    expect(node.broadcastLocalDoc).toHaveBeenCalledTimes(1)
    const highWater = createHighWaterStore({ filePath: path.join(userDataPath, 'check-hw.json') })
    const registry = { peerIdForDevice: (id) => (id === deviceId ? peerId : null) }
    const entries = readReflexive(current, { campId: 'camp-1', registry, highWater, now: () => Date.now() })
    expect(entries.get(deviceId)?.candidates).toEqual(['/ip4/9.9.9.9/udp/50001'])
    await wiring.stop()
  })

  it('never publishes a private or LAN candidate, and does nothing with no connected peer', async () => {
    ensurePunchIdentity(db)
    rememberOwnReflexive(db, ['candidate:1 1 UDP 1686052607 192.168.1.5 50001 typ srflx'])
    const setDoc = vi.fn()
    const node = fakeNode({ peers: ['peer-b'] })
    const wiring = await wirePunchReconnect({ ...base({ setDoc }), node })
    wiring.publishOwnReflexive()
    expect(setDoc).not.toHaveBeenCalled()

    rememberOwnReflexive(db, ['candidate:1 1 UDP 1686052607 9.9.9.9 50001 typ srflx'])
    const lonely = await wirePunchReconnect({ ...base({ setDoc }), node: fakeNode({ peers: [] }) })
    lonely.publishOwnReflexive()
    expect(setDoc).not.toHaveBeenCalled()
    await wiring.stop()
    await lonely.stop()
  })
})

describe('routed signal channel', () => {
  it('sends to the bound target, and delivers inbound signals while retargeting to the sender', async () => {
    const channel = createRoutedSignalChannel()
    await expect(channel.sendSignal({ a: 1 })).rejects.toThrow(/no signal target/)
    const sent = []
    const target = (name) => ({ sendSignal: async (m) => sent.push([name, m]), onSignal: (cb) => { target[name] = cb; return () => {} } })
    channel.bind(target('b'))
    await channel.sendSignal({ x: 1 })
    const got = []
    channel.onSignal((m) => got.push(m))
    channel.attach('dev-c', target('c'))
    target.c({ offer: true })
    await channel.sendSignal({ answer: true })
    expect(got).toEqual([{ offer: true }])
    expect(sent).toEqual([['b', { x: 1 }], ['c', { answer: true }]])
  })
})
