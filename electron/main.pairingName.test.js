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
