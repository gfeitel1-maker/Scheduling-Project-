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
