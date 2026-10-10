// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => os.tmpdir()), whenReady: vi.fn(() => Promise.resolve()), on: vi.fn() },
  BrowserWindow: vi.fn(),
  ipcMain: { handle: vi.fn() },
  contextBridge: { exposeInMainWorld: vi.fn() },
  ipcRenderer: { invoke: vi.fn(), on: vi.fn() },
}))
const startJoinSession = vi.hoisted(() => vi.fn(async () => ({ status: 'invalid_code' })))
vi.mock('./sync/automerge/joinSession.js', () => ({ startJoinSession }))

import { openTemplatedDb, cleanupTemplatedDbs } from './db/testDbTemplate.js'
import { getOrCreateDeviceId } from './db/localDb.js'
import { makeHandlers, ensureDeviceRow } from './main.js'
import { evaluatePairingRequest } from './auth/connectionAuth.js'
import { setUserDataDirGetter, resetForTests as resetLiveDocForTests } from './sync/automerge/liveDoc.js'

let db, deviceId, userDataDir
beforeEach(() => {
  startJoinSession.mockClear()
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shoresh-pairname-'))
  setUserDataDirGetter(() => userDataDir)
  ;({ db } = openTemplatedDb())
  deviceId = getOrCreateDeviceId(db)
  ensureDeviceRow(db, deviceId)
})
afterEach(() => {
  resetLiveDocForTests()
  try { db.close() } catch { /* closed */ }
  fs.rmSync(userDataDir, { recursive: true, force: true })
})
afterAll(() => cleanupTemplatedDbs())

describe('the name a pairing request carries', () => {
  it('is Device <first 4 of id> while the row still holds the default, never the hostname', async () => {
    await makeHandlers(db, deviceId).joinStart({ code: 'x' })
    const sent = startJoinSession.mock.calls[0][0].deviceName
    expect(sent).toBe(`Device ${deviceId.slice(0, 4)}`)
    expect(sent).not.toBe(os.hostname())
  })

  it('is the director-chosen name once the device has been renamed', async () => {
    db.prepare('UPDATE devices SET name = ? WHERE id = ?').run('Camp office', deviceId)
    await makeHandlers(db, deviceId).joinStart({ code: 'x' })
    expect(startJoinSession.mock.calls[0][0].deviceName).toBe('Camp office')
  })
})

describe('Security follow-ups (#886)', () => {
  it('a row seeded with the hostname by an earlier version is reset to the default, so it is never sent', async () => {
    db.prepare('UPDATE devices SET name = ? WHERE id = ?').run(os.hostname(), deviceId)
    ensureDeviceRow(db, deviceId)
    expect(db.prepare('SELECT name FROM devices WHERE id = ?').get(deviceId).name).toBe('This computer')
    await makeHandlers(db, deviceId).joinStart({ code: 'x' })
    expect(startJoinSession.mock.calls[0][0].deviceName).not.toBe(os.hostname())
  })

  it('a name the director chose is not reset', () => {
    db.prepare('UPDATE devices SET name = ? WHERE id = ?').run('Camp office', deviceId)
    ensureDeviceRow(db, deviceId)
    expect(db.prepare('SELECT name FROM devices WHERE id = ?').get(deviceId).name).toBe('Camp office')
  })

  it('a hostile peer pairing name is stripped and capped when the approver stores it', () => {
    const peer = 'peer-' + 'z'.repeat(8)
    const res = evaluatePairingRequest(db, { device_id: peer, device_name: "Director's iPad‮" + 'q'.repeat(300) })
    expect(res.ok).toBe(true)
    const stored = db.prepare('SELECT name FROM devices WHERE id = ?').get(peer).name
    expect(stored).not.toMatch(/[‪-‮]/)
    expect(stored.length).toBeLessThanOrEqual(40)
  })
})
