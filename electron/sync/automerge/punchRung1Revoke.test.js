// @vitest-environment node
//
// T348 Rung 1: trust is re-checked AFTER the upgrade. A peer revoked while the dial was in flight
// must have its connection closed and be reported as 'revoked', never returned as ok.
import Database from 'better-sqlite3'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { initSchema } from '../../db/localDb.js'
import { rememberPunchMemory } from './peerAddressBook.js'
import { attemptRung1 } from './punchRung1.js'

const files = []
afterEach(() => {
  for (const f of files.splice(0)) for (const s of ['', '-wal', '-shm']) if (fs.existsSync(f + s)) fs.unlinkSync(f + s)
})
function freshDb() {
  const file = path.join(os.tmpdir(), `shoresh-rung1-revoke-${Date.now()}-${Math.random()}.sqlite`)
  files.push(file)
  const db = new Database(file)
  initSchema(db)
  return db
}
const SDP = 'v=0\r\ns=-\r\nt=0 0\r\na=ice-ufrag:abcd\r\na=ice-pwd:' + 'x'.repeat(24) + '\r\na=fingerprint:sha-256 AA:BB:CC\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n'
const SRFLX = { candidate: 'candidate:1 1 UDP 1686052607 203.0.113.9 50001 typ srflx', mid: '0' }

function setup() {
  const db = freshDb()
  db.prepare("INSERT INTO devices (id, name, pairing_status, authorized_at, libp2p_peer_id) VALUES ('d1', 'd1', 'approved', '2026-10-01T00:00:00.000Z', 'peer-1')").run()
  rememberPunchMemory(db, 'peer-1', { role: 'offerer', remoteSdpType: 'answer', remoteSdp: SDP, candidates: [SRFLX] })
  const closed = []
  const connection = { remotePeer: { toString: () => 'peer-1' }, close: async () => { closed.push(true) } }
  return { db, closed, connection }
}

describe('attemptRung1 - trust re-check after the upgrade', () => {
  it('a peer revoked mid-dial: connection closed, ok:false, reason revoked', async () => {
    const { db, closed, connection } = setup()
    const transport = {
      connectFromMemory: async () => {
        db.prepare("UPDATE devices SET revoked_at = '2026-10-09T00:00:00.000Z' WHERE id = 'd1'").run()
        return connection
      },
    }
    const r = await attemptRung1({ peerId: 'peer-1' }, { db, transport, upgrader: {} })
    expect(r).toEqual({ ok: false, reason: 'revoked' })
    expect(closed).toHaveLength(1)
  })

  it('isPeerRevoked (authority cache) is consulted after the upgrade too', async () => {
    const { db, closed, connection } = setup()
    let revoked = false
    const transport = { connectFromMemory: async () => { revoked = true; return connection } }
    const r = await attemptRung1({ peerId: 'peer-1' }, { db, transport, upgrader: {}, isPeerRevoked: () => revoked })
    expect(r).toEqual({ ok: false, reason: 'revoked' })
    expect(closed).toHaveLength(1)
  })

  it('non-vacuity: a still-trusted peer is returned ok and left open', async () => {
    const { db, closed, connection } = setup()
    const r = await attemptRung1({ peerId: 'peer-1' }, { db, transport: { connectFromMemory: async () => connection }, upgrader: {}, isPeerRevoked: () => false })
    expect(r.ok).toBe(true)
    expect(closed).toHaveLength(0)
  })
})
