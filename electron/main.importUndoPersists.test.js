// @vitest-environment node
//
// Director test 2026-10-12 (blocker): undo of an import vanished after "a few minutes" and was gone after
// a restart, with no word that it had expired. The last import's undo now persists on this device (in the
// encrypted db) until the NEXT import replaces it, survives a restart, and Roots can name it.
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
import { openLocalDb, getOrCreateDeviceId } from './db/localDb.js'
import { createUser, ensureHostSigningKey } from './auth/localAuth.js'
import { appendOp } from './ops/operations.js'
import { makeHandlers } from './main.js'

let db, file, deviceId, campId, handlers, token

async function signIn() {
  handlers = makeHandlers(db, deviceId, { getAutomergeSyncNode: () => null })
  await handlers.chooseMode({ mode: 'client' })
  ;({ token } = await handlers.login({ name: 'Dir', pin: '246810' }))
}

beforeEach(async () => {
  ;({ db, file } = openTemplatedDb())
  deviceId = getOrCreateDeviceId(db)
  const hostKey = ensureHostSigningKey(db)
  campId = randomUUID()
  db.prepare('INSERT INTO camps (id, name, signing_secret, signing_public_key) VALUES (?, ?, ?, ?)').run(campId, 'Undo Camp', 'a'.repeat(64), hostKey.public_key)
  db.prepare("INSERT OR IGNORE INTO devices (id, name, pairing_status) VALUES (?, ?, 'pending')").run(deviceId, deviceId)
  const write = async (args) => ({ status: 'applied', op: appendOp(db, { ...args, author_user_id: null, device_id: deviceId, parent_op_id: null }) })
  await createUser(db, { camp_id: campId, name: 'Dir', pin: '246810', role: 'admin' }, write)
  db.prepare("UPDATE devices SET authorized_at = ?, pairing_status = 'authorized' WHERE id = ?").run(new Date().toISOString(), deviceId)
  await signIn()
})
afterEach(() => { try { db.close() } catch { /* already closed */ } })
afterAll(() => { cleanupTemplatedDbs() })

const has = (name) => !!db.prepare('SELECT 1 FROM activities WHERE name = ?').get(name)
const commit = (name, sourceFileName) => handlers.ingestCommit({ token, approved: { activities: [name] }, captureInverse: true, sourceFileName })
// A restart: the main process's in-memory record is keyed by the db handle, so a fresh handle has none.
async function restart() {
  db.close()
  db = openLocalDb(file)
  await signIn()
}

describe('the last import can be undone later, until the next import', () => {
  it('names the last import (file and time), and undoes it after a restart', async () => {
    await commit('Archery', 'campB.txt')
    const last = await handlers.lastImportUndo({ token })
    expect(last.fileName).toBe('campB.txt')
    expect(typeof last.committedAt).toBe('string')
    expect(typeof last.importRunId).toBe('string')
    await restart()
    expect((await handlers.lastImportUndo({ token }))?.importRunId).toBe(last.importRunId)
    const res = await handlers.ingestUndo({ token, importRunId: last.importRunId, client_write_id: randomUUID() })
    expect(res.deleted.length).toBe(1)
    expect(has('Archery')).toBe(false)
  })

  it('after an undo there is nothing left to undo', async () => {
    await commit('Archery', 'campB.txt')
    const last = await handlers.lastImportUndo({ token })
    await handlers.ingestUndo({ token, importRunId: last.importRunId, client_write_id: randomUUID() })
    expect(await handlers.lastImportUndo({ token })).toBeNull()
  })

  it('the next import replaces it: the earlier run is no longer offered or undoable after a restart', async () => {
    await commit('Archery', 'first.txt')
    const first = await handlers.lastImportUndo({ token })
    await commit('Pottery', 'second.txt')
    const second = await handlers.lastImportUndo({ token })
    expect(second.fileName).toBe('second.txt')
    expect(second.importRunId).not.toBe(first.importRunId)
    await restart()
    await expect(async () => handlers.ingestUndo({ token, importRunId: first.importRunId, client_write_id: randomUUID() })).rejects.toThrow(/cannot be undone/)
    expect(has('Archery')).toBe(true)
  })

  // Red Hat 2026-10-13: retiring an import must retire it in memory too, not just the stored row.
  it('in the same session, the next import retires the earlier run', async () => {
    await commit('Archery', 'first.txt')
    const first = await handlers.lastImportUndo({ token })
    await commit('Pottery', 'second.txt')
    await expect(async () => handlers.ingestUndo({ token, importRunId: first.importRunId, client_write_id: randomUUID() })).rejects.toThrow(/cannot be undone/)
    expect(has('Archery')).toBe(true)
  })

  it('in the same session, an import without undo (e.g. Replace) retires the earlier run', async () => {
    await commit('Archery', 'first.txt')
    const first = await handlers.lastImportUndo({ token })
    await handlers.ingestCommit({ token, approved: { activities: ['Pottery'] } })
    expect(await handlers.lastImportUndo({ token })).toBeNull()
    await expect(async () => handlers.ingestUndo({ token, importRunId: first.importRunId, client_write_id: randomUUID() })).rejects.toThrow(/cannot be undone/)
    expect(has('Archery')).toBe(true)
  })

  // Red Hat 2026-10-13: the import has already landed when its undo is stored; a failure to store the
  // undo must not report the import as failed (the director would retry and import twice).
  it('an import still succeeds when its undo cannot be stored', async () => {
    db.exec('DROP TABLE last_import_undo')
    await commit('Archery', 'campB.txt')
    expect(has('Archery')).toBe(true)
  })
})
