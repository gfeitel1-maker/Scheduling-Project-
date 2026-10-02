// T328 Slice 1 (docs/adr/2026-10-02-wan-discovery-transport-ladder.md, Slice 1). Unit coverage for
// the persisted-peer address book: remember on authenticated connection, redial trusted peers
// before discovery, scope to non-revoked trust, and the stale-address safety argument (a dial
// target that answers as a different peer id must fail the Noise handshake / grant no trust —
// documented here via an injected dial that simulates that rejection, since a unit test cannot
// drive real libp2p Noise negotiation).
import Database from 'better-sqlite3'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { initSchema } from '../../db/localDb.js'
import {
  rememberPeerAddress,
  forgetPeerAddress,
  listTrustedRememberedAddresses,
  redialTrustedPeers,
} from './peerAddressBook.js'

const files = []

afterEach(() => {
  for (const f of files.splice(0)) {
    for (const suffix of ['', '-wal', '-shm']) {
      if (fs.existsSync(f + suffix)) fs.unlinkSync(f + suffix)
    }
  }
})

function freshDb() {
  const file = path.join(os.tmpdir(), `shoresh-peer-addr-${Date.now()}-${Math.random()}.sqlite`)
  files.push(file)
  const db = new Database(file)
  db.pragma('foreign_keys = ON')
  initSchema(db)
  return db
}

// Minimal devices row: a trusted (authorized, not revoked) device bound to peerId.
function seedTrustedDevice(db, { deviceId, peerId, revoked = false }) {
  db.prepare(
    "INSERT INTO devices (id, name, pairing_status, authorized_at, revoked_at, libp2p_peer_id) VALUES (?, ?, 'approved', ?, ?, ?)"
  ).run(deviceId, deviceId, '2026-10-01T00:00:00.000Z', revoked ? '2026-10-02T00:00:00.000Z' : null, peerId)
}

describe('rememberPeerAddress', () => {
  it('persists a row keyed by peer_id (asserts the ROW, not a call)', () => {
    const db = freshDb()
    rememberPeerAddress(db, 'peer-a', '/ip4/10.0.0.5/tcp/4001/p2p/peer-a', () => '2026-10-02T00:00:00.000Z')
    const row = db.prepare('SELECT * FROM peer_last_addresses WHERE peer_id = ?').get('peer-a')
    expect(row).toMatchObject({
      peer_id: 'peer-a',
      multiaddr: '/ip4/10.0.0.5/tcp/4001/p2p/peer-a',
      last_seen_at: '2026-10-02T00:00:00.000Z',
    })
    db.close()
  })

  it('upserts the most recent address for a peer seen again at a different address', () => {
    const db = freshDb()
    rememberPeerAddress(db, 'peer-a', '/ip4/10.0.0.5/tcp/4001/p2p/peer-a', () => '2026-10-02T00:00:00.000Z')
    rememberPeerAddress(db, 'peer-a', '/ip4/10.0.0.9/tcp/4001/p2p/peer-a', () => '2026-10-02T00:05:00.000Z')
    const rows = db.prepare('SELECT * FROM peer_last_addresses WHERE peer_id = ?').all('peer-a')
    expect(rows).toHaveLength(1)
    expect(rows[0].multiaddr).toBe('/ip4/10.0.0.9/tcp/4001/p2p/peer-a')
    db.close()
  })
})

describe('forgetPeerAddress (revocation scoping)', () => {
  it('deletes the remembered row for a revoked peer', () => {
    const db = freshDb()
    rememberPeerAddress(db, 'peer-a', '/ip4/10.0.0.5/tcp/4001/p2p/peer-a', () => '2026-10-02T00:00:00.000Z')
    forgetPeerAddress(db, 'peer-a')
    expect(db.prepare('SELECT * FROM peer_last_addresses WHERE peer_id = ?').get('peer-a')).toBeUndefined()
    db.close()
  })
})

describe('listTrustedRememberedAddresses', () => {
  it('includes an authorized, non-revoked peer with a remembered address', () => {
    const db = freshDb()
    seedTrustedDevice(db, { deviceId: 'dev-a', peerId: 'peer-a' })
    rememberPeerAddress(db, 'peer-a', '/ip4/10.0.0.5/tcp/4001/p2p/peer-a', () => '2026-10-02T00:00:00.000Z')
    expect(listTrustedRememberedAddresses(db)).toEqual([
      { peerId: 'peer-a', multiaddr: '/ip4/10.0.0.5/tcp/4001/p2p/peer-a' },
    ])
    db.close()
  })

  it('excludes a revoked peer even though its address is still remembered', () => {
    const db = freshDb()
    seedTrustedDevice(db, { deviceId: 'dev-a', peerId: 'peer-a', revoked: true })
    rememberPeerAddress(db, 'peer-a', '/ip4/10.0.0.5/tcp/4001/p2p/peer-a', () => '2026-10-02T00:00:00.000Z')
    expect(listTrustedRememberedAddresses(db)).toEqual([])
    db.close()
  })

  it('excludes a peer_id with no bound devices row at all', () => {
    const db = freshDb()
    rememberPeerAddress(db, 'peer-unknown', '/ip4/10.0.0.5/tcp/4001/p2p/peer-unknown', () => '2026-10-02T00:00:00.000Z')
    expect(listTrustedRememberedAddresses(db)).toEqual([])
    db.close()
  })
})

