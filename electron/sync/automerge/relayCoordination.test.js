// T337 (docs/work/specs/2026-10-03-t337-coordination-layer-design.md §A step 1): candidate-R
// selection for the coordination relay. Unit coverage for selectCoordinationCandidates
// (peerAddressBook.js) — capped, ranked by last_seen_at, trust-rechecked, excludes the dial
// target itself. Mirrors peerAddressBook.test.js's own fixture pattern.
import Database from 'better-sqlite3'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { initSchema } from '../../db/localDb.js'
import { rememberPeerAddress, selectCoordinationCandidates, PEER_LAST_ADDRESSES_MAX_PER_PEER } from './peerAddressBook.js'

const files = []

afterEach(() => {
  for (const f of files.splice(0)) {
    for (const suffix of ['', '-wal', '-shm']) {
      if (fs.existsSync(f + suffix)) fs.unlinkSync(f + suffix)
    }
  }
})

function freshDb() {
  const file = path.join(os.tmpdir(), `shoresh-relay-coord-${Date.now()}-${Math.random()}.sqlite`)
  files.push(file)
  const db = new Database(file)
  db.pragma('foreign_keys = ON')
  initSchema(db)
  return db
}

function seedTrustedDevice(db, { deviceId, peerId, revoked = false }) {
  db.prepare(
    "INSERT INTO devices (id, name, pairing_status, authorized_at, revoked_at, libp2p_peer_id) VALUES (?, ?, 'approved', ?, ?, ?)"
  ).run(deviceId, deviceId, '2026-10-01T00:00:00.000Z', revoked ? '2026-10-02T00:00:00.000Z' : null, peerId)
}

describe('selectCoordinationCandidates', () => {
  it('returns other trusted camp peers, ranked most-recently-seen first', () => {
    const db = freshDb()
    seedTrustedDevice(db, { deviceId: 'dev-r1', peerId: 'peer-r1' })
    seedTrustedDevice(db, { deviceId: 'dev-r2', peerId: 'peer-r2' })
    rememberPeerAddress(db, 'peer-r1', '/ip4/10.0.0.1/tcp/4001/p2p/peer-r1', () => '2026-10-02T00:00:00.000Z')
    rememberPeerAddress(db, 'peer-r2', '/ip4/10.0.0.2/tcp/4001/p2p/peer-r2', () => '2026-10-02T00:05:00.000Z')

    const candidates = selectCoordinationCandidates(db, 'peer-c')
    expect(candidates.map((c) => c.peerId)).toEqual(['peer-r2', 'peer-r1'])
    db.close()
  })

  it('excludes the dial target itself even if it has a remembered address', () => {
    const db = freshDb()
    seedTrustedDevice(db, { deviceId: 'dev-c', peerId: 'peer-c' })
    rememberPeerAddress(db, 'peer-c', '/ip4/10.0.0.9/tcp/4001/p2p/peer-c', () => '2026-10-02T00:00:00.000Z')

    expect(selectCoordinationCandidates(db, 'peer-c')).toEqual([])
    db.close()
  })

  it('excludes a revoked/untrusted candidate (re-checked at selection time, not from a stale snapshot)', () => {
    const db = freshDb()
    seedTrustedDevice(db, { deviceId: 'dev-r1', peerId: 'peer-r1', revoked: true })
    rememberPeerAddress(db, 'peer-r1', '/ip4/10.0.0.1/tcp/4001/p2p/peer-r1', () => '2026-10-02T00:00:00.000Z')

    expect(selectCoordinationCandidates(db, 'peer-c')).toEqual([])
    db.close()
  })

  // Non-vacuity: a hand-rolled "always trust" stub would pass the two tests above even with a
  // broken trust re-check, so prove the real default (createBoundPeerTrust) is actually wired by
  // overriding it explicitly and observing the result change.
  it('honors an injected isPeerTrusted override (proves the real check is not hardcoded true)', () => {
    const db = freshDb()
    seedTrustedDevice(db, { deviceId: 'dev-r1', peerId: 'peer-r1' })
    rememberPeerAddress(db, 'peer-r1', '/ip4/10.0.0.1/tcp/4001/p2p/peer-r1', () => '2026-10-02T00:00:00.000Z')

    expect(selectCoordinationCandidates(db, 'peer-c', { isPeerTrusted: () => false })).toEqual([])
    expect(selectCoordinationCandidates(db, 'peer-c', { isPeerTrusted: () => true })).toHaveLength(1)
    db.close()
  })

  it('caps candidates per attempt (mirrors PEER_LAST_ADDRESSES_MAX_PER_PEER) — no reconnect-storm fan-out', () => {
    const db = freshDb()
    const total = PEER_LAST_ADDRESSES_MAX_PER_PEER + 4
    for (let i = 0; i < total; i++) {
      seedTrustedDevice(db, { deviceId: `dev-r${i}`, peerId: `peer-r${i}` })
      rememberPeerAddress(db, `peer-r${i}`, `/ip4/10.0.0.${i}/tcp/4001/p2p/peer-r${i}`, () => `2026-10-02T00:${String(i).padStart(2, '0')}:00.000Z`)
    }

    const candidates = selectCoordinationCandidates(db, 'peer-c')
    expect(candidates.length).toBe(PEER_LAST_ADDRESSES_MAX_PER_PEER)
    // Capped to the MOST recently seen, not an arbitrary subset.
    expect(candidates[0].peerId).toBe(`peer-r${total - 1}`)
    db.close()
  })

  it('returns one row per candidate peer, not one per remembered address', () => {
    const db = freshDb()
    seedTrustedDevice(db, { deviceId: 'dev-r1', peerId: 'peer-r1' })
    rememberPeerAddress(db, 'peer-r1', '/ip4/10.0.0.1/tcp/4001/p2p/peer-r1', () => '2026-10-02T00:00:00.000Z')
    rememberPeerAddress(db, 'peer-r1', '/ip4/192.168.1.1/tcp/4001/p2p/peer-r1', () => '2026-10-02T00:05:00.000Z')

    const candidates = selectCoordinationCandidates(db, 'peer-c')
    expect(candidates).toHaveLength(1)
    expect(candidates[0].multiaddr).toBe('/ip4/192.168.1.1/tcp/4001/p2p/peer-r1')
    db.close()
  })
})
