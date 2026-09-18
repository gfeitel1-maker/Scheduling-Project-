import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { initSchema } from '../../db/localDb.js'
import { recordLibp2pPeerId, bindOrVerifyPeerIdentity, createBoundPeerTrust } from './peerIdentity.js'

function freshDb() {
  const db = new Database(':memory:')
  initSchema(db)
  return db
}

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

describe('bindOrVerifyPeerIdentity', () => {
  it('first contact for a device with no bound peer id: binds and returns ok', () => {
    const db = freshDb()
    db.prepare("INSERT INTO devices (id, name) VALUES ('d1', 'Device 1')").run()
    const result = bindOrVerifyPeerIdentity(db, 'd1', 'peer-a')
    expect(result).toEqual({ ok: true, bound: 'first' })
    expect(db.prepare('SELECT libp2p_peer_id FROM devices WHERE id = ?').get('d1').libp2p_peer_id).toBe('peer-a')
  })

  it('reconnect with the same bound peer id: matches, ok, no error', () => {
    const db = freshDb()
    db.prepare("INSERT INTO devices (id, name, libp2p_peer_id) VALUES ('d1', 'Device 1', 'peer-a')").run()
    const result = bindOrVerifyPeerIdentity(db, 'd1', 'peer-a')
    expect(result).toEqual({ ok: true, bound: 'match' })
  })

  it('a different peer id than the one bound: rejected, devices row untouched', () => {
    const db = freshDb()
    db.prepare("INSERT INTO devices (id, name, libp2p_peer_id) VALUES ('d1', 'Device 1', 'peer-a')").run()
    const result = bindOrVerifyPeerIdentity(db, 'd1', 'peer-b')
    expect(result).toEqual({ ok: false, reason: 'peer_identity_mismatch' })
    expect(db.prepare('SELECT libp2p_peer_id FROM devices WHERE id = ?').get('d1').libp2p_peer_id).toBe('peer-a')
  })
})

// Red Hat finding, 2026-09-17. The ADR says a two-devices-one-peer-id collision is
// "correctly rejected", but the original implementation rejected it by throwing a raw
// SQLITE_CONSTRAINT out of an admission decision — which skips the caller's audit
// record and surfaces as an internal error rather than a denial. The realistic cause
// is not a keypair collision but one device_identity_key copied to a second machine.
describe('bindOrVerifyPeerIdentity — a peer id already claimed by another device', () => {
  it('is refused as a decision, not raised as a raw db error', () => {
    const db = freshDb()
    db.prepare("INSERT INTO devices (id, name) VALUES ('device-a', 'A')").run()
    db.prepare("INSERT INTO devices (id, name) VALUES ('device-b', 'B')").run()

    expect(bindOrVerifyPeerIdentity(db, 'device-a', 'peer-shared')).toEqual({ ok: true, bound: 'first' })

    // device-b presents the SAME peer id — the v57 partial unique index forbids it.
    const result = bindOrVerifyPeerIdentity(db, 'device-b', 'peer-shared')
    expect(result).toEqual({ ok: false, reason: 'peer_identity_mismatch' })

    // ...and device-b stays unbound, so the legitimate machine can still bind later.
    const row = db.prepare('SELECT libp2p_peer_id FROM devices WHERE id = ?').get('device-b')
    expect(row.libp2p_peer_id).toBe(null)
    db.close()
  })

  it('re-throws a non-constraint db fault instead of reporting it as a clean denial', () => {
    const exploding = {
      prepare: () => ({
        get: () => ({ libp2p_peer_id: null }),
        run: () => { const e = new Error('database is locked'); e.code = 'SQLITE_BUSY'; throw e },
      }),
    }
    expect(() => bindOrVerifyPeerIdentity(exploding, 'device-a', 'peer-x')).toThrow(/locked/)
  })
})

// T208: createBoundPeerTrust(db) is the real local-trust check that replaces
// syncNode.js's permissive lanTopologyTrust stub. It must return true only for
// a peer id bound to a devices row that is authorized and not revoked, and
// must query fresh every call (mutualAuth never caches the verdict).
describe('createBoundPeerTrust', () => {
  it('returns true for a peer id bound to an authorized, non-revoked device', () => {
    const db = freshDb()
    db.prepare(
      "INSERT INTO devices (id, name, libp2p_peer_id, authorized_at) VALUES ('d1', 'Device 1', 'peer-a', '2026-01-01')"
    ).run()
    const isTrusted = createBoundPeerTrust(db)
    expect(isTrusted('peer-a')).toBe(true)
  })

  it('returns false when the device is bound but never authorized', () => {
    const db = freshDb()
    db.prepare(
      "INSERT INTO devices (id, name, libp2p_peer_id) VALUES ('d1', 'Device 1', 'peer-a')"
    ).run()
    const isTrusted = createBoundPeerTrust(db)
    expect(isTrusted('peer-a')).toBe(false)
  })

  it('returns false when the device is bound and authorized but later revoked', () => {
    const db = freshDb()
    db.prepare(
      "INSERT INTO devices (id, name, libp2p_peer_id, authorized_at, revoked_at) VALUES ('d1', 'Device 1', 'peer-a', '2026-01-01', '2026-02-01')"
    ).run()
    const isTrusted = createBoundPeerTrust(db)
    expect(isTrusted('peer-a')).toBe(false)
  })

  it('returns false for an unknown peer id', () => {
    const db = freshDb()
    db.prepare(
      "INSERT INTO devices (id, name, libp2p_peer_id, authorized_at) VALUES ('d1', 'Device 1', 'peer-a', '2026-01-01')"
    ).run()
    const isTrusted = createBoundPeerTrust(db)
    expect(isTrusted('peer-unknown')).toBe(false)
  })

  it('returns false for an empty or non-string peer id, without querying', () => {
    const db = freshDb()
    const isTrusted = createBoundPeerTrust(db)
    expect(isTrusted('')).toBe(false)
    expect(isTrusted(null)).toBe(false)
    expect(isTrusted(undefined)).toBe(false)
    expect(isTrusted(42)).toBe(false)
  })

  it('re-queries the db on every call, so a revocation between two calls takes effect immediately', () => {
    const db = freshDb()
    db.prepare(
      "INSERT INTO devices (id, name, libp2p_peer_id, authorized_at) VALUES ('d1', 'Device 1', 'peer-a', '2026-01-01')"
    ).run()
    const isTrusted = createBoundPeerTrust(db)
    expect(isTrusted('peer-a')).toBe(true)

    db.prepare("UPDATE devices SET revoked_at = '2026-03-01' WHERE id = 'd1'").run()
    expect(isTrusted('peer-a')).toBe(false)
  })
})
