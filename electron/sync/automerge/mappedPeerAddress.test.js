// @vitest-environment node
//
// T359 slice 2: a peer's verified router-mapped TCP address is remembered in peer_last_addresses,
// public-filtered at the write, at most one per peer, never pushed out by LAN rows.
import Database from 'better-sqlite3'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { initSchema } from '../../db/localDb.js'
import {
  rememberPeerAddress, rememberMappedPeerAddress, loadMappedPeerAddress, forgetPeerAddress,
  PEER_LAST_ADDRESSES_MAX_PER_PEER, MAPPED_ADDRESS_MAX_AGE_MS,
} from './peerAddressBook.js'

const files = []
afterEach(() => {
  for (const f of files.splice(0)) for (const s of ['', '-wal', '-shm']) if (fs.existsSync(f + s)) fs.unlinkSync(f + s)
})
function freshDb() {
  const file = path.join(os.tmpdir(), `shoresh-mapped-${Date.now()}-${Math.random()}.sqlite`)
  files.push(file)
  const db = new Database(file)
  initSchema(db)
  db.prepare("INSERT INTO devices (id, name, pairing_status, authorized_at, libp2p_peer_id) VALUES ('d1', 'd1', 'approved', '2026-10-01T00:00:00.000Z', 'peer-1')").run()
  return db
}
const rows = (db) => db.prepare('SELECT multiaddr FROM peer_last_addresses WHERE peer_id = ? ORDER BY multiaddr').all('peer-1').map((r) => r.multiaddr)
const NOW = Date.parse('2026-10-09T12:00:00.000Z')
const MAPPED = '/ip4/34.120.1.7/tcp/50000/p2p/peer-1'

describe('rememberMappedPeerAddress - public filter at the write', () => {
  it.each([
    ['private 10/8', '/ip4/10.0.0.5/tcp/50000/p2p/peer-1'],
    ['private 192.168/16', '/ip4/192.168.1.20/tcp/50000/p2p/peer-1'],
    ['loopback', '/ip4/127.0.0.1/tcp/50000/p2p/peer-1'],
    ['CGNAT 100.64/10', '/ip4/100.64.1.2/tcp/50000/p2p/peer-1'],
    ['link-local', '/ip4/169.254.3.4/tcp/50000/p2p/peer-1'],
    ['IPv4-mapped IPv6', '/ip6/::ffff:34.120.1.7/tcp/50000/p2p/peer-1'],
    ['IPv6 loopback', '/ip6/::1/tcp/50000/p2p/peer-1'],
    ['udp not tcp', '/ip4/34.120.1.7/udp/50000/p2p/peer-1'],
    ['no peer id', '/ip4/34.120.1.7/tcp/50000'],
    ['wrong peer id', '/ip4/34.120.1.7/tcp/50000/p2p/peer-2'],
    ['port 0', '/ip4/34.120.1.7/tcp/0/p2p/peer-1'],
  ])('REJECTS %s', (_n, ma) => {
    const db = freshDb()
    expect(rememberMappedPeerAddress(db, 'peer-1', ma, { observedAtMs: NOW })).toBe(false)
    expect(rows(db)).toEqual([])
  })

  it('accepts a public address', () => {
    const db = freshDb()
    expect(rememberMappedPeerAddress(db, 'peer-1', MAPPED, { observedAtMs: NOW })).toBe(true)
    expect(rows(db)).toEqual([MAPPED])
  })
})

