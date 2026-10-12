// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'
import os from 'node:os'
import { randomUUID, createPrivateKey, sign as edSign } from 'node:crypto'

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
import { makeHandlers, ensureDeviceRow, setAtRestDisableRunner } from './main.js'
import { PERMISSIONS } from './auth/permissions.js'
import { DISABLE_PHRASE } from './db/disableAtRestEncryption.js'
import { resetForTests as resetLiveDocForTests } from './sync/automerge/liveDoc.js'

const ACTION = 'security.disable_at_rest_encryption'
let db, deviceId, runner

beforeEach(async () => {
  ;({ db } = openTemplatedDb())
  deviceId = getOrCreateDeviceId(db)
  const campId = randomUUID()
  db.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run(campId, 'Camp')
  const key = ensureHostSigningKey(db)
  db.prepare('UPDATE camps SET signing_public_key = ? WHERE id = ?').run(key.public_key, campId)
  ensureDeviceRow(db, deviceId)
  db.prepare('UPDATE devices SET pairing_status = ?, authorized_at = ? WHERE id = ?').run('authorized', new Date().toISOString(), deviceId)
  const { appendOp } = await import('./ops/operations.js')
  const apply = async (args) => ({ status: 'applied', op: appendOp(db, { ...args, author_user_id: null, device_id: deviceId, parent_op_id: null }) })
  await createUser(db, { camp_id: campId, name: 'Director', pin: '135790', role: 'admin' }, apply)
  await createUser(db, { camp_id: campId, name: 'Staffer', pin: '246810', role: 'staff' }, apply)
  runner = vi.fn(async () => ({ ok: true, restarting: true }))
  setAtRestDisableRunner(runner)
})
afterEach(() => {
  setAtRestDisableRunner(null)
  resetLiveDocForTests()
  try { db.close() } catch { /* closed */ }
})
afterAll(() => cleanupTemplatedDbs())

async function loginAs(name, pin) {
  const handlers = makeHandlers(db, deviceId)
  await handlers.chooseMode({ mode: 'host' })
  const { token } = await handlers.login({ name, pin })
  return { handlers, token }
}
const auditRows = () => db.prepare('SELECT outcome, reason FROM audit_events WHERE action = ?').all(ACTION)

describe('disableAtRestEncryption handler', () => {
  it('is admin-only by default-deny: no staff grant exists', () => {
    expect(PERMISSIONS.staff).not.toContain(ACTION)
    expect(PERMISSIONS.admin).toContain('*')
  })

  it('refuses a staff session and never runs the disable', async () => {
    const { handlers, token } = await loginAs('Staffer', '246810')
    await expect(handlers.disableAtRestEncryption({ token, phrase: DISABLE_PHRASE })).rejects.toThrow(/admin role required/)
    expect(runner).not.toHaveBeenCalled()
    expect(auditRows()).toEqual([{ outcome: 'deny', reason: 'forbidden' }])
  })

  it('refuses a missing or forged token', async () => {
    const { handlers, token } = await loginAs('Director', '135790')
    await expect(handlers.disableAtRestEncryption({ phrase: DISABLE_PHRASE })).rejects.toThrow(/token/)
    await expect(handlers.disableAtRestEncryption({ token: token.slice(0, -4) + 'AAAA', phrase: DISABLE_PHRASE })).rejects.toThrow(/invalid session/)
    expect(runner).not.toHaveBeenCalled()
  })

  it('refuses an expired session', async () => {
    const { handlers, token } = await loginAs('Director', '135790')
    const [pB64] = token.split('.')
    const payload = JSON.parse(Buffer.from(pB64, 'base64url').toString('utf8'))
    payload.exp = Date.now() - 1000
    const hostKey = db.prepare('SELECT private_key FROM host_signing_key WHERE id = 1').get()
    const b64 = Buffer.from(JSON.stringify(payload)).toString('base64url')
    const sig = edSign(null, Buffer.from(b64), createPrivateKey({ key: Buffer.from(hostKey.private_key, 'hex'), format: 'der', type: 'pkcs8' })).toString('base64url')
    await expect(handlers.disableAtRestEncryption({ token: `${b64}.${sig}`, phrase: DISABLE_PHRASE })).rejects.toThrow(/invalid session/)
    expect(runner).not.toHaveBeenCalled()
  })

  it('refuses once this device is revoked, re-checked on the call', async () => {
    const { handlers, token } = await loginAs('Director', '135790')
    db.prepare('UPDATE devices SET revoked_at = ? WHERE id = ?').run(new Date().toISOString(), deviceId)
    await expect(handlers.disableAtRestEncryption({ token, phrase: DISABLE_PHRASE })).rejects.toThrow(/invalid session/)
    expect(runner).not.toHaveBeenCalled()
  })

  it('refuses a wrong or missing confirmation phrase before running anything', async () => {
    const { handlers, token } = await loginAs('Director', '135790')
    for (const phrase of [undefined, '', 'disable encryption', 'DISABLE ENCRYPTION ', 'yes']) {
      expect(await handlers.disableAtRestEncryption({ token, phrase })).toEqual({ ok: false, error: 'confirmation_mismatch' })
    }
    expect(runner).not.toHaveBeenCalled()
  })

  it('runs the disable for an admin with the exact phrase and records an audit event', async () => {
    const { handlers, token } = await loginAs('Director', '135790')
    expect(await handlers.disableAtRestEncryption({ token, phrase: DISABLE_PHRASE })).toEqual({ ok: true, restarting: true })
    expect(runner).toHaveBeenCalledTimes(1)
    expect(auditRows()).toEqual([{ outcome: 'allow', reason: null }])
  })

  it('surfaces a failed disable as an error result, never as success', async () => {
    runner.mockResolvedValue({ ok: false, error: 'rekey_failed', message: 'x', restarting: true })
    const { handlers, token } = await loginAs('Director', '135790')
    expect((await handlers.disableAtRestEncryption({ token, phrase: DISABLE_PHRASE })).ok).toBe(false)
  })

  it('a second call while one is running is refused and never starts a second disable', async () => {
    let release
    runner.mockImplementation(() => new Promise((r) => { release = () => r({ ok: true, restarting: true }) }))
    const { handlers, token } = await loginAs('Director', '135790')
    const first = handlers.disableAtRestEncryption({ token, phrase: DISABLE_PHRASE })
    await new Promise((r) => setTimeout(r, 0))
    expect(await handlers.disableAtRestEncryption({ token, phrase: DISABLE_PHRASE })).toEqual({ ok: false, error: 'in_progress' })
    release()
    expect((await first).ok).toBe(true)
    expect(runner).toHaveBeenCalledTimes(1)
  })

  it('reports unavailable when no runner is wired (never a silent success)', async () => {
    setAtRestDisableRunner(null)
    const { handlers, token } = await loginAs('Director', '135790')
    expect(await handlers.disableAtRestEncryption({ token, phrase: DISABLE_PHRASE })).toEqual({ ok: false, error: 'unavailable' })
  })
})
