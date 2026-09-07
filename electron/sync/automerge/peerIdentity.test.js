import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { initSchema } from '../../db/localDb.js'
import { recordLibp2pPeerId } from './peerIdentity.js'

describe('recordLibp2pPeerId', () => {
  let db

  beforeEach(() => {
    db = new Database(':memory:')
    initSchema(db)
    db.prepare("INSERT INTO devices (id, name) VALUES ('d1', 'Device 1')").run()
    db.prepare("INSERT INTO devices (id, name) VALUES ('d2', 'Device 2')").run()
  })

  it('writes the PeerId on the given device', () => {
    recordLibp2pPeerId(db, 'd1', 'peer-a')
    expect(db.prepare('SELECT libp2p_peer_id FROM devices WHERE id = ?').get('d1').libp2p_peer_id).toBe('peer-a')
  })

  it('overwrites with a new PeerId when the same device reconnects under a different identity', () => {
    recordLibp2pPeerId(db, 'd1', 'peer-a')
    recordLibp2pPeerId(db, 'd1', 'peer-b')
    expect(db.prepare('SELECT libp2p_peer_id FROM devices WHERE id = ?').get('d1').libp2p_peer_id).toBe('peer-b')
  })

  it('clears a stale claim from another device and lets the new claimant win, without throwing', () => {
    recordLibp2pPeerId(db, 'd1', 'peer-a')
    expect(() => recordLibp2pPeerId(db, 'd2', 'peer-a')).not.toThrow()
    expect(db.prepare('SELECT libp2p_peer_id FROM devices WHERE id = ?').get('d1').libp2p_peer_id).toBeNull()
    expect(db.prepare('SELECT libp2p_peer_id FROM devices WHERE id = ?').get('d2').libp2p_peer_id).toBe('peer-a')
  })

  it('is a no-op for a missing deviceId or peerId', () => {
    expect(() => recordLibp2pPeerId(db, null, 'peer-a')).not.toThrow()
    expect(() => recordLibp2pPeerId(db, 'd1', null)).not.toThrow()
    expect(db.prepare('SELECT libp2p_peer_id FROM devices WHERE id = ?').get('d1').libp2p_peer_id).toBeNull()
  })
})

// Red Hat, 5d-2b: the fallback used a bare `catch`, so ANY failure — a locked
// db, SQLITE_BUSY, disk-full — was treated as a stale-PeerId collision and
// would NULL some other device's routing column for an unrelated reason. Only
// a constraint violation may take that path; everything else must surface.
describe('recordLibp2pPeerId — only a UNIQUE collision triggers clear-and-retry', () => {
  it('re-throws a non-constraint db error instead of clearing another row', () => {
    const db = new Database(':memory:')
    initSchema(db)
    db.prepare("INSERT INTO devices (id, name) VALUES ('me', 'Me')").run()
    db.prepare("INSERT INTO devices (id, name) VALUES ('other', 'Other')").run()
    db.prepare("UPDATE devices SET libp2p_peer_id = 'peer-1' WHERE id = 'other'").run()

    const boom = Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' })
    const realPrepare = db.prepare.bind(db)
    db.prepare = (sql) => {
      if (sql.includes('SET libp2p_peer_id = ? WHERE id = ?')) {
        return { run: () => { throw boom } }
      }
      return realPrepare(sql)
    }

    expect(() => recordLibp2pPeerId(db, 'me', 'peer-1')).toThrow('database is locked')

    db.prepare = realPrepare
    // The other device's claim must be untouched — the bug was nulling it here.
    expect(db.prepare("SELECT libp2p_peer_id AS p FROM devices WHERE id = 'other'").get().p).toBe('peer-1')
  })
})
