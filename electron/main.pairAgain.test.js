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
import { mintJoinSecret } from './sync/joinCode.js'

// A syntactically valid PeerId that nothing listens on: joinStart only starts the temporary node.
const NOBODY = '12D3KooWEBb2TChdzoXmNQwrQdqCULbfMdjieGgvWqKWF5CmtwJz'

let db, dbFile, deviceId, userDataDir

beforeEach(async () => {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shoresh-pairagain-main-'))
  setUserDataDirGetter(() => userDataDir)
  ;({ db, file: dbFile } = openTemplatedDb())
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
    db.prepare("INSERT INTO audit_events (device_id, action, occurred_at, outcome) VALUES ('dev-b', 'device.rejoin_request', ?, 'allow')").run(new Date().toISOString())
    db.prepare("INSERT INTO devices (id, name, pairing_status) VALUES ('dev-new', 'iPad', 'pending')").run()
    const list = handlers.listPendingPairingRequests({ token })
    expect(list).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'dev-b', name: 'Laptop B', rejoin: true }),
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

  // Red Hat #844 R1: while a join's temporary node holds this device's peer identity, a retry
  // must not start the persistent node next to it.
  it('retrySync during a Pair-again attempt starts nothing; the attempt\'s own exit restarts sync once', async () => {
    const calls = []
    const handlers = makeHandlers(db, deviceId, {
      dbPath: dbFile, userDataPath: userDataDir,
      stopSync: async () => { calls.push('stop') },
      retrySync: () => { calls.push('restart') },
    })
    expect(await handlers.joinStart({ code: mintJoinSecret(), rejoin: true, knownHost: NOBODY })).toEqual({ status: 'started' })
    expect(handlers.retrySync()).toEqual({ ok: false, reason: 'pairing_in_progress' })
    expect(handlers.getSyncStatus().pairingAgain).toBe(true)
    expect(calls).toEqual(['stop'])
    await handlers.joinCancel()
    expect(calls).toEqual(['stop', 'restart'])
    expect(handlers.getSyncStatus().pairingAgain).toBeUndefined()
  })

  // R2: the renderer going away mid-attempt (reload, crash) stops the join and restarts sync.
  it('the renderer going away mid-attempt stops the join and restarts sync', async () => {
    const calls = []
    const handlers = makeHandlers(db, deviceId, { stopSync: async () => { calls.push('stop') }, retrySync: () => { calls.push('restart') } })
    await handlers.joinStart({ code: mintJoinSecret(), rejoin: true, knownHost: NOBODY })
    await handlers.onRendererGone()
    expect(calls).toEqual(['stop', 'restart'])
    await handlers.onRendererGone()
    expect(calls).toEqual(['stop', 'restart'])
  })

  // R2: a failure while stopping the node still restarts sync, and is reported.
  it('a failure stopping the persistent node restarts sync and surfaces the error', async () => {
    const calls = []
    const handlers = makeHandlers(db, deviceId, {
      stopSync: async () => { calls.push('stop'); throw new Error('stop failed') },
      retrySync: () => { calls.push('restart') },
    })
    await expect(handlers.joinStart({ code: mintJoinSecret(), rejoin: true })).rejects.toThrow('stop failed')
    expect(calls).toEqual(['stop', 'restart'])
  })

  // Security #844 S3: an approval never silently undoes a revoke.
  it('approveDevice refuses a revoked device, by local revoke or by the authority log', async () => {
    const { handlers, token } = await signedIn()
    db.prepare("INSERT INTO devices (id, name, pairing_status, authorized_at, revoked_at) VALUES ('dev-r', 'R', 'revoked', ?, ?)").run(new Date().toISOString(), new Date().toISOString())
    db.prepare("INSERT INTO devices (id, name, pairing_status, authorized_at) VALUES ('dev-q', 'Q', 'rejoin_pending', ?)").run(new Date().toISOString())
    db.prepare("INSERT INTO authority_cache (device_id, status, updated_at) VALUES ('dev-q', 'revoked', ?)").run(new Date().toISOString())
    await expect(handlers.approveDevice({ token, deviceId: 'dev-r' })).rejects.toThrow(/removed from the camp/)
    await expect(handlers.approveDevice({ token, deviceId: 'dev-q' })).rejects.toThrow(/removed from the camp/)
    expect(db.prepare('SELECT revoked_at FROM devices WHERE id = ?').get('dev-r').revoked_at).not.toBeNull()
  })

  // R5: a Pair-again request lapses after a day, and the list shows how old it is.
  it('a Pair-again request shows its age, and lapses after 24 hours', async () => {
    const { handlers, token } = await signedIn()
    const at = (msAgo) => new Date(Date.now() - msAgo).toISOString()
    for (const [id, ago] of [['dev-fresh', 2 * 3600_000], ['dev-old', 25 * 3600_000]]) {
      db.prepare("INSERT INTO devices (id, name, pairing_status, authorized_at) VALUES (?, ?, 'rejoin_pending', ?)").run(id, id, at(ago))
      db.prepare("INSERT INTO audit_events (device_id, action, occurred_at, outcome) VALUES (?, 'device.rejoin_request', ?, 'allow')").run(id, at(ago))
    }
    const list = handlers.listPendingPairingRequests({ token })
    expect(list).toEqual([expect.objectContaining({ id: 'dev-fresh', rejoin: true })])
    expect(Date.now() - Date.parse(list[0].requestedAt)).toBeGreaterThan(2 * 3600_000 - 60_000)
    expect(db.prepare('SELECT pairing_status FROM devices WHERE id = ?').get('dev-old').pairing_status).toBe('authorized')
  })

  it('approving a lapsed Pair-again request is refused and the device is left as it was', async () => {
    const { handlers, token } = await signedIn()
    const old = new Date(Date.now() - 25 * 3600_000).toISOString()
    db.prepare("INSERT INTO devices (id, name, pairing_status, authorized_at) VALUES ('dev-old', 'Old', 'rejoin_pending', ?)").run(old)
    db.prepare("INSERT INTO audit_events (device_id, action, occurred_at, outcome) VALUES ('dev-old', 'device.rejoin_request', ?, 'allow')").run(old)
    await expect(handlers.approveDevice({ token, deviceId: 'dev-old' })).rejects.toThrow(/more than a day old/)
    expect(db.prepare('SELECT pairing_status FROM devices WHERE id = ?').get('dev-old').pairing_status).toBe('authorized')
  })

  // R6a: handlers replaced on a db swap must not leave the reachability timer behind.
  it('dispose stops the reachability timer, so replaced handlers push nothing later', () => {
    vi.useFakeTimers()
    try {
      db.prepare("INSERT INTO devices (id, name, pairing_status, authorized_at) VALUES ('dev-b', 'B', 'authorized', ?)").run(new Date().toISOString())
      const node = { getPeers: () => [], isPeerAuthenticated: () => false }
      const make = () => {
        const sends = []
        const handlers = makeHandlers(db, deviceId, { dbPath: dbFile, userDataPath: userDataDir, getAutomergeSyncNode: () => node, getMainWindow: () => ({ webContents: { send: (ch) => sends.push(ch) } }) })
        handlers.getSyncStatus()
        return { handlers, sends }
      }
      const kept = make()
      const replaced = make()
      replaced.handlers.dispose()
      vi.advanceTimersByTime(7 * 3600_000)
      expect(kept.sends).toEqual(['shoresh:sync-status-changed'])
      expect(replaced.sends).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })
})
