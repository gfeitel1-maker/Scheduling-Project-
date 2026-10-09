// @vitest-environment node
//
// Pair again, the main-process half: the persistent node stops before the temporary join node
// starts (one peer identity, never live twice) and comes back on any exit that is not a completed
// join; the director sees a returning device marked as one; turning it down does not remove it.
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
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
import { setUserDataDirGetter, resetForTests as resetLiveDocForTests } from './sync/automerge/liveDoc.js'

let db, deviceId, userDataDir

beforeEach(async () => {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shoresh-pairagain-main-'))
  setUserDataDirGetter(() => userDataDir)
  ;({ db } = openTemplatedDb())
  deviceId = getOrCreateDeviceId(db)
  const campId = randomUUID()
  db.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run(campId, 'Camp')
  const key = ensureHostSigningKey(db)
  db.prepare('UPDATE camps SET signing_public_key = ? WHERE id = ?').run(key.public_key, campId)
  db.prepare("INSERT OR IGNORE INTO devices (id, name, pairing_status, authorized_at) VALUES (?, 'This', 'authorized', ?)").run(deviceId, new Date().toISOString())
  const { appendOp } = await import('./ops/operations.js')
  await createUser(db, { camp_id: campId, name: 'Director', pin: '135790', role: 'admin' },
    async (args) => ({ status: 'applied', op: appendOp(db, { ...args, author_user_id: null, device_id: deviceId, parent_op_id: null }) }))
})
afterEach(() => {
  resetLiveDocForTests()
  try { db.close() } catch { /* closed */ }
  fs.rmSync(userDataDir, { recursive: true, force: true })
})
afterAll(() => cleanupTemplatedDbs())

async function signedIn(opts = {}) {
  const handlers = makeHandlers(db, deviceId, opts)
  await handlers.chooseMode({ mode: 'host' })
  const { token } = await handlers.login({ name: 'Director', pin: '135790' })
  return { handlers, token }
}

describe('Pair again in main', () => {
  it('stops the persistent node first, and starts it again when the attempt does not go ahead', async () => {
    const calls = []
    const handlers = makeHandlers(db, deviceId, {
      stopSync: async () => { calls.push('stop') },
      retrySync: () => { calls.push('restart') },
    })
    expect(await handlers.joinStart({ code: 'nope', rejoin: true })).toEqual({ status: 'invalid_code' })
    expect(calls).toEqual(['stop', 'restart'])
  })

  it('a fresh join never stops the persistent node', async () => {
    const calls = []
    const handlers = makeHandlers(db, deviceId, { stopSync: async () => { calls.push('stop') } })
    await handlers.joinStart({ code: 'nope' })
    expect(calls).toEqual([])
  })

  it('lists a returning device as a Pair-again request, beside ordinary ones', async () => {
    const { handlers, token } = await signedIn()
    db.prepare("INSERT INTO devices (id, name, pairing_status, authorized_at) VALUES ('dev-b', 'Laptop B', 'rejoin_pending', ?)").run(new Date().toISOString())
    db.prepare("INSERT INTO devices (id, name, pairing_status) VALUES ('dev-new', 'iPad', 'pending')").run()
    const list = handlers.listPendingPairingRequests({ token })
    expect(list).toEqual(expect.arrayContaining([
      { id: 'dev-b', name: 'Laptop B', rejoin: true },
      { id: 'dev-new', name: 'iPad', rejoin: false },
    ]))
  })

  it('turning down a Pair-again request leaves the device allowed in; it is not removed', async () => {
    const { handlers, token } = await signedIn()
    db.prepare("INSERT INTO devices (id, name, pairing_status, authorized_at) VALUES ('dev-b', 'Laptop B', 'rejoin_pending', ?)").run(new Date().toISOString())
    handlers.denyDevice({ token, deviceId: 'dev-b' })
    const row = db.prepare('SELECT pairing_status, authorized_at, revoked_at FROM devices WHERE id = ?').get('dev-b')
    expect(row.pairing_status).toBe('authorized')
    expect(row.authorized_at).not.toBeNull()
    expect(row.revoked_at).toBeNull()
    expect(handlers.listPendingPairingRequests({ token }).map((d) => d.id)).not.toContain('dev-b')
  })
})