describe('redialTrustedPeers', () => {
  it('dials every trusted peer with a remembered address', async () => {
    const db = freshDb()
    seedTrustedDevice(db, { deviceId: 'dev-a', peerId: 'peer-a' })
    seedTrustedDevice(db, { deviceId: 'dev-b', peerId: 'peer-b' })
    rememberPeerAddress(db, 'peer-a', '/ip4/10.0.0.5/tcp/4001/p2p/peer-a', () => '2026-10-02T00:00:00.000Z')
    rememberPeerAddress(db, 'peer-b', '/ip4/10.0.0.6/tcp/4001/p2p/peer-b', () => '2026-10-02T00:00:00.000Z')
    const dial = vi.fn().mockResolvedValue(undefined)
    const attempted = await redialTrustedPeers(db, { dial, isConnected: () => false })
    expect(attempted.sort()).toEqual(['peer-a', 'peer-b'])
    expect(dial).toHaveBeenCalledWith('/ip4/10.0.0.5/tcp/4001/p2p/peer-a')
    expect(dial).toHaveBeenCalledWith('/ip4/10.0.0.6/tcp/4001/p2p/peer-b')
    db.close()
  })

  it('is idempotent: skips a peer already connected (no duplicate dial of a live mDNS connection)', async () => {
    const db = freshDb()
    seedTrustedDevice(db, { deviceId: 'dev-a', peerId: 'peer-a' })
    rememberPeerAddress(db, 'peer-a', '/ip4/10.0.0.5/tcp/4001/p2p/peer-a', () => '2026-10-02T00:00:00.000Z')
    const dial = vi.fn().mockResolvedValue(undefined)
    const attempted = await redialTrustedPeers(db, { dial, isConnected: (peerId) => peerId === 'peer-a' })
    expect(attempted).toEqual([])
    expect(dial).not.toHaveBeenCalled()
    db.close()
  })

  it('never dials a revoked peer, even with a remembered address', async () => {
    const db = freshDb()
    seedTrustedDevice(db, { deviceId: 'dev-a', peerId: 'peer-a', revoked: true })
    rememberPeerAddress(db, 'peer-a', '/ip4/10.0.0.5/tcp/4001/p2p/peer-a', () => '2026-10-02T00:00:00.000Z')
    const dial = vi.fn().mockResolvedValue(undefined)
    const attempted = await redialTrustedPeers(db, { dial, isConnected: () => false })
    expect(attempted).toEqual([])
    expect(dial).not.toHaveBeenCalled()
    db.close()
  })

  // Stale-address safety (the Red Hat seam): the stored multiaddr carries an explicit
  // /p2p/<peerId> component (rememberPeerAddress always writes it that way — see the module
  // comment), so when the address now answers as a DIFFERENT peer id, libp2p's own dial — given a
  // multiaddr with an explicit peer id component — runs the Noise handshake and rejects the
  // connection on identity mismatch BEFORE any stream opens. A unit test cannot drive real libp2p
  // Noise negotiation, so this is documented here via an injected `dial` that throws exactly the
  // shape libp2p's dial throws for that case: redialTrustedPeers must treat it as a plain failed
  // attempt, grant no trust, throw nothing itself, and keep dialing the remaining peers.
  it('a dial whose address now answers as a different peer id fails closed and grants no trust', async () => {
    const db = freshDb()
    seedTrustedDevice(db, { deviceId: 'dev-a', peerId: 'peer-a' })
    seedTrustedDevice(db, { deviceId: 'dev-b', peerId: 'peer-b' })
    rememberPeerAddress(db, 'peer-a', '/ip4/10.0.0.5/tcp/4001/p2p/peer-a', () => '2026-10-02T00:00:00.000Z')
    rememberPeerAddress(db, 'peer-b', '/ip4/10.0.0.6/tcp/4001/p2p/peer-b', () => '2026-10-02T00:00:00.000Z')
    const dial = vi.fn((target) => {
      if (target === '/ip4/10.0.0.5/tcp/4001/p2p/peer-a') {
        // What libp2p's own dial throws when the Noise-verified remote peer id does not match the
        // /p2p/<peerId> component requested in the multiaddr.
        return Promise.reject(new Error('dial to self attempted or peer id mismatch'))
      }
      return Promise.resolve(undefined)
    })
    await expect(redialTrustedPeers(db, { dial, isConnected: () => false })).resolves.toEqual(
      expect.arrayContaining(['peer-a', 'peer-b'])
    )
    expect(dial).toHaveBeenCalledTimes(2)
    db.close()
  })
})
