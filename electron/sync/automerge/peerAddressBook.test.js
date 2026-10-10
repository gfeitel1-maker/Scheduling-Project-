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
  PEER_LAST_ADDRESSES_MAX_PER_PEER,
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
  const file = path.join(os.tmpdir(), `shoresh-12D3KooWJXxQkvHsETESzA6zVZQnFBqcM9DhAezDumJ69iNLvzUuddr-${Date.now()}-${Math.random()}.sqlite`)
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
    rememberPeerAddress(db, '12D3KooWJXxQkvHsETESzA6zVZQnFBqcM9DhAezDumJ69iNLvzUu', '/ip4/10.0.0.5/tcp/4001/p2p/12D3KooWJXxQkvHsETESzA6zVZQnFBqcM9DhAezDumJ69iNLvzUu', () => '2026-10-02T00:00:00.000Z')
    const row = db.prepare('SELECT * FROM peer_last_addresses WHERE peer_id = ?').get('12D3KooWJXxQkvHsETESzA6zVZQnFBqcM9DhAezDumJ69iNLvzUu')
    expect(row).toMatchObject({
      peer_id: '12D3KooWJXxQkvHsETESzA6zVZQnFBqcM9DhAezDumJ69iNLvzUu',
      multiaddr: '/ip4/10.0.0.5/tcp/4001/p2p/12D3KooWJXxQkvHsETESzA6zVZQnFBqcM9DhAezDumJ69iNLvzUu',
      last_seen_at: '2026-10-02T00:00:00.000Z',
    })
    db.close()
  })

  // Correction pass (T328 Slice 1): the ADR says "last-known multiaddrs", plural. v88's
  // last-write-wins behavior (one row, newest overwrites) defeated reconnect for a multi-homed
  // peer by silently discarding a still-good address. This is the regression test for that.
  it('keeps BOTH addresses for a multi-homed peer seen at two different addresses', () => {
    const db = freshDb()
    rememberPeerAddress(db, '12D3KooWJXxQkvHsETESzA6zVZQnFBqcM9DhAezDumJ69iNLvzUu', '/ip4/10.0.0.5/tcp/4001/p2p/12D3KooWJXxQkvHsETESzA6zVZQnFBqcM9DhAezDumJ69iNLvzUu', () => '2026-10-02T00:00:00.000Z')
    rememberPeerAddress(db, '12D3KooWJXxQkvHsETESzA6zVZQnFBqcM9DhAezDumJ69iNLvzUu', '/ip4/192.168.1.9/tcp/4001/p2p/12D3KooWJXxQkvHsETESzA6zVZQnFBqcM9DhAezDumJ69iNLvzUu', () => '2026-10-02T00:05:00.000Z')
    const rows = db.prepare('SELECT multiaddr FROM peer_last_addresses WHERE peer_id = ? ORDER BY multiaddr').all('12D3KooWJXxQkvHsETESzA6zVZQnFBqcM9DhAezDumJ69iNLvzUu')
    expect(rows.map((r) => r.multiaddr)).toEqual([
      '/ip4/10.0.0.5/tcp/4001/p2p/12D3KooWJXxQkvHsETESzA6zVZQnFBqcM9DhAezDumJ69iNLvzUu',
      '/ip4/192.168.1.9/tcp/4001/p2p/12D3KooWJXxQkvHsETESzA6zVZQnFBqcM9DhAezDumJ69iNLvzUu',
    ])
    db.close()
  })

  it('updates last_seen_at in place (no duplicate row) when the SAME address is seen again', () => {
    const db = freshDb()
    rememberPeerAddress(db, '12D3KooWJXxQkvHsETESzA6zVZQnFBqcM9DhAezDumJ69iNLvzUu', '/ip4/10.0.0.5/tcp/4001/p2p/12D3KooWJXxQkvHsETESzA6zVZQnFBqcM9DhAezDumJ69iNLvzUu', () => '2026-10-02T00:00:00.000Z')
    rememberPeerAddress(db, '12D3KooWJXxQkvHsETESzA6zVZQnFBqcM9DhAezDumJ69iNLvzUu', '/ip4/10.0.0.5/tcp/4001/p2p/12D3KooWJXxQkvHsETESzA6zVZQnFBqcM9DhAezDumJ69iNLvzUu', () => '2026-10-02T00:05:00.000Z')
    const rows = db.prepare('SELECT * FROM peer_last_addresses WHERE peer_id = ?').all('12D3KooWJXxQkvHsETESzA6zVZQnFBqcM9DhAezDumJ69iNLvzUu')
    expect(rows).toHaveLength(1)
    expect(rows[0].last_seen_at).toBe('2026-10-02T00:05:00.000Z')
    db.close()
  })

  // The cap: unbounded growth is the obvious failure mode of "remember every distinct address
  // forever". PEER_LAST_ADDRESSES_MAX_PER_PEER (5) most-recent-by-last_seen_at rows survive;
  // older ones are pruned on every remember.
  it(`prunes to the ${PEER_LAST_ADDRESSES_MAX_PER_PEER} most-recent addresses, discarding the oldest`, () => {
    const db = freshDb()
    const total = PEER_LAST_ADDRESSES_MAX_PER_PEER + 2
    for (let i = 0; i < total; i += 1) {
      rememberPeerAddress(db, '12D3KooWJXxQkvHsETESzA6zVZQnFBqcM9DhAezDumJ69iNLvzUu', `/ip4/10.0.0.${i}/tcp/4001/p2p/12D3KooWJXxQkvHsETESzA6zVZQnFBqcM9DhAezDumJ69iNLvzUu`, () => `2026-10-02T00:0${i}:00.000Z`)
    }
    const rows = db.prepare('SELECT multiaddr, last_seen_at FROM peer_last_addresses WHERE peer_id = ? ORDER BY last_seen_at').all('12D3KooWJXxQkvHsETESzA6zVZQnFBqcM9DhAezDumJ69iNLvzUu')
    expect(rows).toHaveLength(PEER_LAST_ADDRESSES_MAX_PER_PEER)
    // The two oldest (i = 0, 1) must be gone; the newest (total - 1) must survive.
    expect(rows.map((r) => r.multiaddr)).not.toContain('/ip4/10.0.0.0/tcp/4001/p2p/12D3KooWJXxQkvHsETESzA6zVZQnFBqcM9DhAezDumJ69iNLvzUu')
    expect(rows.map((r) => r.multiaddr)).not.toContain('/ip4/10.0.0.1/tcp/4001/p2p/12D3KooWJXxQkvHsETESzA6zVZQnFBqcM9DhAezDumJ69iNLvzUu')
    expect(rows.map((r) => r.multiaddr)).toContain(`/ip4/10.0.0.${total - 1}/tcp/4001/p2p/12D3KooWJXxQkvHsETESzA6zVZQnFBqcM9DhAezDumJ69iNLvzUu`)
    db.close()
  })

  it('pruning is scoped per peer_id — a different peer\'s rows are never touched', () => {
    const db = freshDb()
    for (let i = 0; i < PEER_LAST_ADDRESSES_MAX_PER_PEER + 2; i += 1) {
      rememberPeerAddress(db, '12D3KooWJXxQkvHsETESzA6zVZQnFBqcM9DhAezDumJ69iNLvzUu', `/ip4/10.0.0.${i}/tcp/4001/p2p/12D3KooWJXxQkvHsETESzA6zVZQnFBqcM9DhAezDumJ69iNLvzUu`, () => `2026-10-02T00:0${i}:00.000Z`)
    }
    rememberPeerAddress(db, '12D3KooWDYCvjdPsGec3uqwTjMP8b6GoB4CXgZxua9VZvQ1YR8vj', '/ip4/10.0.1.1/tcp/4001/p2p/12D3KooWDYCvjdPsGec3uqwTjMP8b6GoB4CXgZxua9VZvQ1YR8vj', () => '2026-10-02T00:00:00.000Z')
    expect(db.prepare('SELECT COUNT(*) c FROM peer_last_addresses WHERE peer_id = ?').get('12D3KooWDYCvjdPsGec3uqwTjMP8b6GoB4CXgZxua9VZvQ1YR8vj').c).toBe(1)
    db.close()
  })
})

