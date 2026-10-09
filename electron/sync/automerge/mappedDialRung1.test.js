// @vitest-environment node
//
// T359 slice 2: rung 1 dials the peer's remembered router-mapped TCP address FIRST, before the UDP punch
// attempt. Real two-node libp2p over TCP loopback (Noise); the loopback address stands in for the public
// mapped address via the test-only allowNonPublicMapped flag.
import Database from 'better-sqlite3'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { initSchema } from '../../db/localDb.js'
import { startTransport } from './transport.js'
import { attemptRung1 } from './punchRung1.js'
import { MAPPED_ADDRESS_MAX_AGE_MS } from './peerAddressBook.js'

const files = []
let handles = []
afterEach(async () => {
  await Promise.all(handles.splice(0).map((h) => h.stop()))
  for (const f of files.splice(0)) for (const s of ['', '-wal', '-shm']) if (fs.existsSync(f + s)) fs.unlinkSync(f + s)
})

async function setup({ ageMs = 1000 } = {}) {
  const file = path.join(os.tmpdir(), `shoresh-mapped-dial-${Date.now()}-${Math.random()}.sqlite`)
  files.push(file)
  const db = new Database(file)
  initSchema(db)
  const remote = await startTransport({ deviceId: 'device-a', listen: ['/ip4/127.0.0.1/tcp/0'], onAuthenticate: () => ({ ok: true }) })
  const local = await startTransport({ deviceId: 'device-b' })
  handles.push(remote, local)
  const peerId = remote.peerId
  db.prepare("INSERT INTO devices (id, name, pairing_status, authorized_at, libp2p_peer_id) VALUES ('d1', 'd1', 'approved', '2026-10-01T00:00:00.000Z', ?)").run(peerId)
  const tcp = remote.getMultiaddrs().map(String).find((m) => m.includes('/tcp/'))
  const addr = tcp.includes('/p2p/') ? tcp : `${tcp}/p2p/${peerId}`
  db.prepare('INSERT INTO peer_last_addresses (peer_id, multiaddr, last_seen_at) VALUES (?, ?, ?)').run(peerId, addr, new Date(Date.now() - ageMs).toISOString())
  const connectFromMemory = vi.fn(async () => { throw new Error('UDP punch must not be reached') })
  const dial = vi.fn((ma, opts) => local.dial(ma, opts))
  return { db, peerId, remote, local, dial, transport: { connectFromMemory }, deps: { db, upgrader: {}, allowNonPublicMapped: true } }
}

describe('attemptRung1 - mapped TCP address first', () => {
  it('dials the remembered mapped address over real libp2p+Noise and never touches the UDP punch', async () => {
    const s = await setup()
    const r = await attemptRung1({ peerId: s.peerId }, { ...s.deps, transport: s.transport, dial: s.dial })
    expect(r.ok).toBe(true)
    expect(r.connection.remotePeer.toString()).toBe(s.peerId)
    expect(s.dial).toHaveBeenCalledTimes(1)
    expect(s.transport.connectFromMemory).not.toHaveBeenCalled()
    expect(s.local.getPeers()).toContain(s.peerId)
  })

  it('a REVOKED peer\'s mapped address is not dialled', async () => {
    const s = await setup()
    s.db.prepare("UPDATE devices SET revoked_at = '2026-10-09T00:00:00.000Z' WHERE id = 'd1'").run()
    const r = await attemptRung1({ peerId: s.peerId }, { ...s.deps, transport: s.transport, dial: s.dial })
    expect(r).toEqual({ ok: false, reason: 'no-memory' })
    expect(s.dial).not.toHaveBeenCalled()
    expect(s.local.getPeers()).not.toContain(s.peerId)
  })

  it('a peer revoked in the authority cache mid-dial is refused: connection closed, reason revoked', async () => {
    const s = await setup()
    const r = await attemptRung1({ peerId: s.peerId }, { ...s.deps, transport: s.transport, dial: s.dial, isPeerRevoked: () => true })
    expect(r).toEqual({ ok: false, reason: 'revoked' })
    await vi.waitFor(() => expect(s.local.getPeers()).not.toContain(s.peerId))
  })

  it('the 7 day age limit applies on this path: an 8 day old row is not dialled', async () => {
    const s = await setup({ ageMs: MAPPED_ADDRESS_MAX_AGE_MS + 24 * 3600e3 })
    const r = await attemptRung1({ peerId: s.peerId }, { ...s.deps, transport: s.transport, dial: s.dial })
    expect(r.reason).toBe('no-memory')
    expect(s.dial).not.toHaveBeenCalled()
  })

  it('a failed mapped dial falls through to the UDP punch attempt', async () => {
    const s = await setup()
    await s.remote.stop()
    const r = await attemptRung1({ peerId: s.peerId }, { ...s.deps, transport: s.transport, dial: s.dial, timeoutMs: 2000 })
    expect(s.dial).toHaveBeenCalledTimes(1)
    expect(r.ok).toBe(false)
  })

  it('without an injected dial nothing changes: the memory path alone decides', async () => {
    const s = await setup()
    const r = await attemptRung1({ peerId: s.peerId }, { ...s.deps, transport: s.transport })
    expect(r).toEqual({ ok: false, reason: 'no-memory' })
  })
})
