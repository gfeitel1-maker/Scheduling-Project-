// @vitest-environment node
// The IPC-facing handlers behind authorize() (docs/adr/2026-10-11-import-answer-memory.md 3.3, test plan 14).
import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest'
import fs from 'node:fs'
import { randomBytes } from 'node:crypto'
import { openTemplatedDb, cleanupTemplatedDbs } from '../db/testDbTemplate.js'
import { issueLocalToken, ensureHostSigningKey } from '../auth/localAuth.js'
import { authorize } from '../auth/authorize.js'
import { PERMISSIONS } from '../auth/permissions.js'
import { createAnswerMemoryHandlers } from './answerMemoryHandlers.js'

afterAll(() => cleanupTemplatedDbs())

let db, file, handlers, tokens
beforeEach(() => {
  const t = openTemplatedDb()
  db = t.db
  file = t.file
  db.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run('camp-1', 'Camp One')
  db.prepare('UPDATE camps SET signing_secret = ? WHERE id = ?').run(randomBytes(32).toString('hex'), 'camp-1')
  db.prepare("INSERT INTO devices (id, name, authorized_at, device_secret_identifier, pairing_status) VALUES ('device-1', 'Laptop', ?, ?, 'authorized')").run(new Date().toISOString(), randomBytes(16).toString('hex'))
  const key = ensureHostSigningKey(db)
  db.prepare('UPDATE camps SET signing_public_key = ? WHERE id = ?').run(key.public_key, 'camp-1')
  tokens = {}
  for (const [id, role] of [['u-admin', 'admin'], ['u-staff', 'staff']]) {
    db.prepare('INSERT INTO users (id, camp_id, name, pin_hash, pin_salt, role) VALUES (?, ?, ?, ?, ?, ?)').run(id, 'camp-1', id, 'h', 's', role)
    tokens[role] = issueLocalToken(db, id, 'device-1')
  }
  handlers = createAnswerMemoryHandlers({
    db, deviceId: 'device-1',
    authorize: (token, action) => {
      const r = authorize({ db, token, action })
      if (!r.allowed) throw new Error(r.reason === 'forbidden' ? 'admin role required' : 'invalid session')
      return r
    },
  })
})
afterEach(() => {
  db.close()
  if (file && fs.existsSync(file)) fs.unlinkSync(file)
})

const decision = { id: 'fe:Lunch 1', kind: 'confirm_value', entity: 'fixed_events', entityName: 'Lunch 1', timeBlock: '12:00-12:40', days: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'], evidence: { basis: 'daily' } }

describe('permissions', () => {
  it('adds import_answers.read and .write for the roles that import; camp_seedlings.write stays admin-only', () => {
    expect(PERMISSIONS.staff).toEqual(expect.arrayContaining(['import_answers.read', 'import_answers.write', 'groups.import']))
    expect(PERMISSIONS.staff).not.toContain('camp_seedlings.write')
    expect(authorize({ db, token: tokens.staff, action: 'import_answers.write' }).allowed).toBe(true)
    expect(authorize({ db, token: tokens.staff, action: 'import_answers.read' }).allowed).toBe(true)
    expect(authorize({ db, token: tokens.staff, action: 'camp_seedlings.write' })).toEqual({ allowed: false, reason: 'forbidden' })
    expect(authorize({ db, token: tokens.admin, action: 'import_answers.write' }).allowed).toBe(true)
  })
})

describe('handlers', () => {
  it('staff with groups.import writes, recalls, lists, changes and forgets', () => {
    const w = handlers.rememberImportAnswers({ token: tokens.staff, importId: 'i1', entries: [{ decision, answer: { action: 'edited' } }] })
    expect(w.written).toHaveLength(1)
    const m = handlers.matchImportAnswers({ token: tokens.staff, decisions: [decision] })
    expect(m[decision.id]).toMatchObject({ match: 'exact', answeredByName: 'u-staff' })
    const view = handlers.listLearned({ token: tokens.staff })
    expect(view.answers).toHaveLength(1)
    expect(view.canWrite).toBe(true)
    const id = view.answers[0].id
    expect(handlers.changeImportAnswer({ token: tokens.staff, memoryId: id, verdict: 'accept' }).ok).toBe(true)
    const id2 = handlers.listLearned({ token: tokens.staff }).answers[0].id
    expect(handlers.forgetImportAnswer({ token: tokens.staff, memoryId: id2 }).ok).toBe(true)
    expect(handlers.listLearned({ token: tokens.staff }).answers).toHaveLength(0)
  })

  it('refuses a missing or invalid token on every handler', () => {
    for (const name of ['matchImportAnswers', 'rememberImportAnswers', 'listLearned', 'changeImportAnswer', 'forgetImportAnswer', 'forgetImportPattern', 'keepImportAnswer']) {
      expect(() => handlers[name]({})).toThrow()
      expect(() => handlers[name]({ token: 'nope' })).toThrow()
    }
  })

  it('ignores a camp_id or kind in the payload: only the two allow-listed kinds, in this camp', () => {
    handlers.rememberImportAnswers({ token: tokens.staff, camp_id: 'other', kind: 'preference_column_roles', entries: [{ decision, answer: { action: 'edited' }, camp_id: 'other', kind: 'preference_column_roles' }] })
    const rows = db.prepare('SELECT camp_id, kind FROM camp_seedlings').all()
    expect(rows).toEqual([{ camp_id: 'camp-1', kind: 'import_answer' }])
  })

  it('rejects oversize arrays and malformed arguments', () => {
    expect(() => handlers.rememberImportAnswers({ token: tokens.staff, entries: 'x' })).toThrow()
    expect(() => handlers.matchImportAnswers({ token: tokens.staff, decisions: new Array(5001).fill({}) })).toThrow()
    expect(() => handlers.changeImportAnswer({ token: tokens.staff, memoryId: 5, verdict: 'accept' })).toThrow()
  })
})
