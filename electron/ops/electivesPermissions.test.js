// @vitest-environment node
//
// T41 slice 1 (docs/work/specs/2026-08-20-group-electives-design.md):
// "Permissions: staff r/w, admin-only delete/bulk_replace (IPC + WS)." Both
// electron/main.js's write/bulkReplace handlers (IPC) and
// electron/sync/syncServer.js's handleSubmitOp/handleBulkReplace (WS) route
// through the SAME authorize()/deriveWriteAction/deriveBulkReplaceAction —
// see syncServer.js's authorizeWs, which calls authorize() directly — so
// exercising authorize() with the derived actions covers both entry points
// structurally. Mirrors electron/ops/specialDaysPermissions.test.js.
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomBytes, randomUUID } from 'node:crypto'
import { openLocalDb } from '../db/localDb.js'
import { issueLocalToken, ensureHostSigningKey } from '../auth/localAuth.js'
import { authorize } from '../auth/authorize.js'
import { deriveWriteAction, deriveBulkReplaceAction } from '../auth/deriveWriteAction.js'
import { DELETE_FIELD } from './operations.js'

let tmpFile
let db

beforeEach(() => {
  tmpFile = path.join(os.tmpdir(), `shoresh-electives-permissions-${Date.now()}-${Math.random()}.sqlite`)
  db = openLocalDb(tmpFile)
  db.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run('camp-1', 'Camp One')
  db.prepare('UPDATE camps SET signing_secret = ? WHERE id = ?').run(randomBytes(32).toString('hex'), 'camp-1')
  db.prepare(
    `INSERT INTO devices (id, name, authorized_at, device_secret_identifier, pairing_status)
     VALUES (?, ?, ?, ?, 'authorized')`
  ).run('device-1', 'Test Device', new Date().toISOString(), randomBytes(32).toString('hex'))
  const hostKey = ensureHostSigningKey(db)
  db.prepare('UPDATE camps SET signing_public_key = ? WHERE id = ?').run(hostKey.public_key, 'camp-1')
})

afterEach(() => {
  db.close()
  if (tmpFile && fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile)
})

function insertUser({ id = randomUUID(), name = `User-${randomUUID()}`, role = 'staff' } = {}) {
  db.prepare(
    'INSERT INTO users (id, camp_id, name, pin_hash, pin_salt, role) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(id, 'camp-1', name, 'hash', 'salt', role)
  return id
}

describe.each(['elective_sets', 'elective_set_activities'])(
  'permissions for %s',
  (entity) => {
    it('staff can write an ordinary field', () => {
      const userId = insertUser({ role: 'staff' })
      const token = issueLocalToken(db, userId, 'device-1')
      const field = entity === 'elective_set_activities' ? 'activity_id' : 'name'
      const action = deriveWriteAction({ entity, field })
      expect(authorize({ db, token, action })).toEqual({ allowed: true, userId, deviceId: 'device-1', role: 'staff' })
    })

    it('staff can read', () => {
      const userId = insertUser({ role: 'staff' })
      const token = issueLocalToken(db, userId, 'device-1')
      expect(authorize({ db, token, action: `${entity}.read` })).toEqual({
        allowed: true, userId, deviceId: 'device-1', role: 'staff',
      })
    })

    it('staff CANNOT delete (DELETE_FIELD sentinel derives to <entity>.delete, admin-only)', () => {
      const userId = insertUser({ role: 'staff' })
      const token = issueLocalToken(db, userId, 'device-1')
      const action = deriveWriteAction({ entity, field: DELETE_FIELD })
      expect(action).toBe(`${entity}.delete`)
      expect(authorize({ db, token, action })).toEqual({ allowed: false, reason: 'forbidden' })
    })

    it('staff CANNOT bulk_replace', () => {
      const userId = insertUser({ role: 'staff' })
      const token = issueLocalToken(db, userId, 'device-1')
      const action = deriveBulkReplaceAction(entity)
      expect(action).toBe(`${entity}.bulk_replace`)
      expect(authorize({ db, token, action })).toEqual({ allowed: false, reason: 'forbidden' })
    })

    it('admin CAN delete and bulk_replace', () => {
      const userId = insertUser({ role: 'admin' })
      const token = issueLocalToken(db, userId, 'device-1')
      expect(authorize({ db, token, action: deriveWriteAction({ entity, field: DELETE_FIELD }) }).allowed).toBe(true)
      expect(authorize({ db, token, action: deriveBulkReplaceAction(entity) }).allowed).toBe(true)
    })
  }
)

describe('permissions for template_slots.elective_set_id (extends the existing entity, not a new one)', () => {
  it('staff can write elective_set_id like any other template_slots field', () => {
    const userId = insertUser({ role: 'staff' })
    const token = issueLocalToken(db, userId, 'device-1')
    const action = deriveWriteAction({ entity: 'template_slots', field: 'elective_set_id' })
    expect(authorize({ db, token, action })).toEqual({ allowed: true, userId, deviceId: 'device-1', role: 'staff' })
  })
})
