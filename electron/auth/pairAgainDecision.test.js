// Pair again (a device that was offline through a revoke re-pairs on the camp's network): the
// Host-side admission decision. A re-pair must go through a director's approval like any join,
// must be refused outright for a device that was explicitly revoked, and must be refused for a
// device this camp has never admitted (which is also what a different camp's code produces).
import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest'
import fs from 'node:fs'
import { randomBytes } from 'node:crypto'
import { openTemplatedDb, cleanupTemplatedDbs } from '../db/testDbTemplate.js'
import { evaluatePairingRequest } from './connectionAuth.js'

afterAll(() => cleanupTemplatedDbs())
let db, tmpFile
beforeEach(() => {
  ;({ db, file: tmpFile } = openTemplatedDb())
  db.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run('camp-a', 'Camp A')
})
afterEach(() => { db.close(); fs.unlinkSync(tmpFile) })

function authorized(id) {
  db.prepare("INSERT INTO devices (id, name, authorized_at, device_secret_identifier, pairing_status) VALUES (?, 'Laptop B', ?, ?, 'authorized')")
    .run(id, new Date().toISOString(), randomBytes(32).toString('hex'))
}
const audit = (id) => db.prepare('SELECT action FROM audit_events WHERE device_id = ?').all(id).map((r) => r.action)

describe('evaluatePairingRequest: pair again', () => {
  it('an authorized device re-pairing is NOT auto-approved: it waits for a director, recorded as a re-pair', () => {
    authorized('dev-b')
    const r = evaluatePairingRequest(db, { device_id: 'dev-b', device_name: 'Laptop B', rejoin: true })
    expect(r).toEqual({ ok: true, alreadyApproved: false })
    expect(db.prepare('SELECT pairing_status FROM devices WHERE id = ?').get('dev-b').pairing_status).toBe('rejoin_pending')
    expect(audit('dev-b')).toContain('device.rejoin_request')
  })

  it('a device this camp never admitted is refused (a different camp\'s code lands here)', () => {
    expect(evaluatePairingRequest(db, { device_id: 'stranger', device_name: 'X', rejoin: true }))
      .toEqual({ ok: false, reason: 'not_a_member' })
    expect(db.prepare('SELECT id FROM devices WHERE id = ?').get('stranger')).toBeUndefined()
  })

  it('the same camp, but a device that never approved this one: "not known here" (R3)', () => {
    expect(evaluatePairingRequest(db, { device_id: 'stranger', device_name: 'X', rejoin: true, sameCamp: true }))
      .toEqual({ ok: false, reason: 'not_known_here' })
  })

  it('a schema gap is refused before a director is asked, and nothing is marked pending (R4c)', () => {
    authorized('dev-b')
    expect(evaluatePairingRequest(db, { device_id: 'dev-b', device_name: 'Laptop B', rejoin: true, schemaCompatible: false }))
      .toEqual({ ok: false, reason: 'schema_mismatch' })
    expect(db.prepare('SELECT pairing_status FROM devices WHERE id = ?').get('dev-b').pairing_status).toBe('authorized')
  })

  it('a device revoked on this Host is refused, re-pair or fresh join', () => {
    authorized('dev-c')
    db.prepare('UPDATE devices SET revoked_at = ? WHERE id = ?').run(new Date().toISOString(), 'dev-c')
    for (const rejoin of [true, false]) {
      expect(evaluatePairingRequest(db, { device_id: 'dev-c', device_name: 'C', rejoin }))
        .toEqual({ ok: false, reason: 'device_revoked' })
    }
  })

  it('a device the distributed authority log revoked is refused even with no local revoked_at', () => {
    authorized('dev-c')
    db.prepare("INSERT INTO authority_cache (device_id, status, updated_at) VALUES ('dev-c', 'revoked', ?)").run(new Date().toISOString())
    expect(evaluatePairingRequest(db, { device_id: 'dev-c', device_name: 'C', rejoin: true }))
      .toEqual({ ok: false, reason: 'device_revoked' })
  })

  it('a fresh join is unchanged: a known authorized device still gets its idempotent re-delivery', () => {
    authorized('dev-b')
    expect(evaluatePairingRequest(db, { device_id: 'dev-b', device_name: 'Laptop B' }).alreadyApproved).toBe(true)
  })
})
