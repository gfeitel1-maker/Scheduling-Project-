// @vitest-environment node
//
// T351 — the setup-device-only (`mode === 'client'`) refusals on import, undo, import-match
// confirm, split-decline, deny-device and the two reconciliation-decision handlers are lifted:
// the rule is now the role permission plus a trusted, non-revoked device, on ANY device.
// Real handlers, real authorize(); nothing is mocked but electron.
//
// Staff already hold groups.import and declined_two_row_splits.record (ADR 2026-08-28 Decision 2a),
// and the users table admits only 'admin' and 'staff', so no role lacks those two permissions:
// for gates 1, 2 and 4 the second test pins the UNCHANGED matrix (staff allowed) instead.
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'
import os from 'node:os'
import { randomUUID } from 'node:crypto'

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => os.tmpdir()), whenReady: vi.fn(() => Promise.resolve()), on: vi.fn() },
  BrowserWindow: vi.fn(),
  ipcMain: { handle: vi.fn() },
  contextBridge: { exposeInMainWorld: vi.fn() },
  ipcRenderer: { invoke: vi.fn(), on: vi.fn() },
}))

import { openTemplatedDb, cleanupTemplatedDbs } from './db/testDbTemplate.js'
import { getOrCreateDeviceId } from './db/localDb.js'
import { createUser, ensureHostSigningKey } from './auth/localAuth.js'
import { makeHandlers } from './main.js'

let db, deviceId, campId

function localTestWrite() {
  return async (args) => {
    const { appendOp } = await import('./ops/operations.js')
    return { status: 'applied', op: appendOp(db, { ...args, author_user_id: null, device_id: deviceId, parent_op_id: null }) }
  }
}

async function clientSession(role) {
  const name = `T351-${role}`
  await createUser(db, { camp_id: campId, name, pin: '246810', role }, localTestWrite())
  db.prepare("UPDATE devices SET authorized_at = ?, pairing_status = 'authorized' WHERE id = ?")
    .run(new Date().toISOString(), deviceId)
  const handlers = makeHandlers(db, deviceId, { getAutomergeSyncNode: () => null })
  await handlers.chooseMode({ mode: 'client' })
  const { token } = await handlers.login({ name, pin: '246810' })
  expect(token).toEqual(expect.any(String))
  return { handlers, token }
}

function revokeThisDevice() {
  db.prepare('UPDATE devices SET revoked_at = ? WHERE id = ?').run(new Date().toISOString(), deviceId)
}

beforeEach(() => {
  db = openTemplatedDb().db
  deviceId = getOrCreateDeviceId(db)
  const hostKey = ensureHostSigningKey(db)
  campId = randomUUID()
  db.prepare('INSERT INTO camps (id, name, signing_secret, signing_public_key) VALUES (?, ?, ?, ?)').run(campId, 'T351 Camp', 'a'.repeat(64), hostKey.public_key)
  db.prepare("INSERT OR IGNORE INTO devices (id, name, pairing_status) VALUES (?, ?, 'pending')").run(deviceId, deviceId)
})
afterEach(() => { try { db.close() } catch { /* already closed */ } })
afterAll(() => { cleanupTemplatedDbs() })

const SETUP_COPY = /set up on/

// [name, role lacking the permission (null: none exists), call, assertion the call took effect]
const gates = [
  ['ingestCommit (add)', null,
    (h, t) => h.ingestCommit({ token: t, approved: { activities: ['Archery'] } }),
    () => expect(db.prepare('SELECT COUNT(*) c FROM activities').get().c).toBe(1)],
  ['ingestCommit (replace)', null,
    (h, t) => h.ingestCommit({ token: t, mode: 'replace', approved: { activities: ['Archery'] } }),
    () => expect(db.prepare('SELECT COUNT(*) c FROM activities').get().c).toBe(1)],
  ['ingestUndo', null,
    (h, t) => h.ingestUndo({ token: t, invertibleOps: [], createdEntityIds: [], client_write_id: randomUUID() }),
    () => {}],
  ['confirmAlias', 'staff',
    (h, t) => {
      const groupId = randomUUID()
      db.prepare('INSERT INTO groups (id, camp_id, name, availability) VALUES (?, ?, ?, ?)').run(groupId, campId, 'Bunk One', 'all')
      return h.confirmAlias({ token: t, entity_type: 'groups', source_label: 'Cabin 1', entity_id: groupId })
    },
    () => expect(db.prepare('SELECT COUNT(*) c FROM source_aliases').get().c).toBe(1)],
  ['recordDeclinedSplit', null,
    (h, t) => h.recordDeclinedSplit({ token: t, activityName: 'Swim' }),
    () => expect(db.prepare('SELECT COUNT(*) c FROM declined_two_row_splits').get().c).toBe(1)],
  ['denyDevice', 'staff',
    (h, t) => {
      db.prepare("INSERT INTO devices (id, name, pairing_status) VALUES (?, ?, 'pending')").run('deny-target', 'iPad')
      return h.denyDevice({ token: t, deviceId: 'deny-target' })
    },
    () => expect(db.prepare('SELECT pairing_status FROM devices WHERE id = ?').get('deny-target').pairing_status).toBe('denied')],
  ['listOpenReconciliationDecisions', 'staff',
    (h, t) => h.listOpenReconciliationDecisions({ token: t }),
    () => {}],
  ['dismissOpenReconciliationDecisions', 'staff',
    (h, t) => h.dismissOpenReconciliationDecisions({ token: t, ids: ['x'] }),
    () => {}],
]

describe.each(gates)('T351 gate: %s', (_name, lackingRole, call, tookEffect) => {
  it('an admin on a trusted client-mode device is allowed', async () => {
    const { handlers, token } = await clientSession('admin')
    await expect(Promise.resolve().then(() => call(handlers, token))).resolves.not.toThrow()
    tookEffect()
  })

  if (lackingRole) {
    it(`a ${lackingRole} on a client-mode device is still refused, by the permission`, async () => {
      const { handlers, token } = await clientSession(lackingRole)
      let err
      try { await call(handlers, token) } catch (e) { err = e }
      expect(err).toBeDefined()
      expect(err.message).toMatch(/admin role required|forbidden|not permitted/i)
      expect(err.message).not.toMatch(SETUP_COPY)
    })
  } else {
    it('staff keep the permission they already held, now on a client-mode device too', async () => {
      const { handlers, token } = await clientSession('staff')
      await expect(Promise.resolve().then(() => call(handlers, token))).resolves.not.toThrow()
    })
  }

  it('a revoked device is refused even with an admin role', async () => {
    const { handlers, token } = await clientSession('admin')
    revokeThisDevice()
    let err
    try { await call(handlers, token) } catch (e) { err = e }
    expect(err).toBeDefined()
    expect(err.message).toMatch(/invalid session|revoked/i)
    expect(err.message).not.toMatch(SETUP_COPY)
  })
})
