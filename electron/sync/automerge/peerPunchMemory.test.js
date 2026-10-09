// T348: the per-peer remembered punch session (peer_punch_memory), an extension of the
// peer_last_addresses mechanism - round-trip, trust filtering, and forgetting on revoke.
import Database from 'better-sqlite3'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { initSchema } from '../../db/localDb.js'
import { rememberPunchMemory, loadTrustedPunchMemory, forgetPeerAddress } from './peerAddressBook.js'

const files = []
afterEach(() => {
  for (const f of files.splice(0)) for (const s of ['', '-wal', '-shm']) if (fs.existsSync(f + s)) fs.unlinkSync(f + s)
})
function freshDb() {
  const file = path.join(os.tmpdir(), `shoresh-punch-mem-${Date.now()}-${Math.random()}.sqlite`)
  files.push(file)
  const db = new Database(file)
  db.pragma('foreign_keys = ON')
  initSchema(db)
  return db
}
const trust = (db, deviceId, peerId, revoked = false) =>
  db.prepare("INSERT INTO devices (id, name, pairing_status, authorized_at, revoked_at, libp2p_peer_id) VALUES (?, ?, 'approved', ?, ?, ?)")
    .run(deviceId, deviceId, '2026-10-01T00:00:00.000Z', revoked ? '2026-10-02T00:00:00.000Z' : null, peerId)

const SDP = 'v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\na=ice-ufrag:abcd\r\na=ice-pwd:' + 'x'.repeat(24) + '\r\na=fingerprint:sha-256 AA:BB:CC\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\na=setup:active\r\n'
const memory = {
  role: 'offerer',
  remoteSdpType: 'answer',
  remoteSdp: SDP,
  candidates: [{ candidate: 'candidate:1 1 UDP 2122317823 203.0.113.9 50001 typ srflx', mid: '0' }],
}

describe('peer punch memory', () => {
  it('round-trips role, sdp, fingerprint, ufrag/pwd and candidates', () => {
    const db = freshDb()
    trust(db, 'd1', 'peer-1')
    rememberPunchMemory(db, 'peer-1', memory, () => '2026-10-08T00:00:00.000Z')
    expect(loadTrustedPunchMemory(db, 'peer-1')).toEqual({
      peerId: 'peer-1',
      ...memory,
      remoteFingerprint: 'AA:BB:CC',
      remoteUfrag: 'abcd',
      remotePwd: 'x'.repeat(24),
      lastSeenAt: '2026-10-08T00:00:00.000Z',
    })
  })

  it('returns null for a peer with no memory', () => {
    const db = freshDb()
    trust(db, 'd1', 'peer-1')
    expect(loadTrustedPunchMemory(db, 'peer-1')).toBeNull()
  })

  it('does not return the memory of a revoked peer, and does not return another peer\'s', () => {
    const db = freshDb()
    trust(db, 'd1', 'peer-1', true)
    trust(db, 'd2', 'peer-2')
    rememberPunchMemory(db, 'peer-1', memory)
    expect(loadTrustedPunchMemory(db, 'peer-1')).toBeNull()
    expect(loadTrustedPunchMemory(db, 'peer-2')).toBeNull()
  })

  it('forgetPeerAddress deletes the punch memory with the addresses', () => {
    const db = freshDb()
    trust(db, 'd1', 'peer-1')
    rememberPunchMemory(db, 'peer-1', memory)
    forgetPeerAddress(db, 'peer-1')
    expect(db.prepare('SELECT COUNT(*) c FROM peer_punch_memory').get().c).toBe(0)
  })

  it('refuses to store a description with no fingerprint or ICE credentials', () => {
    const db = freshDb()
    rememberPunchMemory(db, 'peer-1', { ...memory, remoteSdp: 'v=0\r\n' })
    expect(db.prepare('SELECT COUNT(*) c FROM peer_punch_memory').get().c).toBe(0)
  })
})
