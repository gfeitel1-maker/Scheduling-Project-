// @vitest-environment node
//
// T361 (follows T328 slice 1 and T359 slice 2): the startup redial must dial remembered addresses in
// a form libp2p accepts, skip stale ones, and a refused/stale dial must never break a later
// discovery-driven (by peer id) dial for the same peer. Real two-node libp2p over TCP loopback.
import Database from 'better-sqlite3'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { initSchema, CURRENT_SCHEMA_VERSION } from '../../db/localDb.js'
import { startTransport } from './transport.js'
import { rememberPeerAddress, rememberMappedPeerAddress, redialTrustedPeers } from './peerAddressBook.js'

const files = []
let handles = []
afterEach(async () => {
  await Promise.all(handles.splice(0).map((h) => h.stop()))
  for (const f of files.splice(0)) for (const s of ['', '-wal', '-shm']) if (fs.existsSync(f + s)) fs.unlinkSync(f + s)
})

const DAY = 24 * 3600e3
const deadPort = () => new Promise((resolve) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)) })
})

async function setup({ revoked = false } = {}) {
  const file = path.join(os.tmpdir(), `shoresh-startup-redial-${Date.now()}-${Math.random()}.sqlite`)
  files.push(file)
  const db = new Database(file)
  initSchema(db)
  const office = await startTransport({ deviceId: 'office', listen: ['/ip4/127.0.0.1/tcp/0'], onAuthenticate: () => ({ ok: true }) })
  const laptop = await startTransport({ deviceId: 'laptop' })
  handles.push(office, laptop)
  db.prepare("INSERT INTO devices (id, name, pairing_status, authorized_at, revoked_at, libp2p_peer_id) VALUES ('d1', 'd1', 'approved', '2026-10-01T00:00:00.000Z', ?, ?)")
    .run(revoked ? '2026-10-02T00:00:00.000Z' : null, office.peerId)
  const live = office.getMultiaddrs().map(String).find((m) => m.includes('/tcp/'))
  return { db, office, laptop, liveAddr: live.includes('/p2p/') ? live : `${live}/p2p/${office.peerId}` }
}

const redial = (s, extra = {}) => redialTrustedPeers(s.db, { dial: s.laptop.dial, isConnected: (p) => s.laptop.getPeers().includes(p), ...extra })

describe('startup redial over real libp2p', () => {
  it('restart at the SAME LAN: refused stale ports do not break the discovery dial by peer id', async () => {
    const s = await setup()
    rememberPeerAddress(s.db, s.office.peerId, `/ip4/127.0.0.1/tcp/${await deadPort()}/p2p/${s.office.peerId}`)
    await s.laptop.libp2pNode.peerStore.merge(s.office.libp2pNode.peerId, { multiaddrs: [s.office.libp2pNode.getMultiaddrs()[0]] })
    const redialing = redial(s)
    const discovery = s.laptop.dial(s.office.peerId)
    await expect(discovery).resolves.toBeTruthy()
    await redialing
    expect(s.laptop.getPeers()).toContain(s.office.peerId)
  })

  it('a VALID remembered address connects and the peer is admitted through the auth gate', async () => {
    const s = await setup()
    rememberPeerAddress(s.db, s.office.peerId, s.liveAddr)
    await redial(s)
    expect(s.laptop.getPeers()).toContain(s.office.peerId)
    const resp = await s.laptop.authenticateWith(s.office.peerId, { type: 'authenticate', token: 't', device_id: 'laptop', schemaVersion: CURRENT_SCHEMA_VERSION })
    expect(resp.type).toBe('auth_ok')
    expect(s.office.isPeerAuthenticated(s.laptop.peerId)).toBe(true)
  })

  it('a revoked peer\'s remembered address is not redialed', async () => {
    const s = await setup({ revoked: true })
    rememberPeerAddress(s.db, s.office.peerId, s.liveAddr)
    const dial = vi.fn(s.laptop.dial)
    await redial(s, { dial })
    expect(dial).not.toHaveBeenCalled()
    expect(s.laptop.getPeers()).not.toContain(s.office.peerId)
  })
})

describe('startup redial freshness', () => {
  it('does not dial a LAN address older than 30 days, nor a mapped row older than 7 days; dials a fresh mapped row before a LAN row', async () => {
    const s = await setup()
    const id = s.office.peerId
    const stamp = (ms) => () => new Date(Date.now() - ms).toISOString()
    rememberPeerAddress(s.db, id, `/ip4/10.0.0.5/tcp/4001/p2p/${id}`, stamp(31 * DAY))
    rememberPeerAddress(s.db, id, `/ip4/10.0.0.6/tcp/4001/p2p/${id}`, stamp(1 * DAY))
    rememberMappedPeerAddress(s.db, id, `/ip4/34.120.1.7/tcp/50000/p2p/${id}`, { observedAtMs: Date.now() - 8 * DAY })
    const dial = vi.fn().mockResolvedValue(undefined)
    await redialTrustedPeers(s.db, { dial, isConnected: () => false })
    expect(dial.mock.calls.map((c) => String(c[0]))).toEqual(['/ip4/10.0.0.6/tcp/4001'])

    s.db.prepare('DELETE FROM peer_last_addresses').run()
    rememberPeerAddress(s.db, id, `/ip4/10.0.0.6/tcp/4001/p2p/${id}`, stamp(1 * DAY))
    rememberMappedPeerAddress(s.db, id, `/ip4/34.120.1.7/tcp/50000/p2p/${id}`, { observedAtMs: Date.now() - 6 * DAY })
    dial.mockClear()
    await redialTrustedPeers(s.db, { dial, isConnected: () => false })
    expect(dial.mock.calls.map((c) => String(c[0]))).toEqual(['/ip4/34.120.1.7/tcp/50000', '/ip4/10.0.0.6/tcp/4001'])
  })

  it('every dial carries its own abort signal', async () => {
    const s = await setup()
    rememberPeerAddress(s.db, s.office.peerId, s.liveAddr)
    const dial = vi.fn().mockResolvedValue(undefined)
    await redialTrustedPeers(s.db, { dial, isConnected: () => false })
    expect(dial.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal)
  })
})
