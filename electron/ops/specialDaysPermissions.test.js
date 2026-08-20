// @vitest-environment node
//
// T40 slice 1 (docs/work/specs/2026-08-20-special-days-data-shape-design.md):
// "Permissions: staff can read/write, cannot delete/bulk_replace (IPC + WS
// paths)." Both electron/main.js's write/bulkReplace handlers (IPC) and
// electron/sync/syncServer.js's handleSubmitOp/handleBulkReplace (WS) route
// through the SAME authorize()/deriveWriteAction/deriveBulkReplaceAction —
// see syncServer.js's authorizeWs, which calls authorize() directly — so
// exercising authorize() with the derived actions covers both entry points
// structurally, mirroring electron/auth/authorize.test.js's own style.
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
  tmpFile = path.join(os.tmpdir(), `shoresh-special-days-permissions-${Date.now()}-${Math.random()}.sqlite`)
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

describe.each(['special_days', 'special_day_time_blocks', 'special_day_slots'])(
  'permissions for %s',
  (entity) => {
    it('staff can write an ordinary field', () => {
      const userId = insertUser({ role: 'staff' })
      const token = issueLocalToken(db, userId, 'device-1')
      const action = deriveWriteAction({ entity, field: 'name' })
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