describe('one mapped row per peer', () => {
  it('a newer verified entry replaces it; an older or equal one does not', () => {
    const db = freshDb()
    rememberMappedPeerAddress(db, 'peer-1', MAPPED, { observedAtMs: NOW })
    const moved = '/ip4/34.120.1.7/tcp/50001/p2p/peer-1'
    expect(rememberMappedPeerAddress(db, 'peer-1', moved, { observedAtMs: NOW - 1000 })).toBe(false)
    expect(rememberMappedPeerAddress(db, 'peer-1', moved, { observedAtMs: NOW })).toBe(false)
    expect(rows(db)).toEqual([MAPPED])
    expect(rememberMappedPeerAddress(db, 'peer-1', moved, { observedAtMs: NOW + 1000 })).toBe(true)
    expect(rows(db)).toEqual([moved])
  })

  it('a peer republishing many different ports leaves exactly one row, and rejected junk never evicts the good row', () => {
    const db = freshDb()
    rememberMappedPeerAddress(db, 'peer-1', MAPPED, { observedAtMs: NOW })
    for (let p = 1; p <= 20; p++) rememberMappedPeerAddress(db, 'peer-1', `/ip4/10.0.0.1/tcp/${p}/p2p/peer-1`, { observedAtMs: NOW + p })
    expect(rows(db)).toEqual([MAPPED])
    for (let p = 1; p <= 20; p++) rememberMappedPeerAddress(db, 'peer-1', `/ip4/34.120.1.7/tcp/${51000 + p}/p2p/peer-1`, { observedAtMs: NOW + 1000 + p })
    expect(rows(db)).toHaveLength(1)
  })

  it('LAN rows never push the mapped row out of the prune', () => {
    const db = freshDb()
    rememberMappedPeerAddress(db, 'peer-1', MAPPED, { observedAtMs: NOW - 5 * 24 * 3600e3 })
    for (let i = 0; i < PEER_LAST_ADDRESSES_MAX_PER_PEER + 3; i++) {
      rememberPeerAddress(db, 'peer-1', `/ip4/192.168.1.${10 + i}/tcp/4001/p2p/peer-1`, () => new Date(NOW + i * 1000).toISOString())
    }
    const all = rows(db)
    expect(all).toContain(MAPPED)
    expect(all.filter((m) => m !== MAPPED)).toHaveLength(PEER_LAST_ADDRESSES_MAX_PER_PEER)
  })

  it('an observed public TCP address (ephemeral inbound port) cannot displace the mapped row', () => {
    const db = freshDb()
    rememberMappedPeerAddress(db, 'peer-1', MAPPED, { observedAtMs: NOW })
    rememberPeerAddress(db, 'peer-1', '/ip4/34.120.1.7/tcp/61234/p2p/peer-1', () => new Date(NOW + 5000).toISOString())
    expect(rows(db)).toEqual([MAPPED])
  })

  it('forgetPeerAddress (revoke) removes the mapped row', () => {
    const db = freshDb()
    rememberMappedPeerAddress(db, 'peer-1', MAPPED, { observedAtMs: NOW })
    forgetPeerAddress(db, 'peer-1')
    expect(rows(db)).toEqual([])
  })
})

describe('loadMappedPeerAddress', () => {
  it('returns the row for a trusted peer inside 7 days, null past it', () => {
    const db = freshDb()
    rememberMappedPeerAddress(db, 'peer-1', MAPPED, { observedAtMs: NOW })
    expect(loadMappedPeerAddress(db, 'peer-1', { now: () => NOW + MAPPED_ADDRESS_MAX_AGE_MS - 1 })).toBe(MAPPED)
    expect(loadMappedPeerAddress(db, 'peer-1', { now: () => NOW + MAPPED_ADDRESS_MAX_AGE_MS + 1 })).toBeNull()
  })

  it('returns null for a revoked peer and ignores LAN rows', () => {
    const db = freshDb()
    rememberPeerAddress(db, 'peer-1', '/ip4/192.168.1.2/tcp/4001/p2p/peer-1')
    expect(loadMappedPeerAddress(db, 'peer-1', { now: () => NOW })).toBeNull()
    rememberMappedPeerAddress(db, 'peer-1', MAPPED, { observedAtMs: NOW })
    db.prepare("UPDATE devices SET revoked_at = '2026-10-09T00:00:00.000Z' WHERE id = 'd1'").run()
    expect(loadMappedPeerAddress(db, 'peer-1', { now: () => NOW })).toBeNull()
  })
})
