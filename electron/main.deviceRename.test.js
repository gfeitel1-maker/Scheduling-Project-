// @vitest-environment node
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
import { makeHandlers, ensureDeviceRow } from './main.js'
import { setUserDataDirGetter, resetForTests as resetLiveDocForTests } from './sync/automerge/liveDoc.js'

let db, deviceId, userDataDir, campId

beforeEach(async () => {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shoresh-rename-'))
  setUserDataDirGetter(() => userDataDir)
  ;({ db } = openTemplatedDb())
  deviceId = getOrCreateDeviceId(db)
  campId = randomUUID()
  db.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run(campId, 'Camp')
  const key = ensureHostSigningKey(db)
  db.prepare('UPDATE camps SET signing_public_key = ? WHERE id = ?').run(key.public_key, campId)
  ensureDeviceRow(db, deviceId)
  db.prepare('UPDATE devices SET pairing_status = ?, authorized_at = ? WHERE id = ?').run('authorized', new Date().toISOString(), deviceId)
  const { appendOp } = await import('./ops/operations.js')
  const apply = async (args) => ({ status: 'applied', op: appendOp(db, { ...args, author_user_id: null, device_id: deviceId, parent_op_id: null }) })
  await createUser(db, { camp_id: campId, name: 'Director', pin: '135790', role: 'admin' }, apply)
  await createUser(db, { camp_id: campId, name: 'Staffer', pin: '246810', role: 'staff' }, apply)
  db.prepare("INSERT INTO devices (id, name, pairing_status, authorized_at, libp2p_peer_id, device_secret_identifier) VALUES ('dev-b', 'Laptop B', 'authorized', '2026-01-01T00:00:00.000Z', '12D3KooWpeer', 'sekret')").run()
})
afterEach(() => {
  resetLiveDocForTests()
  try { db.close() } catch { /* closed */ }
  fs.rmSync(userDataDir, { recursive: true, force: true })
})
afterAll(() => cleanupTemplatedDbs())

async function loginAs(name, pin) {
  const handlers = makeHandlers(db, deviceId)
  await handlers.chooseMode({ mode: 'host' })
  const { token } = await handlers.login({ name, pin })
  return { handlers, token }
}
const nameOf = (id) => db.prepare('SELECT name FROM devices WHERE id = ?').get(id).name

describe('device default name', () => {
  it('seeds a new device row with a neutral name, not the hostname', () => {
    expect(nameOf(deviceId)).toBe('This computer')
    expect(nameOf(deviceId)).not.toBe(os.hostname())
  })
})

describe('renameDevice', () => {
  it('persists a trimmed name that then appears in the device list', async () => {
    const { handlers, token } = await loginAs('Director', '135790')
    await handlers.renameDevice({ token, deviceId: 'dev-b', name: '  Office laptop ' })
    expect(nameOf('dev-b')).toBe('Office laptop')
    expect(handlers.listDevices({ token }).find((d) => d.id === 'dev-b').name).toBe('Office laptop')
  })

  it('renames this computer too', async () => {
    const { handlers, token } = await loginAs('Director', '135790')
    await handlers.renameDevice({ token, deviceId, name: 'Camp office' })
    expect(nameOf(deviceId)).toBe('Camp office')
  })

  it('refuses a non-director and a missing token', async () => {
    const { handlers, token } = await loginAs('Staffer', '246810')
    expect(() => handlers.renameDevice({ token, deviceId: 'dev-b', name: 'X' })).toThrow()
    expect(() => handlers.renameDevice({ deviceId: 'dev-b', name: 'X' })).toThrow(/token/)
    expect(nameOf('dev-b')).toBe('Laptop B')
  })

  it('rejects empty and overlong names with a readable error', async () => {
    const { handlers, token } = await loginAs('Director', '135790')
    expect(() => handlers.renameDevice({ token, deviceId: 'dev-b', name: '   ' })).toThrow(/empty/)
    expect(() => handlers.renameDevice({ token, deviceId: 'dev-b', name: 'x'.repeat(41) })).toThrow(/40/)
    expect(nameOf('dev-b')).toBe('Laptop B')
  })

  it('rejects an unknown device', async () => {
    const { handlers, token } = await loginAs('Director', '135790')
    expect(() => handlers.renameDevice({ token, deviceId: 'nope', name: 'X' })).toThrow(/not found/)
  })

  it('leaves identity and trust fields untouched', async () => {
    const { handlers, token } = await loginAs('Director', '135790')
    const trust = 'id, authorized_at, authorized_by_user_id, revoked_at, revoked_by_user_id, revocation_reason, device_secret_identifier, pairing_status, libp2p_peer_id'
    const before = db.prepare(`SELECT ${trust} FROM devices WHERE id = 'dev-b'`).get()
    await handlers.renameDevice({ token, deviceId: 'dev-b', name: 'Renamed' })
    expect(db.prepare(`SELECT ${trust} FROM devices WHERE id = 'dev-b'`).get()).toEqual(before)
  })
})
