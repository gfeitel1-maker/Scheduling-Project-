// @vitest-environment node
//
// T359 slice 3 (T361 follow-ups): attemptLan dials a form libp2p accepts and isolates failures; a
// mismatched-identity connection is closed only when THIS dial opened it, and a missing remotePeer
// fails closed.
import Database from 'better-sqlite3'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { initSchema } from '../../db/localDb.js'
import { startTransport } from './transport.js'
import { rememberPeerAddress, redialTrustedPeers } from './peerAddressBook.js'
import { createAttemptLan } from './punchReconnectWiring.js'

const files = []
let handles = []
afterEach(async () => {
  await Promise.all(handles.splice(0).map((h) => h.stop()))
  for (const f of files.splice(0)) for (const s of ['', '-wal', '-shm']) if (fs.existsSync(f + s)) fs.unlinkSync(f + s)
})

async function setup() {
  const file = path.join(os.tmpdir(), `shoresh-lan-redial-${Date.now()}-${Math.random()}.sqlite`)
  files.push(file)
  const db = new Database(file)
  initSchema(db)
  const office = await startTransport({ deviceId: 'office', listen: ['/ip4/127.0.0.1/tcp/0'], onAuthenticate: () => ({ ok: true }) })
  const laptop = await startTransport({ deviceId: 'laptop' })
  handles.push(office, laptop)
  db.prepare("INSERT INTO devices (id, name, pairing_status, authorized_at, libp2p_peer_id) VALUES ('d1', 'd1', 'approved', '2026-10-01T00:00:00.000Z', ?)").run(office.peerId)
  const live = office.getMultiaddrs().map(String).find((m) => m.includes('/tcp/'))
  return { db, office, laptop, liveAddr: live.includes('/p2p/') ? live : `${live}/p2p/${office.peerId}` }
}

const lan = (s, dial = s.laptop.dial) => createAttemptLan({
  db: s.db,
  node: { dial, getPeers: () => s.laptop.getPeers() },
  isConnected: (p) => s.laptop.getPeers().includes(p),
  waitMs: 0,
})

describe('attemptLan over real libp2p', () => {
  it('actually connects to a valid remembered LAN address', async () => {
    const s = await setup()
    rememberPeerAddress(s.db, s.office.peerId, s.liveAddr)
    await expect(lan(s)({ peerId: s.office.peerId })).resolves.toBe(true)
    expect(s.laptop.getPeers()).toContain(s.office.peerId)
  })

  it('a throwing dial is isolated and reports not connected', async () => {
    const s = await setup()
    rememberPeerAddress(s.db, s.office.peerId, s.liveAddr)
    await expect(lan(s, async () => { throw new Error('boom') })({ peerId: s.office.peerId })).resolves.toBe(false)
  })

  it('every dial carries a 5s abort signal and no peer id in its target', async () => {
    const s = await setup()
    rememberPeerAddress(s.db, s.office.peerId, s.liveAddr)
    const dial = vi.fn(async () => undefined)
    await lan(s, dial)({ peerId: s.office.peerId })
    expect(dial.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal)
    expect(String(dial.mock.calls[0][0])).not.toContain('/p2p/')
  })
})

describe('mismatched identity closes only a connection this dial opened', () => {
  const seed = async () => {
    const s = await setup()
    rememberPeerAddress(s.db, s.office.peerId, s.liveAddr)
    return s
  }
  const run = (s, connection) => redialTrustedPeers(s.db, { dial: async () => connection, isConnected: () => false })

  it('redial: a pre-existing connection to another peer is left open', async () => {
    const s = await seed()
    const connection = { remotePeer: { toString: () => 'someone-else' }, timeline: { open: Date.now() - 60_000 }, close: vi.fn() }
    await run(s, connection)
    expect(connection.close).not.toHaveBeenCalled()
  })

  it('redial: a connection this dial opened is closed on mismatch', async () => {
    const s = await seed()
    const connection = { remotePeer: { toString: () => 'someone-else' }, timeline: { open: Date.now() + 1000 }, close: vi.fn() }
    await run(s, connection)
    expect(connection.close).toHaveBeenCalledTimes(1)
  })

  it('redial: a missing remotePeer fails closed (this dial\'s connection is closed)', async () => {
    const s = await seed()
    const connection = { timeline: { open: Date.now() + 1000 }, close: vi.fn() }
    await run(s, connection)
    expect(connection.close).toHaveBeenCalledTimes(1)
  })

  it('attemptLan: same rules, and a mismatch is not a success', async () => {
    const s = await seed()
    const old = { remotePeer: { toString: () => 'someone-else' }, timeline: { open: Date.now() - 60_000 }, close: vi.fn() }
    expect(await lan(s, async () => old)({ peerId: s.office.peerId })).toBe(false)
    expect(old.close).not.toHaveBeenCalled()
    const fresh = { timeline: { open: Date.now() + 1000 }, close: vi.fn() }
    expect(await lan(s, async () => fresh)({ peerId: s.office.peerId })).toBe(false)
    expect(fresh.close).toHaveBeenCalledTimes(1)
  })
})

describe('the 30-day LAN limit is skip-only', () => {
  it('a 31-day-old LAN row is not dialed but survives the redial (a later fresh sighting can revive it)', async () => {
    const s = await setup()
    const id = s.office.peerId
    const old = new Date(Date.now() - 31 * 24 * 3600e3).toISOString()
    rememberPeerAddress(s.db, id, `/ip4/10.0.0.5/tcp/4001/p2p/${id}`, () => old)
    const dial = vi.fn(async () => undefined)
    const attempted = await redialTrustedPeers(s.db, { dial, isConnected: () => false })
    expect(attempted).toEqual([])
    expect(dial).not.toHaveBeenCalled()
    expect(s.db.prepare('SELECT COUNT(*) AS n FROM peer_last_addresses WHERE peer_id = ?').get(id).n).toBe(1)
  })
})
