// @vitest-environment node
// Grant / list / revoke are authorize()-gated director mutations that write audit_events.
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'
import os from 'node:os'

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => os.tmpdir()), whenReady: vi.fn(() => Promise.resolve()), on: vi.fn() },
  BrowserWindow: vi.fn(),
  ipcMain: { handle: vi.fn() },
  contextBridge: { exposeInMainWorld: vi.fn() },
  ipcRenderer: { invoke: vi.fn(), on: vi.fn() },
  safeStorage: { isEncryptionAvailable: () => false },
}))

import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { openTemplatedDb, cleanupTemplatedDbs } from '../db/testDbTemplate.js'
import { getOrCreateDeviceId } from '../db/localDb.js'
import { createUser, ensureHostSigningKey } from './localAuth.js'
import { makeHandlers } from '../main.js'
import { checkToolAuthorization } from './toolAuthorizations.js'
import { appendOp } from '../ops/operations.js'
import { setUserDataDirGetter, resetForTests as resetLiveDocForTests } from '../sync/automerge/liveDoc.js'

const fakeSafeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(Buffer.from(s, 'utf8').map((b) => b ^ 0x5a)),
  decryptString: (b) => Buffer.from(Buffer.from(b).map((x) => x ^ 0x5a)).toString('utf8'),
}

let db, dir, handlers, adminToken, staffToken, deviceId
beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'toolauth-h-'))
  setUserDataDirGetter(() => dir)
  db = openTemplatedDb().db
  deviceId = getOrCreateDeviceId(db)
  const campId = randomUUID()
  db.prepare('INSERT INTO camps (id, name, signing_secret) VALUES (?, ?, ?)').run(campId, 'C', 'a'.repeat(64))
  const hostKey = ensureHostSigningKey(db)
  db.prepare('UPDATE camps SET signing_public_key = ? WHERE id = ?').run(hostKey.public_key, campId)
  db.prepare("INSERT OR IGNORE INTO devices (id, name, pairing_status, authorized_at) VALUES (?, ?, 'authorized', ?)").run(deviceId, 'D', new Date().toISOString())
  const write = async (args) => ({ status: 'applied', op: appendOp(db, { ...args, author_user_id: null, device_id: deviceId, parent_op_id: null }) })
  await createUser(db, { camp_id: campId, name: 'Dir', pin: '135790', role: 'admin' }, write)
  await createUser(db, { camp_id: campId, name: 'Staff', pin: '246813', role: 'staff' }, write)
  handlers = makeHandlers(db, deviceId, { userDataPath: dir, safeStorage: fakeSafeStorage, getAutomergeSyncNode: () => null })
  await handlers.chooseMode({ mode: 'host' })
  adminToken = (await handlers.login({ name: 'Dir', pin: '135790' })).token
  staffToken = (await handlers.login({ name: 'Staff', pin: '246813' })).token
})
afterEach(() => { resetLiveDocForTests(); try { db.close() } catch { /* closed */ } fs.rmSync(dir, { recursive: true, force: true }) })
afterAll(() => { cleanupTemplatedDbs() })

const audit = (action) => db.prepare('SELECT * FROM audit_events WHERE action = ?').all(action)

describe('tool authorization IPC handlers', () => {
  it('director grants: secret shown once, list shows record without secret/hash, audit row written', () => {
    const res = handlers.grantToolAuthorization({ token: adminToken, label: 'MCP', scope: 'read-write' })
    expect(res.secret).toBeTruthy()
    const list = handlers.listToolAuthorizations({ token: adminToken })
    expect(list).toHaveLength(1)
    expect(JSON.stringify(list)).not.toContain(res.secret)
    expect(JSON.stringify(list)).not.toContain('secret_hash')
    expect(audit('tool_authorization.grant')).toHaveLength(1)
    expect(checkToolAuthorization(dir, fakeSafeStorage, res.secret).scope).toBe('read-write')
  })
  it('revoke makes the tool get the named refusal and writes an audit row', () => {
    const { secret, authorization } = handlers.grantToolAuthorization({ token: adminToken, label: 'MCP', scope: 'read' })
    handlers.revokeToolAuthorization({ token: adminToken, id: authorization.id })
    expect(() => checkToolAuthorization(dir, fakeSafeStorage, secret)).toThrow(/revoked/i)
    expect(audit('tool_authorization.revoke')).toHaveLength(1)
  })
  it('non-director (staff) cannot grant, list or revoke; nothing is stored', () => {
    expect(() => handlers.grantToolAuthorization({ token: staffToken, label: 'x', scope: 'read' })).toThrow(/admin role required/)
    expect(() => handlers.listToolAuthorizations({ token: staffToken })).toThrow(/admin role required/)
    expect(() => handlers.revokeToolAuthorization({ token: staffToken, id: 'x' })).toThrow(/admin role required/)
    expect(fs.existsSync(path.join(dir, 'tool-authorizations.enc'))).toBe(false)
  })
  it('use-refusals queued by the key-release path land in audit_events on the next list', () => {
    expect(() => checkToolAuthorization(dir, fakeSafeStorage, 'bogus.secret')).toThrow()
    handlers.listToolAuthorizations({ token: adminToken })
    const rows = audit('tool_authorization.use')
    expect(rows).toHaveLength(1)
    expect(rows[0].outcome).toBe('deny')
    expect(rows[0].reason).toBe('tool-not-authorized')
  })
  it('grant never exists without its audit row: a failing audit write leaves no grant', () => {
    db.exec('DROP TABLE audit_events')
    expect(() => handlers.grantToolAuthorization({ token: adminToken, label: 'MCP', scope: 'read' })).toThrow()
    expect(handlers.listToolAuthorizations({ token: adminToken })).toEqual([])
  })
  it('a sealing failure leaves no grant audit row and no grant', () => {
    const spy = vi.spyOn(fakeSafeStorage, 'encryptString').mockImplementation(() => { throw new Error('keychain down') })
    try {
      expect(() => handlers.grantToolAuthorization({ token: adminToken, label: 'MCP', scope: 'read' })).toThrow(/keychain down/)
    } finally { spy.mockRestore() }
    expect(audit('tool_authorization.grant')).toHaveLength(0)
    expect(handlers.listToolAuthorizations({ token: adminToken })).toEqual([])
  })
  it('landed deny audit rows carry count, first_at and last_at', () => {
    for (let i = 0; i < 3; i++) expect(() => checkToolAuthorization(dir, fakeSafeStorage, 'bogus.secret')).toThrow()
    handlers.listToolAuthorizations({ token: adminToken })
    const rows = audit('tool_authorization.use')
    expect(rows).toHaveLength(1)
    expect(JSON.parse(rows[0].metadata)).toMatchObject({ count: 3, first_at: expect.any(String), last_at: expect.any(String) })
  })
})
