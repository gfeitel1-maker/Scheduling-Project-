// @vitest-environment node
//
// The host-handoff IPC surface (docs/adr/2026-10-09-host-succession-simple.md): every call goes
// through authorize() with `devices.approve` (status: `devices.read`), host actions gate on key
// presence rather than mode, and a device that holds the camp's key runs as host after a relaunch
// whatever mode the renderer remembered. Real handlers, real authorize(); the sync node is a
// recording stand-in because the node itself is exercised over real libp2p in
// electron/sync/automerge/hostHandoffWire.test.js.
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

let db, deviceId, campId, calls, node

function localTestWrite() {
  return async (args) => {
    const { appendOp } = await import('./ops/operations.js')
    return { status: 'applied', op: appendOp(db, { ...args, author_user_id: null, device_id: deviceId, parent_op_id: null }) }
  }
}

async function session(role, mode = 'host', { keyless = false } = {}) {
  const name = `Handoff-${role}`
  await createUser(db, { camp_id: campId, name, pin: '246810', role }, localTestWrite())
  if (keyless) {
    db.prepare('DELETE FROM host_signing_key').run()
    db.prepare('UPDATE devices SET device_secret_identifier = ? WHERE id = ?').run('ab'.repeat(32), deviceId)
  }
  const handlers = makeHandlers(db, deviceId, { getAutomergeSyncNode: () => node, userDataPath: os.tmpdir() })
  await handlers.chooseMode({ mode })
  const { token } = await handlers.login({ name, pin: '246810' })
  return { handlers, token }
}

beforeEach(() => {
  db = openTemplatedDb().db
  deviceId = getOrCreateDeviceId(db)
  campId = randomUUID()
  db.prepare('INSERT INTO camps (id, name, signing_secret) VALUES (?, ?, ?)').run(campId, 'Handoff Camp', 'a'.repeat(64))
  ensureHostSigningKey(db)
  db.prepare("INSERT OR IGNORE INTO devices (id, name, pairing_status) VALUES (?, ?, 'pending')").run(deviceId, deviceId)
  db.prepare("UPDATE devices SET authorized_at = ?, pairing_status = 'authorized' WHERE id = ?").run(new Date().toISOString(), deviceId)
  calls = []
  node = {
    handoff: {
      start: async (id) => { calls.push(['start', id]); return { ok: true } },
      accept: async () => { calls.push(['accept']); return { ok: true } },
      decline: () => { calls.push(['decline']) },
      status: () => ({ handoff: null, lastResult: null, isHost: true, eligibleDeviceIds: ['dev-x'] }),
    },
    getPeers: () => [],
    isPeerAuthenticated: () => false,
    setAuthToken: () => {},
  }
})
afterEach(() => { try { db.close() } catch { /* already closed */ } })
afterAll(() => cleanupTemplatedDbs())

describe('handoff IPC goes through authorize()', () => {
  it('an admin on a trusted device starts, accepts, declines and reads status', async () => {
    const { handlers, token } = await session('admin')
    expect(await handlers.handoffStart({ token, deviceId: 'dev-x' })).toEqual({ ok: true })
    expect(await handlers.handoffAccept({ token })).toEqual({ ok: true })
    handlers.handoffDecline({ token })
    expect(calls).toEqual([['start', 'dev-x'], ['accept'], ['decline']])
    expect(handlers.handoffStatus({ token })).toMatchObject({ isHost: true, eligibleDeviceIds: ['dev-x'] })
  })

  it('status names this computer, the camp and the other computer, so the confirm can speak in names', async () => {
    db.prepare("INSERT INTO devices (id, name, pairing_status) VALUES ('dev-peer', 'Office iMac', 'authorized')").run()
    db.prepare('UPDATE devices SET name = ? WHERE id = ?').run('Front Desk iPad', deviceId)
    node.handoff.status = () => ({ handoff: { role: 'taker', peerDeviceId: 'dev-peer', state: 'offered' }, lastResult: null, isHost: false, eligibleDeviceIds: [] })
    const { handlers, token } = await session('admin')
    expect(handlers.handoffStatus({ token })).toMatchObject({
      selfName: 'Front Desk iPad', campName: 'Handoff Camp', peerName: 'Office iMac',
      handoff: { role: 'taker', peerDeviceId: 'dev-peer', state: 'offered' },
    })
  })

  it('a staff user is refused every mutating call, and no node method runs', async () => {
    const { handlers, token } = await session('staff')
    await expect(handlers.handoffStart({ token, deviceId: 'dev-x' })).rejects.toThrow(/admin role required|forbidden|not permitted/i)
    await expect(handlers.handoffAccept({ token })).rejects.toThrow(/admin role required|forbidden|not permitted/i)
    expect(() => handlers.handoffDecline({ token })).toThrow(/admin role required|forbidden|not permitted/i)
    expect(calls).toEqual([])
  })

  it('a missing token is refused, and a revoked device is refused even with an admin role', async () => {
    const { handlers, token } = await session('admin')
    await expect(handlers.handoffStart({ deviceId: 'dev-x' })).rejects.toThrow(/token is required/)
    db.prepare('UPDATE devices SET revoked_at = ? WHERE id = ?').run(new Date().toISOString(), deviceId)
    await expect(handlers.handoffStart({ token, deviceId: 'dev-x' })).rejects.toThrow(/invalid session|revoked/i)
    expect(calls).toEqual([])
  })

  it('without a running sync node, start answers sync_not_running and status reports no eligible device', async () => {
    node = null
    const { handlers, token } = await session('admin')
    expect(await handlers.handoffStart({ token, deviceId: 'dev-x' })).toEqual({ ok: false, reason: 'sync_not_running' })
    expect(handlers.handoffStatus({ token })).toEqual({ handoff: null, lastResult: null, isHost: true, eligibleDeviceIds: [] })
  })
})

describe('role follows key presence', () => {
  it('a device that holds the camp key runs as host after relaunch even if the renderer remembered client', async () => {
    const { handlers, token } = await session('admin', 'client')
    expect(handlers.getSyncStatus().mode).toBe('host')
    expect(handlers.getJoinCode({ token })).toMatchObject({ campName: 'Handoff Camp' })
    expect(handlers.setJoinWindow({ token, open: true })).toMatchObject({ open: true })
  })

  it('a device without the key stays a client and cannot show the camp code', async () => {
    const { handlers, token } = await session('admin', 'client', { keyless: true })
    expect(handlers.getSyncStatus().mode).toBe('client')
    expect(() => handlers.getJoinCode({ token })).toThrow(/device this camp was set up on|set up/i)
  })

  it('the old host refuses getJoinCode and setJoinWindow the moment its key is gone, before any relaunch', async () => {
    const { handlers, token } = await session('admin', 'host')
    expect(handlers.getJoinCode({ token })).toBeDefined()
    db.prepare('DELETE FROM host_signing_key').run() // step 5 committed; the process has not relaunched yet
    expect(() => handlers.getJoinCode({ token })).toThrow(/set up/i)
    expect(() => handlers.setJoinWindow({ token, open: true })).toThrow(/set up/i)
  })
})