describe('forgetPeerAddress (revocation scoping)', () => {
  it('deletes the remembered row for a revoked peer', () => {
    const db = freshDb()
    rememberPeerAddress(db, '12D3KooWJXxQkvHsETESzA6zVZQnFBqcM9DhAezDumJ69iNLvzUu', '/ip4/10.0.0.5/tcp/4001/p2p/12D3KooWJXxQkvHsETESzA6zVZQnFBqcM9DhAezDumJ69iNLvzUu', () => '2026-10-02T00:00:00.000Z')
    forgetPeerAddress(db, '12D3KooWJXxQkvHsETESzA6zVZQnFBqcM9DhAezDumJ69iNLvzUu')
    expect(db.prepare('SELECT * FROM peer_last_addresses WHERE peer_id = ?').get('12D3KooWJXxQkvHsETESzA6zVZQnFBqcM9DhAezDumJ69iNLvzUu')).toBeUndefined()
    db.close()
  })
})

describe('listTrustedRememberedAddresses', () => {
  it('includes an authorized, non-revoked peer with a remembered address', () => {
    const db = freshDb()
    seedTrustedDevice(db, { deviceId: 'dev-a', peerId: '12D3KooWJXxQkvHsETESzA6zVZQnFBqcM9DhAezDumJ69iNLvzUu' })
    rememberPeerAddress(db, '12D3KooWJXxQkvHsETESzA6zVZQnFBqcM9DhAezDumJ69iNLvzUu', '/ip4/10.0.0.5/tcp/4001/p2p/12D3KooWJXxQkvHsETESzA6zVZQnFBqcM9DhAezDumJ69iNLvzUu', () => '2026-10-02T00:00:00.000Z')
    expect(listTrustedRememberedAddresses(db)).toEqual([
      { peerId: '12D3KooWJXxQkvHsETESzA6zVZQnFBqcM9DhAezDumJ69iNLvzUu', multiaddr: '/ip4/10.0.0.5/tcp/4001/p2p/12D3KooWJXxQkvHsETESzA6zVZQnFBqcM9DhAezDumJ69iNLvzUu' },
    ])
    db.close()
  })

  it('excludes a revoked peer even though its address is still remembered', () => {
    const db = freshDb()
    seedTrustedDevice(db, { deviceId: 'dev-a', peerId: '12D3KooWJXxQkvHsETESzA6zVZQnFBqcM9DhAezDumJ69iNLvzUu', revoked: true })
    rememberPeerAddress(db, '12D3KooWJXxQkvHsETESzA6zVZQnFBqcM9DhAezDumJ69iNLvzUu', '/ip4/10.0.0.5/tcp/4001/p2p/12D3KooWJXxQkvHsETESzA6zVZQnFBqcM9DhAezDumJ69iNLvzUu', () => '2026-10-02T00:00:00.000Z')
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

describe('listTrustedRememberedAddresses: multiple addresses per peer', () => {
  it('returns every remembered address for a multi-homed trusted peer', () => {
    const db = freshDb()
    seedTrustedDevice(db, { deviceId: 'dev-a', peerId: '12D3KooWJXxQkvHsETESzA6zVZQnFBqcM9DhAezDumJ69iNLvzUu' })
    rememberPeerAddress(db, '12D3KooWJXxQkvHsETESzA6zVZQnFBqcM9DhAezDumJ69iNLvzUu', '/ip4/10.0.0.5/tcp/4001/p2p/12D3KooWJXxQkvHsETESzA6zVZQnFBqcM9DhAezDumJ69iNLvzUu', () => '2026-10-02T00:00:00.000Z')
    rememberPeerAddress(db, '12D3KooWJXxQkvHsETESzA6zVZQnFBqcM9DhAezDumJ69iNLvzUu', '/ip4/192.168.1.9/tcp/4001/p2p/12D3KooWJXxQkvHsETESzA6zVZQnFBqcM9DhAezDumJ69iNLvzUu', () => '2026-10-02T00:05:00.000Z')
    const results = listTrustedRememberedAddresses(db)
    expect(results).toHaveLength(2)
    expect(results.map((r) => r.multiaddr).sort()).toEqual([
      '/ip4/10.0.0.5/tcp/4001/p2p/12D3KooWJXxQkvHsETESzA6zVZQnFBqcM9DhAezDumJ69iNLvzUu',
      '/ip4/192.168.1.9/tcp/4001/p2p/12D3KooWJXxQkvHsETESzA6zVZQnFBqcM9DhAezDumJ69iNLvzUu',
    ])
  })
})

const dialed = (dial) => dial.mock.calls.map((c) => String(c[0]))

describe('redialTrustedPeers', () => {
  it('tries ALL remembered addresses for a multi-homed trusted peer', async () => {
    const db = freshDb()
    seedTrustedDevice(db, { deviceId: 'dev-a', peerId: '12D3KooWJXxQkvHsETESzA6zVZQnFBqcM9DhAezDumJ69iNLvzUu' })
    rememberPeerAddress(db, '12D3KooWJXxQkvHsETESzA6zVZQnFBqcM9DhAezDumJ69iNLvzUu', '/ip4/10.0.0.5/tcp/4001/p2p/12D3KooWJXxQkvHsETESzA6zVZQnFBqcM9DhAezDumJ69iNLvzUu', () => '2026-10-02T00:00:00.000Z')
    rememberPeerAddress(db, '12D3KooWJXxQkvHsETESzA6zVZQnFBqcM9DhAezDumJ69iNLvzUu', '/ip4/192.168.1.9/tcp/4001/p2p/12D3KooWJXxQkvHsETESzA6zVZQnFBqcM9DhAezDumJ69iNLvzUu', () => '2026-10-02T00:05:00.000Z')
    const dial = vi.fn().mockResolvedValue(undefined)
    await redialTrustedPeers(db, { dial, isConnected: () => false })
    expect(dialed(dial)).toContain('/ip4/10.0.0.5/tcp/4001')
    expect(dialed(dial)).toContain('/ip4/192.168.1.9/tcp/4001')
    expect(dial).toHaveBeenCalledTimes(2)
    db.close()
  })

  // Security + Red Hat (correction pass): a trust snapshot taken once and then looped over is a
  // TOCTOU — a revoke landing after the snapshot but before a given target's own dial must still
  // be honored. `isPeerTrusted` is re-checked IMMEDIATELY BEFORE each individual dial, not once
  // for the whole batch — modeled here by a trust predicate that answers differently per peer
  // (as if a revoke had just landed for 12D3KooWDYCvjdPsGec3uqwTjMP8b6GoB4CXgZxua9VZvQ1YR8vj between the snapshot and 12D3KooWDYCvjdPsGec3uqwTjMP8b6GoB4CXgZxua9VZvQ1YR8vj's own check).
  it('re-checks trust per target immediately before its dial — a peer revoked after the snapshot is not dialed', async () => {
    const db = freshDb()
    seedTrustedDevice(db, { deviceId: 'dev-a', peerId: '12D3KooWJXxQkvHsETESzA6zVZQnFBqcM9DhAezDumJ69iNLvzUu' })
    seedTrustedDevice(db, { deviceId: 'dev-b', peerId: '12D3KooWDYCvjdPsGec3uqwTjMP8b6GoB4CXgZxua9VZvQ1YR8vj' })
    rememberPeerAddress(db, '12D3KooWJXxQkvHsETESzA6zVZQnFBqcM9DhAezDumJ69iNLvzUu', '/ip4/10.0.0.5/tcp/4001/p2p/12D3KooWJXxQkvHsETESzA6zVZQnFBqcM9DhAezDumJ69iNLvzUu', () => '2026-10-02T00:00:00.000Z')
    rememberPeerAddress(db, '12D3KooWDYCvjdPsGec3uqwTjMP8b6GoB4CXgZxua9VZvQ1YR8vj', '/ip4/10.0.0.6/tcp/4001/p2p/12D3KooWDYCvjdPsGec3uqwTjMP8b6GoB4CXgZxua9VZvQ1YR8vj', () => '2026-10-02T00:00:00.000Z')
    const dial = vi.fn().mockResolvedValue(undefined)
    // Both peers are still trusted in the DB (the snapshot via listTrustedRememberedAddresses
    // would include both) — isPeerTrusted is the INJECTED fresh re-check, simulating a revoke
    // that landed for 12D3KooWDYCvjdPsGec3uqwTjMP8b6GoB4CXgZxua9VZvQ1YR8vj in the window between the snapshot and 12D3KooWDYCvjdPsGec3uqwTjMP8b6GoB4CXgZxua9VZvQ1YR8vj's own dial.
    const isPeerTrusted = vi.fn((peerId) => peerId !== '12D3KooWDYCvjdPsGec3uqwTjMP8b6GoB4CXgZxua9VZvQ1YR8vj')
    const attempted = await redialTrustedPeers(db, { dial, isConnected: () => false, isPeerTrusted })
    expect(isPeerTrusted).toHaveBeenCalledWith('12D3KooWJXxQkvHsETESzA6zVZQnFBqcM9DhAezDumJ69iNLvzUu')
    expect(isPeerTrusted).toHaveBeenCalledWith('12D3KooWDYCvjdPsGec3uqwTjMP8b6GoB4CXgZxua9VZvQ1YR8vj')
    expect(dialed(dial)).toContain('/ip4/10.0.0.5/tcp/4001')
    expect(dialed(dial)).not.toContain('/ip4/10.0.0.6/tcp/4001')
    expect(attempted).toEqual(['12D3KooWJXxQkvHsETESzA6zVZQnFBqcM9DhAezDumJ69iNLvzUu'])
    db.close()
  })

  // Parallelization (minor, folded in): one slow/stale address must not serialize the rest. If
  // the loop were sequential, 12D3KooWDYCvjdPsGec3uqwTjMP8b6GoB4CXgZxua9VZvQ1YR8vj's dial would not even START until 12D3KooWJXxQkvHsETESzA6zVZQnFBqcM9DhAezDumJ69iNLvzUu's pending promise
  // settles. Asserting this requires controlling resolution order by hand (a plain
  // mockResolvedValue can't distinguish "ran in parallel" from "ran in sequence").
  it('dials every target in parallel — a slow address does not block the others from starting', async () => {
    const db = freshDb()
    seedTrustedDevice(db, { deviceId: 'dev-a', peerId: '12D3KooWJXxQkvHsETESzA6zVZQnFBqcM9DhAezDumJ69iNLvzUu' })
    seedTrustedDevice(db, { deviceId: 'dev-b', peerId: '12D3KooWDYCvjdPsGec3uqwTjMP8b6GoB4CXgZxua9VZvQ1YR8vj' })
    rememberPeerAddress(db, '12D3KooWJXxQkvHsETESzA6zVZQnFBqcM9DhAezDumJ69iNLvzUu', '/ip4/10.0.0.5/tcp/4001/p2p/12D3KooWJXxQkvHsETESzA6zVZQnFBqcM9DhAezDumJ69iNLvzUu', () => '2026-10-02T00:00:00.000Z')
    rememberPeerAddress(db, '12D3KooWDYCvjdPsGec3uqwTjMP8b6GoB4CXgZxua9VZvQ1YR8vj', '/ip4/10.0.0.6/tcp/4001/p2p/12D3KooWDYCvjdPsGec3uqwTjMP8b6GoB4CXgZxua9VZvQ1YR8vj', () => '2026-10-02T00:00:00.000Z')
    let resolveSlow
    const started = []
    const dial = vi.fn((target) => {
      started.push(target)
      if (String(target) === '/ip4/10.0.0.5/tcp/4001') {
        return new Promise((resolve) => { resolveSlow = resolve })
      }
      return Promise.resolve(undefined)
    })
    const redialPromise = redialTrustedPeers(db, { dial, isConnected: () => false })
    // Give the fast (12D3KooWDYCvjdPsGec3uqwTjMP8b6GoB4CXgZxua9VZvQ1YR8vj) dial a chance to run its microtasks. If the loop were sequential
    // (awaiting 12D3KooWJXxQkvHsETESzA6zVZQnFBqcM9DhAezDumJ69iNLvzUu before even calling dial for 12D3KooWDYCvjdPsGec3uqwTjMP8b6GoB4CXgZxua9VZvQ1YR8vj), 12D3KooWDYCvjdPsGec3uqwTjMP8b6GoB4CXgZxua9VZvQ1YR8vj's target would NOT be in
    // `started` yet at this point, because 12D3KooWJXxQkvHsETESzA6zVZQnFBqcM9DhAezDumJ69iNLvzUu's promise is still pending.
    await Promise.resolve()
    await Promise.resolve()
    expect(started.map(String)).toContain('/ip4/10.0.0.6/tcp/4001')
    resolveSlow(undefined)
    await redialPromise
    db.close()
  })

  it('dials every trusted peer with a remembered address', async () => {
    const db = freshDb()
    seedTrustedDevice(db, { deviceId: 'dev-a', peerId: '12D3KooWJXxQkvHsETESzA6zVZQnFBqcM9DhAezDumJ69iNLvzUu' })
    seedTrustedDevice(db, { deviceId: 'dev-b', peerId: '12D3KooWDYCvjdPsGec3uqwTjMP8b6GoB4CXgZxua9VZvQ1YR8vj' })
    rememberPeerAddress(db, '12D3KooWJXxQkvHsETESzA6zVZQnFBqcM9DhAezDumJ69iNLvzUu', '/ip4/10.0.0.5/tcp/4001/p2p/12D3KooWJXxQkvHsETESzA6zVZQnFBqcM9DhAezDumJ69iNLvzUu', () => '2026-10-02T00:00:00.000Z')
    rememberPeerAddress(db, '12D3KooWDYCvjdPsGec3uqwTjMP8b6GoB4CXgZxua9VZvQ1YR8vj', '/ip4/10.0.0.6/tcp/4001/p2p/12D3KooWDYCvjdPsGec3uqwTjMP8b6GoB4CXgZxua9VZvQ1YR8vj', () => '2026-10-02T00:00:00.000Z')
    const dial = vi.fn().mockResolvedValue(undefined)
    const attempted = await redialTrustedPeers(db, { dial, isConnected: () => false })
    expect([...attempted].sort()).toEqual(['12D3KooWDYCvjdPsGec3uqwTjMP8b6GoB4CXgZxua9VZvQ1YR8vj', '12D3KooWJXxQkvHsETESzA6zVZQnFBqcM9DhAezDumJ69iNLvzUu'])
    expect(dialed(dial)).toContain('/ip4/10.0.0.5/tcp/4001')
    expect(dialed(dial)).toContain('/ip4/10.0.0.6/tcp/4001')
    db.close()
  })

  it('is idempotent: skips a peer already connected (no duplicate dial of a live mDNS connection)', async () => {
    const db = freshDb()
    seedTrustedDevice(db, { deviceId: 'dev-a', peerId: '12D3KooWJXxQkvHsETESzA6zVZQnFBqcM9DhAezDumJ69iNLvzUu' })
    rememberPeerAddress(db, '12D3KooWJXxQkvHsETESzA6zVZQnFBqcM9DhAezDumJ69iNLvzUu', '/ip4/10.0.0.5/tcp/4001/p2p/12D3KooWJXxQkvHsETESzA6zVZQnFBqcM9DhAezDumJ69iNLvzUu', () => '2026-10-02T00:00:00.000Z')
    const dial = vi.fn().mockResolvedValue(undefined)
    const attempted = await redialTrustedPeers(db, { dial, isConnected: (peerId) => peerId === '12D3KooWJXxQkvHsETESzA6zVZQnFBqcM9DhAezDumJ69iNLvzUu' })
    expect(attempted).toEqual([])
    expect(dial).not.toHaveBeenCalled()
    db.close()
  })

  it('never dials a revoked peer, even with a remembered address', async () => {
    const db = freshDb()
    seedTrustedDevice(db, { deviceId: 'dev-a', peerId: '12D3KooWJXxQkvHsETESzA6zVZQnFBqcM9DhAezDumJ69iNLvzUu', revoked: true })
    rememberPeerAddress(db, '12D3KooWJXxQkvHsETESzA6zVZQnFBqcM9DhAezDumJ69iNLvzUu', '/ip4/10.0.0.5/tcp/4001/p2p/12D3KooWJXxQkvHsETESzA6zVZQnFBqcM9DhAezDumJ69iNLvzUu', () => '2026-10-02T00:00:00.000Z')
    const dial = vi.fn().mockResolvedValue(undefined)
    const attempted = await redialTrustedPeers(db, { dial, isConnected: () => false })
    expect(attempted).toEqual([])
    expect(dial).not.toHaveBeenCalled()
    db.close()
  })

  // Stale-address safety (the Red Hat seam) — redialTrustedPeers' OWN error-handling contract:
  // given a dial that rejects (for whatever reason), it must treat that as a plain failed
  // attempt, grant no trust, throw nothing itself, and keep dialing the remaining peers. The
  // underlying PREMISE this models — that libp2p's Noise handshake itself rejects a /p2p-pinned
  // dial whose remote answers under a different identity — is no longer merely assumed here: it
  // is verified by a REAL two-node (three-node) libp2p test in transport.test.js's "stale-address
  // safety" case, which dials a genuine listening node's real address with a DIFFERENT peer's id
  // spliced into the multiaddr and asserts the real Noise handshake rejects it (plus a control
  // proving the same address with its own real id connects fine, ruling out "that was just a
  // network failure"). This test stays at the unit level deliberately: it is testing
  // redialTrustedPeers' error-handling, not libp2p's handshake, so an injected rejection is the
  // right tool here — see transport.test.js for the handshake-level proof.
  it('a dial whose address now answers as a different peer id fails closed and grants no trust', async () => {
    const db = freshDb()
    seedTrustedDevice(db, { deviceId: 'dev-a', peerId: '12D3KooWJXxQkvHsETESzA6zVZQnFBqcM9DhAezDumJ69iNLvzUu' })
    seedTrustedDevice(db, { deviceId: 'dev-b', peerId: '12D3KooWDYCvjdPsGec3uqwTjMP8b6GoB4CXgZxua9VZvQ1YR8vj' })
    rememberPeerAddress(db, '12D3KooWJXxQkvHsETESzA6zVZQnFBqcM9DhAezDumJ69iNLvzUu', '/ip4/10.0.0.5/tcp/4001/p2p/12D3KooWJXxQkvHsETESzA6zVZQnFBqcM9DhAezDumJ69iNLvzUu', () => '2026-10-02T00:00:00.000Z')
    rememberPeerAddress(db, '12D3KooWDYCvjdPsGec3uqwTjMP8b6GoB4CXgZxua9VZvQ1YR8vj', '/ip4/10.0.0.6/tcp/4001/p2p/12D3KooWDYCvjdPsGec3uqwTjMP8b6GoB4CXgZxua9VZvQ1YR8vj', () => '2026-10-02T00:00:00.000Z')
    const dial = vi.fn((target) => {
      if (String(target) === '/ip4/10.0.0.5/tcp/4001') {
        // What libp2p's own dial throws when the Noise-verified remote peer id does not match the
        // /p2p/<peerId> component requested in the multiaddr.
        return Promise.reject(new Error('dial to self attempted or peer id mismatch'))
      }
      return Promise.resolve(undefined)
    })
    await expect(redialTrustedPeers(db, { dial, isConnected: () => false })).resolves.toEqual(
      expect.arrayContaining(['12D3KooWJXxQkvHsETESzA6zVZQnFBqcM9DhAezDumJ69iNLvzUu', '12D3KooWDYCvjdPsGec3uqwTjMP8b6GoB4CXgZxua9VZvQ1YR8vj'])
    )
    expect(dial).toHaveBeenCalledTimes(2)
    db.close()
  })
})
